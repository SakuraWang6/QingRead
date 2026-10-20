#!/usr/bin/env python3
"""Install QingRead's user LaunchAgent; never run this module during tests.

Only the allowlisted project files and the existing device app are copied. Apple
Account authentication remains in Xcode; no credential or keychain is exported.
"""
from __future__ import annotations

import argparse
import contextlib
import datetime as dt
import fcntl
import os
from pathlib import Path
import plistlib
import shutil
import subprocess
import sys
import tempfile
import uuid
from typing import Optional, Sequence


LABEL = "app.qingread.refresh"
REPO = Path(__file__).resolve().parent.parent
APP_PATH = Path(".build/device/Build/Products/Debug-iphoneos/QingRead.app")
REQUIRED_PATHS = (
    Path("App"), Path("Sources"), Path("Tests/ReadingCoreTests"), Path("QingRead.xcodeproj"),
    Path("Config/App.xcconfig"), Path("Config/Info.plist"),
    Path("Config/local.xcconfig"), Path("Package.swift"),
    Path("scripts/refresh-device.py"), APP_PATH,
)
OPTIONAL_PATHS = (Path("Package.resolved"),)
IGNORED_NAMES = {".git", ".DS_Store", "xcuserdata", "__pycache__"}
PRIVATE_SUFFIXES = {".p12", ".p8", ".key", ".pem"}


class InstallError(Exception):
    """Messages are safe to print: no account or device values."""


def check_path(path: Path, root: Path) -> None:
    """Never follow a copied source or private-runtime path through a symlink."""
    relative = path.relative_to(root)
    current = root
    if current.is_symlink():
        raise InstallError("项目或私有目录不能是符号链接。")
    for component in relative.parts:
        current = current / component
        if current.is_symlink():
            raise InstallError("所需路径包含符号链接；未继续。")


def private_directory(path: Path) -> None:
    if path.is_symlink():
        raise InstallError("私有目录不能是符号链接。")
    path.mkdir(mode=0o700, parents=True, exist_ok=True)
    os.chmod(path, 0o700)


@contextlib.contextmanager
def exclusive_lock(path: Path, root: Path):
    check_path(path, root)
    path.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
    descriptor = os.open(path, os.O_CREAT | os.O_RDWR | os.O_NOFOLLOW, 0o600)
    try:
        try:
            fcntl.flock(descriptor, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            raise InstallError("已有续签或安装操作正在运行，请等它结束后再试。") from None
        yield
    finally:
        os.close(descriptor)


def copy_owned(source: Path, destination: Path) -> None:
    if source.is_symlink():
        raise InstallError("待复制文件包含符号链接；未继续。")
    if source.is_dir():
        destination.mkdir(mode=0o700, parents=True)
        for child in source.iterdir():
            if child.name in IGNORED_NAMES or child.name.endswith(".xcuserstate") or child.suffix in PRIVATE_SUFFIXES:
                continue
            copy_owned(child, destination / child.name)
    elif source.is_file():
        destination.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
        shutil.copy2(source, destination)
    else:
        raise InstallError("缺少所需项目文件或已有设备构建产物；请先完成一次真机构建。")


def prepare_stage(source: Path, runtime: Path):
    for relative in REQUIRED_PATHS:
        check_path(source / relative, source)
        if not (source / relative).exists():
            raise InstallError("缺少所需项目文件、本机签名配置或已有设备构建产物。")
    for name in ("Info.plist", "embedded.mobileprovision"):
        if not (source / APP_PATH / name).is_file():
            raise InstallError("现有设备应用缺少签名基线；请先完成一次真机构建。")
    stage = Path(tempfile.mkdtemp(prefix=".source-staging-", dir=str(runtime)))
    relatives = list(REQUIRED_PATHS)
    relatives.extend(relative for relative in OPTIONAL_PATHS if (source / relative).exists())
    try:
        for relative in relatives:
            check_path(source / relative, source)
            copy_owned(source / relative, stage / relative)
        os.chmod(stage / "Config/local.xcconfig", 0o600)
        return stage, relatives
    except BaseException:
        shutil.rmtree(stage)
        raise


@contextlib.contextmanager
def publish_stage(stage: Path, runtime: Path, relatives):
    """Rename only owned paths, retaining work/signing-backup and lock inodes.

    Each rename is atomic. No refresh may run during the multi-path transaction;
    failures roll back all published paths before the old job can be reloaded.
    """
    previous = stage / ".previous"
    changed = []
    try:
        for relative in relatives:
            target = runtime / relative
            check_path(target, runtime)
            target.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
            saved = previous / relative
            existed = target.exists()
            if existed:
                saved.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
                os.replace(target, saved)
            changed.append((target, saved, existed))
            os.replace(stage / relative, target)
        yield
    except BaseException:
        for target, saved, existed in reversed(changed):
            if target.is_dir():
                shutil.rmtree(target)
            elif target.exists():
                target.unlink()
            if existed:
                os.replace(saved, target)
        raise


def agent_plist(runtime: Path, device: str, developer_dir: str):
    logs = runtime / "work/logs"
    return {
        "Label": LABEL,
        "ProgramArguments": ["/usr/bin/python3", str(runtime / "scripts/refresh-device.py"), "--device", device],
        "WorkingDirectory": str(runtime),
        "RunAtLoad": True,
        "StartInterval": 14400,
        "ProcessType": "Background",
        "Umask": 0o077,
        "EnvironmentVariables": {
            "PATH": "/usr/bin:/bin:/usr/sbin:/sbin",
            "DEVELOPER_DIR": developer_dir,
        },
        "StandardOutPath": str(logs / "refresh.stdout.log"),
        "StandardErrorPath": str(logs / "refresh.stderr.log"),
    }


def write_private_plist(path: Path, value) -> None:
    descriptor, name = tempfile.mkstemp(prefix=".qingread-agent-", dir=str(path.parent))
    try:
        with os.fdopen(descriptor, "wb") as stream:
            plistlib.dump(value, stream)
            stream.flush()
            os.fsync(stream.fileno())
        os.replace(name, path)
    finally:
        with contextlib.suppress(FileNotFoundError):
            os.unlink(name)


def command_status(command: Sequence[str]) -> int:
    try:
        return subprocess.run(list(command), stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
                              timeout=30, check=False).returncode
    except (OSError, subprocess.TimeoutExpired):
        raise InstallError("系统任务命令无法完成；未输出可能含设备信息的原始日志。") from None


def mark_build_directories(runtime: Path) -> None:
    """Mark only the private DerivedData paths which Xcode clean may remove."""
    paths = [runtime / relative for relative in (
        ".build/device", ".build/device/Build", ".build/device/Build/Products",
        ".build/device/Build/Products/Debug-iphoneos",
    )]
    for path in paths:
        check_path(path, runtime)
        if not path.is_dir():
            raise InstallError("私有构建目录不完整；未加载后台任务。")
    try:
        subprocess.run(["/usr/bin/xattr", "-w", "com.apple.xcode.CreatedByBuildSystem", "true"] + [str(path) for path in paths],
                       stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, timeout=10, check=True)
    except (OSError, subprocess.SubprocessError):
        raise InstallError("无法标记私有构建目录，Xcode clean 可能拒绝运行；未加载后台任务。") from None


def bootout_if_loaded(domain: str) -> bool:
    target = domain + "/" + LABEL
    status = command_status(["/bin/launchctl", "print", target])
    if status in (3, 113):  # ESRCH / launchd's service-not-found.
        return False
    if status != 0:
        raise InstallError("无法确认现有后台任务状态；未替换运行文件。")
    if command_status(["/bin/launchctl", "bootout", target]) != 0:
        raise InstallError("无法停止旧后台任务；未加载新任务。")
    return True


def archive_plist(plist: Path, runtime: Path) -> Optional[Path]:
    if not plist.exists():
        return None
    directory = runtime / "work/agent-backup"
    check_path(directory, runtime)
    private_directory(directory)
    name = dt.datetime.now(dt.timezone.utc).strftime("%Y%m%dT%H%M%SZ") + "-" + uuid.uuid4().hex[:8] + ".plist"
    destination = directory / name
    os.replace(plist, destination)
    os.chmod(destination, 0o600)
    return destination


def install(source: Path, home: Path, device: str, developer_dir: str) -> None:
    runtime = home / "Library/Application Support/QingReadRefresh"
    plist = home / "Library/LaunchAgents" / (LABEL + ".plist")
    check_path(runtime, home)
    check_path(plist, home)
    private_directory(runtime)
    plist.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
    domain = "gui/%d" % os.getuid()
    with exclusive_lock(runtime / ".installer.lock", runtime), \
         exclusive_lock(source / ".build/refresh-device.lock", source):
        stage = None
        was_loaded = False
        archived = None
        wrote_plist = False
        try:
            with exclusive_lock(runtime / ".build/refresh-device.lock", runtime):
                stage, relatives = prepare_stage(source, runtime)
                was_loaded = bootout_if_loaded(domain)
                archived = archive_plist(plist, runtime)
                with publish_stage(stage, runtime, relatives):
                    logs = runtime / "work/logs"
                    check_path(logs, runtime)
                    private_directory(logs)
                    for name in ("refresh.stdout.log", "refresh.stderr.log"):
                        path = logs / name
                        check_path(path, runtime)
                        descriptor = os.open(path, os.O_CREAT | os.O_WRONLY | os.O_APPEND | os.O_NOFOLLOW, 0o600)
                        os.close(descriptor)
                        os.chmod(path, 0o600)
                    mark_build_directories(runtime)
                    write_private_plist(plist, agent_plist(runtime, device, developer_dir))
                    wrote_plist = True
            # Release the refresh lock before RunAtLoad starts Python. The
            # installer lock still prevents another installer from publishing.
            if command_status(["/bin/launchctl", "bootstrap", domain, str(plist)]) != 0:
                bootout_if_loaded(domain)
                raise InstallError("后台任务加载失败；新运行副本与旧任务配置备份均已保留，可重新运行安装器。")
        except BaseException:
            # Preserve the previous private plist and only restore the prior load state.
            if archived is not None:
                shutil.copyfile(archived, plist)
                os.chmod(plist, 0o600)
            elif wrote_plist:
                with contextlib.suppress(FileNotFoundError):
                    plist.unlink()
            if was_loaded:
                command_status(["/bin/launchctl", "bootstrap", domain, str(plist)])
            raise
        finally:
            if stage is not None:
                shutil.rmtree(stage)


def uninstall(home: Path) -> None:
    runtime = home / "Library/Application Support/QingReadRefresh"
    plist = home / "Library/LaunchAgents" / (LABEL + ".plist")
    check_path(runtime, home)
    check_path(plist, home)
    private_directory(runtime)
    with exclusive_lock(runtime / ".installer.lock", runtime), \
         exclusive_lock(runtime / ".build/refresh-device.lock", runtime):
        bootout_if_loaded("gui/%d" % os.getuid())
        archive_plist(plist, runtime)


def parse_arguments(argv: Optional[Sequence[str]] = None):
    parser = argparse.ArgumentParser(description="为清读安装每四小时检查一次的用户后台续签任务；源码复制到私有运行目录，避免 Documents 权限弹窗。")
    parser.add_argument("--device", help="已配对设备标识（安装时必填）；仅写入当前用户的私有任务配置")
    parser.add_argument("--uninstall", action="store_true", help="停止并移走任务配置；保留运行目录、应用和所有签名备份")
    result = parser.parse_args(argv)
    if not result.uninstall and (not result.device or result.device != result.device.strip() or
                                 len(result.device) > 256 or any(ord(c) < 32 for c in result.device)):
        parser.error("安装时必须提供有效的 --device；卸载时可省略。")
    return result


def selected_developer_directory() -> str:
    try:
        result = subprocess.run(["/usr/bin/xcode-select", "-p"], stdout=subprocess.PIPE,
                                stderr=subprocess.DEVNULL, timeout=10, check=True)
        path = Path(result.stdout.decode().strip())
        if not path.is_absolute() or not (path / "usr/bin/xcodebuild").is_file():
            raise ValueError()
        return str(path)
    except (OSError, ValueError, UnicodeError, subprocess.SubprocessError):
        raise InstallError("请先在 xcode-select 中选择完整 Xcode，再安装后台任务。") from None


def main(argv: Optional[Sequence[str]] = None) -> int:
    arguments = parse_arguments(argv)
    try:
        if sys.platform != "darwin":
            raise InstallError("此安装器仅支持 macOS。")
        if arguments.uninstall:
            uninstall(Path.home())
            print("后台任务已移除；私有配置与签名备份均保留。")
        else:
            install(REPO, Path.home(), arguments.device, selected_developer_directory())
            print("后台续签任务已安装：每四小时检查一次，剩余三天内才续签；日志位于私有运行目录 work/logs。")
        return 0
    except (InstallError, OSError) as error:
        print(str(error) if isinstance(error, InstallError) else "文件操作失败；请检查目录权限，原有签名备份不会被删除。", file=sys.stderr)
        return 1
    except KeyboardInterrupt:
        print("安装操作已中止。", file=sys.stderr)
        return 130


if __name__ == "__main__":
    sys.exit(main())
