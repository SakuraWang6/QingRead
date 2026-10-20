#!/usr/bin/env python3
"""Refresh only this project's device app using Apple's installed command-line tools.

No scheduling, Apple Account credentials, certificate export, private APIs, or
unrelated profile discovery is involved. Tool output can contain account/device
identifiers, so this program deliberately reports stages rather than raw output.
"""
from __future__ import annotations

import argparse
import contextlib
import datetime as dt
import fcntl
import json
import math
import os
from pathlib import Path
import plistlib
import re
import shutil
import signal
import subprocess
import sys
import tempfile
import time
import uuid
from dataclasses import dataclass
from typing import Callable, Dict, List, Optional, Sequence, Tuple


UTC = dt.timezone.utc
PRODUCT = "QingRead"
REFRESH_WINDOW = dt.timedelta(days=3)
REPO = Path(__file__).resolve().parent.parent


class RefreshError(Exception):
    """A safe-to-log message; never wrap raw tool output or profile values."""


class AlreadyRunning(RefreshError):
    pass


def utc_date(value: object) -> dt.datetime:
    if not isinstance(value, dt.datetime):
        raise RefreshError("描述文件日期格式无效。")
    return value.replace(tzinfo=UTC) if value.tzinfo is None else value.astimezone(UTC)


@dataclass(frozen=True)
class ProfileMetadata:
    identifier: str
    app_identifier: str
    created: dt.datetime
    expires: dt.datetime

    @classmethod
    def from_plist(cls, value: object) -> "ProfileMetadata":
        try:
            if not isinstance(value, dict):
                raise ValueError()
            identifier = str(uuid.UUID(value["UUID"])).upper()
            application = value["Entitlements"]["application-identifier"]
            if not isinstance(application, str) or not application.partition(".")[0] or not application.partition(".")[2] or "*" in application:
                raise ValueError()
            created = utc_date(value["CreationDate"])
            expires = utc_date(value["ExpirationDate"])
            if expires <= created:
                raise ValueError()
            return cls(identifier, application, created, expires)
        except (KeyError, TypeError, ValueError, AttributeError):
            raise RefreshError("描述文件缺少有效的应用标识、UUID 或日期；未操作缓存。") from None

    def matches_bundle(self, bundle_id: str) -> bool:
        return self.app_identifier.partition(".")[2] == bundle_id

    def to_json(self) -> Dict[str, str]:
        return {"uuid": self.identifier, "application": self.app_identifier,
                "created": self.created.isoformat(), "expires": self.expires.isoformat()}

    @classmethod
    def from_json(cls, value: object) -> "ProfileMetadata":
        try:
            if not isinstance(value, dict):
                raise ValueError()
            return cls.from_plist({"UUID": value["uuid"],
                                   "Entitlements": {"application-identifier": value["application"]},
                                   "CreationDate": dt.datetime.fromisoformat(value["created"]),
                                   "ExpirationDate": dt.datetime.fromisoformat(value["expires"])})
        except (KeyError, TypeError, ValueError):
            raise RefreshError("本地续签基线格式无效；未操作缓存。") from None


def needs_refresh(profile: ProfileMetadata, now: dt.datetime, force: bool = False) -> bool:
    return force or profile.expires - utc_date(now) <= REFRESH_WINDOW


def validate_replacement(old: ProfileMetadata, new: ProfileMetadata, bundle_id: str, now: dt.datetime) -> None:
    if not old.matches_bundle(bundle_id) or not new.matches_bundle(bundle_id) or new.app_identifier != old.app_identifier:
        raise RefreshError("新旧应用签名标识不一致，已拒绝安装。")
    if new.created <= old.created or new.expires <= old.expires:
        raise RefreshError("Xcode 未签发创建时间更新且有效期更长的描述文件，已拒绝安装。")
    if new.expires - utc_date(now) <= REFRESH_WINDOW:
        raise RefreshError("新描述文件剩余有效期不足三天，已拒绝安装。")


class ToolRunner:
    def __init__(self, timeout: float):
        self.deadline = time.monotonic() + timeout

    def run(self, command: Sequence[str], label: str, limit: Optional[float] = None) -> bytes:
        remaining = self.deadline - time.monotonic()
        if remaining <= 0:
            raise RefreshError("续签总时间已超时。")
        timeout = min(remaining, limit) if limit is not None else remaining
        try:
            process = subprocess.Popen(list(command), cwd=str(REPO), stdout=subprocess.PIPE,
                                       stderr=subprocess.PIPE, start_new_session=True)
        except OSError:
            raise RefreshError(label + "无法启动，请检查 Xcode 和命令行工具配置。") from None
        try:
            output, _ = process.communicate(timeout=timeout)
        except BaseException as error:
            self._terminate(process)
            if isinstance(error, subprocess.TimeoutExpired):
                raise RefreshError(label + "超时；请检查账号、网络及设备状态。") from None
            raise
        if process.returncode != 0:
            raise RefreshError(label + "失败（退出码 %d）；请在 Xcode 中检查签名、账号或设备连接。" % process.returncode)
        return output

    @staticmethod
    def _terminate(process: subprocess.Popen) -> None:
        if process.poll() is not None:
            return
        with contextlib.suppress(ProcessLookupError):
            os.killpg(process.pid, signal.SIGTERM)
        try:
            process.communicate(timeout=5)
        except subprocess.TimeoutExpired:
            with contextlib.suppress(ProcessLookupError):
                os.killpg(process.pid, signal.SIGKILL)
            process.communicate()


def decode_profile(path: Path, runner: ToolRunner) -> ProfileMetadata:
    if path.is_symlink() or not path.is_file():
        raise RefreshError("缺少应用的描述文件，或文件是符号链接；未继续。")
    output = runner.run(["/usr/bin/security", "cms", "-D", "-i", str(path)], "读取应用描述文件", 20)
    try:
        return ProfileMetadata.from_plist(plistlib.loads(output))
    except (plistlib.InvalidFileException, ValueError, TypeError):
        raise RefreshError("应用描述文件无法解码。") from None


def read_bundle_id(app: Path) -> str:
    try:
        with (app / "Info.plist").open("rb") as stream:
            value = plistlib.load(stream)["CFBundleIdentifier"]
        if not isinstance(value, str) or "." not in value or "*" in value:
            raise ValueError()
        return value
    except (OSError, ValueError, KeyError, TypeError, plistlib.InvalidFileException):
        raise RefreshError("无法读取现有清读应用的 Bundle ID；请先完成一次设备构建。") from None


@dataclass(frozen=True)
class AppVersion:
    version: str
    build: str

    @classmethod
    def from_values(cls, version: object, build: object) -> "AppVersion":
        if not isinstance(version, str) or not version.strip() or not isinstance(build, str) or not build.strip():
            raise RefreshError("无法确认清读的版本号与构建号；未继续自动续签。")
        return cls(version.strip(), build.strip())

    def to_json(self) -> Dict[str, str]:
        return {"version": self.version, "build": self.build}


def read_app_version(app: Path) -> AppVersion:
    try:
        with (app / "Info.plist").open("rb") as stream:
            info = plistlib.load(stream)
        return AppVersion.from_values(info.get("CFBundleShortVersionString"), info.get("CFBundleVersion"))
    except (OSError, ValueError, TypeError, plistlib.InvalidFileException):
        raise RefreshError("无法读取后台清读构建产物的版本；请先更新 runtime 构建产物。") from None


def parse_installed_app(data: bytes, bundle_id: str) -> AppVersion:
    try:
        value = json.loads(data)
        result = value["result"]
        if value["info"]["outcome"] != "success" or not isinstance(result, dict):
            raise ValueError()
        if result.get("matchingBundleIdentifier", bundle_id) != bundle_id:
            raise ValueError()
        apps = result["apps"]
        if not isinstance(apps, list):
            raise ValueError()
        if not apps:
            raise RefreshError("设备上已无清读；不会在后台重新安装用户移除的应用。")
        if len(apps) != 1 or not isinstance(apps[0], dict) or apps[0].get("bundleIdentifier") != bundle_id:
            raise ValueError()
        return AppVersion.from_values(apps[0].get("version"), apps[0].get("bundleVersion"))
    except (ValueError, KeyError, TypeError):
        raise RefreshError("无法准确确认设备上清读的安装版本；未继续自动续签。") from None


def validate_no_downgrade(installed: AppVersion, built: AppVersion) -> None:
    if installed.version != built.version:
        raise RefreshError("手机与后台构建的清读版本不同；请先同步更新 runtime 源码和构建产物，再恢复自动续签。")
    if installed.build == built.build:
        return
    if not re.fullmatch(r"[0-9]+(?:\.[0-9]+)*", installed.build) or not re.fullmatch(r"[0-9]+(?:\.[0-9]+)*", built.build):
        raise RefreshError("无法可靠比较清读构建号；请先同步后台 runtime 版本。")
    current = tuple(int(part) for part in installed.build.split("."))
    candidate = tuple(int(part) for part in built.build.split("."))
    width = max(len(current), len(candidate))
    if current + (0,) * (width - len(current)) > candidate + (0,) * (width - len(candidate)):
        raise RefreshError("手机上的清读构建号更新；已阻止后台旧构建覆盖，请先更新 runtime。")


def query_installed_version(runner: ToolRunner, device: str, bundle_id: str) -> AppVersion:
    data = runner.run(["xcrun", "devicectl", "device", "info", "apps", "--device", device,
                       "--bundle-id", bundle_id, "--timeout", "30", "--json-output", "-"], "清读安装版本检查", 35)
    return parse_installed_app(data, bundle_id)


def cache_directories(home: Path) -> Tuple[Path, Path]:
    return (home / "Library/Developer/Xcode/UserData/Provisioning Profiles",
            home / "Library/MobileDevice/Provisioning Profiles")


@dataclass
class CacheBackup:
    entries: List[Tuple[Path, Path]]

    @classmethod
    def move_owned(cls, metadata: ProfileMetadata, directories: Sequence[Path], destination: Path,
                   read: Callable[[Path], ProfileMetadata]) -> "CacheBackup":
        # Exact UUID paths only: never glob, scan, or decode another app's profiles.
        matches = []
        for number, directory in enumerate(directories):
            candidate = directory / (metadata.identifier + ".mobileprovision")
            if candidate.is_symlink():
                raise RefreshError("匹配的缓存描述文件是符号链接；未操作。")
            if candidate.is_file():
                if read(candidate) != metadata:
                    raise RefreshError("缓存文件与本应用的基线不一致；未操作。")
                matches.append((candidate, destination / ("cache-%d.mobileprovision" % number)))
        if not matches:
            raise RefreshError("找不到本应用基线 UUID 对应的缓存文件；未构建或安装。请先在 Xcode 中检查签名。")
        result = cls([])
        try:
            for source, target in matches:
                shutil.move(str(source), str(target))
                result.entries.append((source, target))
                os.chmod(target, 0o600)
        except BaseException:
            result.restore()
            raise
        return result

    def restore(self) -> Tuple[int, int]:
        restored = skipped = 0
        for original, saved in self.entries:
            if not saved.is_file():
                continue
            temporary = None
            try:
                # Link a separate temporary copy atomically, without replacing
                # a new cache or sharing the backup's inode with future writes.
                descriptor, temporary = tempfile.mkstemp(prefix=".qingread-restore-", dir=str(original.parent))
                with os.fdopen(descriptor, "wb") as stream, saved.open("rb") as source:
                    shutil.copyfileobj(source, stream)
                    stream.flush()
                    os.fsync(stream.fileno())
                os.link(temporary, original)
                restored += 1
            except FileExistsError:
                skipped += 1
            except OSError:
                raise RefreshError("旧缓存恢复失败；安全备份仍保留，请在 Xcode 中检查签名。") from None
            finally:
                if temporary is not None:
                    with contextlib.suppress(FileNotFoundError):
                        os.unlink(temporary)
        return restored, skipped


def write_private_json(path: Path, value: object) -> None:
    path.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
    descriptor, name = tempfile.mkstemp(prefix=".qingread-", dir=str(path.parent))
    try:
        with os.fdopen(descriptor, "w", encoding="utf-8") as stream:
            json.dump(value, stream, ensure_ascii=False, sort_keys=True)
            stream.write("\n")
            stream.flush()
            os.fsync(stream.fileno())
        os.replace(name, path)
    finally:
        with contextlib.suppress(FileNotFoundError):
            os.unlink(name)


@dataclass
class Baseline:
    profile: ProfileMetadata
    bundle_id: str
    embedded_path: Path
    app_version: Optional[AppVersion] = None


def load_baseline(app: Path, state_file: Path, backup_root: Path, runner: ToolRunner) -> Baseline:
    if state_file.exists():
        try:
            with state_file.open(encoding="utf-8") as stream:
                state = json.load(stream)
            if state["version"] != 1 or state["product"] != PRODUCT:
                raise ValueError()
            profile = ProfileMetadata.from_json(state["baseline"])
            saved_version = state.get("app_version")
            app_version = None if saved_version is None else AppVersion.from_values(saved_version["version"], saved_version["build"])
            bundle_id = state["bundle_id"]
            embedded = (backup_root / state["embedded_backup"]).resolve()
            embedded.relative_to(backup_root.resolve())
            if not isinstance(bundle_id, str) or not profile.matches_bundle(bundle_id) or not embedded.is_file():
                raise ValueError()
            if decode_profile(embedded, runner) != profile:
                raise ValueError()
            if app.exists() and read_bundle_id(app) != bundle_id:
                raise RefreshError("设备构建产物与续签基线不是同一应用；未继续。")
            return Baseline(profile, bundle_id, embedded, app_version)
        except (OSError, KeyError, TypeError, ValueError):
            raise RefreshError("本地续签记录损坏，保留现有签名缓存；请先在 Xcode 中检查。") from None
    bundle_id = read_bundle_id(app)
    embedded = app / "embedded.mobileprovision"
    profile = decode_profile(embedded, runner)
    if not profile.matches_bundle(bundle_id):
        raise RefreshError("现有设备应用与内嵌描述文件标识不一致；未继续。")
    return Baseline(profile, bundle_id, embedded, read_app_version(app))


def save_baseline(state_file: Path, backup_root: Path, baseline: Baseline, pending: bool) -> None:
    write_private_json(state_file, {"version": 1, "product": PRODUCT, "pending": pending,
                                    "bundle_id": baseline.bundle_id, "baseline": baseline.profile.to_json(),
                                    "app_version": baseline.app_version.to_json() if baseline.app_version is not None else None,
                                    "embedded_backup": str(baseline.embedded_path.relative_to(backup_root))})


def validate_device_response(data: bytes) -> None:
    try:
        value = json.loads(data)
        if value["info"]["outcome"] != "success" or not isinstance(value.get("result"), dict) or not value["result"]:
            raise ValueError()
    except (ValueError, KeyError, TypeError):
        raise RefreshError("未能确认设备实时连接；未移动签名缓存。") from None


@contextlib.contextmanager
def exclusive_lock(path: Path):
    path.parent.mkdir(parents=True, exist_ok=True)
    descriptor = os.open(path, os.O_CREAT | os.O_RDWR, 0o600)
    try:
        try:
            fcntl.flock(descriptor, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            raise AlreadyRunning("已有续签正在运行，本次跳过。") from None
        yield
    finally:
        os.close(descriptor)


def log(message: str) -> None:
    print("[%s] %s" % (dt.datetime.now(UTC).strftime("%Y-%m-%dT%H:%M:%SZ"), message), flush=True)


def refresh(arguments: argparse.Namespace) -> None:
    derived = Path(arguments.derived_data)
    if not derived.is_absolute():
        derived = REPO / derived
    derived = derived.resolve()
    # Keep the clean action inside the project's ignored build directory.
    try:
        derived.relative_to((REPO / ".build").resolve())
    except ValueError:
        raise RefreshError("--derived-data 必须位于当前仓库的 .build 目录内。") from None
    if derived == (REPO / ".build").resolve():
        raise RefreshError("--derived-data 需要 .build 内的独立子目录。")
    app = (derived / "Build/Products/Debug-iphoneos" / (PRODUCT + ".app")).resolve()
    backup_root = REPO / "work/signing-backup"
    state_file = backup_root / "refresh-state.json"
    runner = ToolRunner(arguments.timeout)
    with exclusive_lock(REPO / ".build/refresh-device.lock"):
        baseline = load_baseline(app, state_file, backup_root, runner)
        now = dt.datetime.now(UTC)
        if not needs_refresh(baseline.profile, now, arguments.force):
            days = max(0, math.floor((baseline.profile.expires - now).total_seconds() / 86400))
            log("当前签名剩余超过三天（约 %d 天），跳过。" % days)
            return
        log("检查设备实时连接。")
        response = runner.run(["xcrun", "devicectl", "device", "info", "lockState", "--device", arguments.device,
                               "--timeout", "30", "--json-output", "-"], "设备连接检查", 35)
        validate_device_response(response)
        built_version = read_app_version(app) if app.exists() else baseline.app_version
        if built_version is None:
            raise RefreshError("清理后的旧基线缺少版本信息；请先更新 runtime 设备构建产物。")
        installed_version = query_installed_version(runner, arguments.device, baseline.bundle_id)
        validate_no_downgrade(installed_version, built_version)
        log("设备已安装版本与后台构建匹配，未发现降级风险。")
        backup_root.mkdir(mode=0o700, parents=True, exist_ok=True)
        transaction = Path(tempfile.mkdtemp(prefix="refresh-", dir=str(backup_root)))
        os.chmod(transaction, 0o700)
        old_embedded = transaction / "embedded-before.mobileprovision"
        shutil.copyfile(baseline.embedded_path, old_embedded)
        os.chmod(old_embedded, 0o600)
        baseline = Baseline(baseline.profile, baseline.bundle_id, old_embedded, installed_version)
        write_private_json(transaction / "metadata-before.json", baseline.profile.to_json())
        save_baseline(state_file, backup_root, baseline, pending=True)
        cache = None
        installed = False
        try:
            cache = CacheBackup.move_owned(baseline.profile, cache_directories(Path.home()), transaction,
                                           lambda path: decode_profile(path, runner))
            log("已可恢复地移走本应用匹配的缓存；开始干净构建。")
            runner.run(["xcodebuild", "-project", str(REPO / (PRODUCT + ".xcodeproj")),
                        "-scheme", PRODUCT, "-configuration", "Debug", "-sdk", "iphoneos",
                        "-destination", "id=" + arguments.device, "-derivedDataPath", str(derived),
                        "-allowProvisioningUpdates", "-quiet", "clean", "build",
                        "CODE_SIGN_STYLE=Automatic", "CODE_SIGNING_ALLOWED=YES", "ARCHS=arm64", "ONLY_ACTIVE_ARCH=YES"],
                       "Xcode 干净构建")
            if read_bundle_id(app) != baseline.bundle_id:
                raise RefreshError("新构建产物不是原应用，已拒绝安装。")
            new_version = read_app_version(app)
            validate_no_downgrade(installed_version, new_version)
            updated = decode_profile(app / "embedded.mobileprovision", runner)
            validate_replacement(baseline.profile, updated, baseline.bundle_id, dt.datetime.now(UTC))
            runner.run(["/usr/bin/codesign", "--verify", "--deep", "--strict", str(app)], "新产物签名校验", 30)
            # A user may upgrade or remove the app while the clean build runs.
            # Recheck the exact bundle immediately before installing.
            current_installed = query_installed_version(runner, arguments.device, baseline.bundle_id)
            validate_no_downgrade(current_installed, new_version)
            log("已确认描述文件创建时间更新、有效期延后，且产物签名完整；开始安装。")
            runner.run(["xcrun", "devicectl", "device", "install", "app", "--device", arguments.device,
                        "--timeout", "90", str(app)], "设备安装", 95)
            new_embedded = transaction / "embedded-installed.mobileprovision"
            shutil.copyfile(app / "embedded.mobileprovision", new_embedded)
            os.chmod(new_embedded, 0o600)
            save_baseline(state_file, backup_root, Baseline(updated, baseline.bundle_id, new_embedded, new_version), pending=False)
            installed = True
            log("续签安装成功；已更新本地已安装基线。")
            if arguments.launch:
                runner.run(["xcrun", "devicectl", "device", "process", "launch", "--device", arguments.device,
                            "--timeout", "30", baseline.bundle_id], "显式启动应用", 35)
                log("已按 --launch 启动应用。")
        finally:
            if not installed and cache is not None:
                restored, skipped = cache.restore()
                log("未完成续签安装；已恢复 %d 份旧缓存，%d 个现存新缓存保持原样。" % (restored, skipped))


def parse_arguments(argv: Optional[Sequence[str]] = None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="用官方 Xcode 工具为本仓库清读应用续签并安装；不创建后台任务。")
    parser.add_argument("--device", required=True, help="devicectl/Xcode 可识别的已配对设备标识；不写入脚本")
    parser.add_argument("--force", action="store_true", help="即使剩余超过三天也执行一次刷新")
    parser.add_argument("--launch", action="store_true", help="安装成功后显式启动应用（默认不启动）")
    parser.add_argument("--derived-data", default=".build/device", help="仓库 .build 下的设备 DerivedData（默认 .build/device）")
    parser.add_argument("--timeout", type=float, default=900, help="全部工具调用的总超时秒数（默认 900）")
    result = parser.parse_args(argv)
    if not result.device.strip() or result.timeout < 30 or not math.isfinite(result.timeout):
        parser.error("设备不能为空，且 --timeout 必须是至少 30 的有限秒数。")
    return result


def main(argv: Optional[Sequence[str]] = None) -> int:
    arguments = parse_arguments(argv)
    def interrupted(_number, _frame):
        raise KeyboardInterrupt()
    signal.signal(signal.SIGTERM, interrupted)
    try:
        refresh(arguments)
        return 0
    except AlreadyRunning as error:
        log(str(error))
        return 0
    except KeyboardInterrupt:
        log("续签已中止；已执行旧缓存恢复流程。")
        return 130
    except RefreshError as error:
        log(str(error))
        return 1
    except OSError:
        log("本地文件操作失败；请检查磁盘权限与 signing-backup 安全备份。")
        return 1


if __name__ == "__main__":
    sys.exit(main())
