"""Offline installer tests: temporary files and fake launchctl, no device or account."""
import importlib.util
import os
from pathlib import Path
import plistlib
import subprocess
import tempfile
import unittest
from unittest.mock import patch


SPEC = importlib.util.spec_from_file_location("qingread_refresh_installer", Path(__file__).with_name("install-refresh-agent.py"))
installer = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(installer)


class InstallerTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name).resolve()
        self.source = self.root / "repo"
        self.home = self.root / "home"
        self.runtime = self.home / "Library/Application Support/QingReadRefresh"
        self.plist = self.home / "Library/LaunchAgents" / (installer.LABEL + ".plist")
        self.source.mkdir()
        self.home.mkdir()
        for relative in installer.REQUIRED_PATHS:
            target = self.source / relative
            if relative in [Path("App"), Path("Sources"), Path("Tests/ReadingCoreTests"), Path("QingRead.xcodeproj"), installer.APP_PATH]:
                target.mkdir(parents=True)
                (target / "owned.txt").write_text("new")
            else:
                target.parent.mkdir(parents=True, exist_ok=True)
                target.write_text("owned config")
        for name in ("Info.plist", "embedded.mobileprovision"):
            (self.source / installer.APP_PATH / name).write_text("fake test baseline")
        (self.source / "Package.resolved").write_text("{}")

    def tearDown(self):
        self.temp.cleanup()

    def fake_launchctl(self, initially_loaded=False, fail_bootstrap=False, fail_bootout=False):
        self.commands = []
        loaded = initially_loaded
        def invoke(command):
            nonlocal loaded
            self.commands.append(command)
            self.assertEqual(command[0], "/bin/launchctl")
            if command[1] == "print":
                return 0 if loaded else 113
            if command[1] == "bootout":
                if fail_bootout:
                    return 1
                loaded = False
                return 0
            if command[1] == "bootstrap":
                # RunAtLoad must not immediately skip due to the installer lock.
                with installer.exclusive_lock(self.runtime / ".build/refresh-device.lock", self.runtime):
                    pass
                if fail_bootstrap:
                    return 1
                loaded = True
                return 0
            self.fail("Unexpected command")
        return invoke

    def install(self, **options):
        with patch.object(installer, "command_status", self.fake_launchctl(**options)), \
             patch.object(installer, "mark_build_directories"):
            installer.install(self.source, self.home, "offline-test-device", "/Applications/Xcode.app/Contents/Developer")

    def test_allowlist_private_config_and_no_user_xcode_state(self):
        excluded = self.source / "QingRead.xcodeproj/xcuserdata/private.xcuserstate"
        excluded.parent.mkdir()
        excluded.write_text("must not copy")
        (self.source / "App/unneeded.p12").write_text("must not copy")
        for name in [".git", "work", "credentials"]:
            (self.source / name).mkdir()
            (self.source / name / "secret").write_text("must not copy")
        self.install()
        self.assertEqual((self.runtime / "App/owned.txt").read_text(), "new")
        self.assertTrue((self.runtime / "Config/Info.plist").is_file())
        self.assertEqual((self.runtime / "Config/local.xcconfig").stat().st_mode & 0o777, 0o600)
        self.assertFalse((self.runtime / "QingRead.xcodeproj/xcuserdata").exists())
        self.assertFalse((self.runtime / "App/unneeded.p12").exists())
        self.assertFalse((self.runtime / ".git").exists())
        self.assertFalse((self.runtime / "credentials").exists())
        self.assertFalse((self.runtime / "work/secret").exists())
        self.assertTrue((self.runtime / installer.APP_PATH / "embedded.mobileprovision").is_file())

    def test_job_arguments_interval_logs_and_permissions(self):
        self.install(initially_loaded=True)
        value = plistlib.loads(self.plist.read_bytes())
        self.assertEqual(value["Label"], installer.LABEL)
        self.assertEqual(value["ProgramArguments"], ["/usr/bin/python3", str(self.runtime / "scripts/refresh-device.py"), "--device", "offline-test-device"])
        self.assertNotIn("--force", value["ProgramArguments"])
        self.assertTrue(value["RunAtLoad"])
        self.assertEqual(value["StartInterval"], 14400)
        self.assertEqual(value["ProcessType"], "Background")
        self.assertEqual(value["Umask"], 0o077)
        self.assertEqual(self.plist.stat().st_mode & 0o777, 0o600)
        for key in ["StandardOutPath", "StandardErrorPath"]:
            path = Path(value[key])
            self.assertEqual(path.stat().st_mode & 0o777, 0o600)
            self.assertEqual(path.parent.stat().st_mode & 0o777, 0o700)
        operations = [command[1] for command in self.commands]
        self.assertLess(operations.index("bootout"), operations.index("bootstrap"))

    def test_update_retains_runtime_work_and_lock_file(self):
        backup = self.runtime / "work/signing-backup/refresh-state.json"
        backup.parent.mkdir(parents=True)
        backup.write_text("existing installed baseline")
        old = self.runtime / "App/old.swift"
        old.parent.mkdir()
        old.write_text("old")
        self.install()
        self.assertEqual(backup.read_text(), "existing installed baseline")
        self.assertFalse(old.exists())
        self.assertFalse(list(self.runtime.glob(".source-staging-*")))

    def test_active_source_or_runtime_refresh_prevents_launchctl_and_copy(self):
        for root in [self.source, self.runtime]:
            root.mkdir(parents=True, exist_ok=True)
            with self.subTest(root=root.name), installer.exclusive_lock(root / ".build/refresh-device.lock", root):
                with patch.object(installer, "command_status") as launchctl:
                    with self.assertRaises(installer.InstallError):
                        installer.install(self.source, self.home, "offline-device", "/fake/Xcode")
                    launchctl.assert_not_called()
                self.assertFalse((self.runtime / "App").exists())

    def test_failed_bootout_retains_previous_plist_and_source(self):
        self.plist.parent.mkdir(parents=True)
        self.plist.write_bytes(b"old private plist")
        with self.assertRaises(installer.InstallError):
            self.install(initially_loaded=True, fail_bootout=True)
        self.assertEqual(self.plist.read_bytes(), b"old private plist")
        self.assertFalse((self.runtime / "App").exists())

    def test_failed_bootstrap_retains_valid_new_source_and_old_plist_backup(self):
        self.plist.parent.mkdir(parents=True)
        self.plist.write_bytes(b"old private plist")
        old = self.runtime / "App/old.swift"
        old.parent.mkdir(parents=True)
        old.write_text("old source")
        backup = self.runtime / "work/signing-backup/keep"
        backup.parent.mkdir(parents=True)
        backup.write_text("keep")
        with self.assertRaises(installer.InstallError):
            self.install(fail_bootstrap=True)
        self.assertFalse(old.exists())
        self.assertEqual((self.runtime / "App/owned.txt").read_text(), "new")
        self.assertEqual(backup.read_text(), "keep")
        self.assertEqual(self.plist.read_bytes(), b"old private plist")

    def test_publication_failure_rolls_back_source_without_touching_work(self):
        self.runtime.mkdir(parents=True)
        old = self.runtime / "App/old.swift"
        old.parent.mkdir()
        old.write_text("old source")
        backup = self.runtime / "work/signing-backup/keep"
        backup.parent.mkdir(parents=True)
        backup.write_text("keep")
        stage, relatives = installer.prepare_stage(self.source, self.runtime)
        try:
            with self.assertRaises(RuntimeError):
                with installer.publish_stage(stage, self.runtime, relatives):
                    raise RuntimeError("Simulate publication failure")
            self.assertEqual(old.read_text(), "old source")
            self.assertFalse((self.runtime / "App/owned.txt").exists())
            self.assertEqual(backup.read_text(), "keep")
        finally:
            import shutil
            shutil.rmtree(stage)

    def test_uninstall_archives_only_plist_and_preserves_runtime(self):
        self.install()
        original = self.plist.read_bytes()
        with patch.object(installer, "command_status", self.fake_launchctl(initially_loaded=True)):
            installer.uninstall(self.home)
        self.assertFalse(self.plist.exists())
        archives = list((self.runtime / "work/agent-backup").glob("*.plist"))
        self.assertEqual(len(archives), 1)
        self.assertEqual(archives[0].read_bytes(), original)
        self.assertEqual(archives[0].stat().st_mode & 0o777, 0o600)
        self.assertTrue((self.runtime / "App/owned.txt").exists())
        self.assertFalse(any(command[1] == "bootstrap" for command in self.commands))

    def test_source_symlink_is_rejected_without_reading_target(self):
        link = self.source / "App/external.swift"
        outside = self.root / "external.swift"
        outside.write_text("must not copy")
        link.symlink_to(outside)
        with self.assertRaises(installer.InstallError):
            self.install()
        self.assertEqual(outside.read_text(), "must not copy")
        self.assertFalse((self.runtime / "App").exists())

    def test_build_marker_uses_only_runtime_paths_and_reports_failure(self):
        for relative in (".build/device/Build/Products/Debug-iphoneos",):
            (self.runtime / relative).mkdir(parents=True)
        with patch.object(installer.subprocess, "run") as run:
            installer.mark_build_directories(self.runtime)
            command = run.call_args[0][0]
            self.assertEqual(command[:4], ["/usr/bin/xattr", "-w", "com.apple.xcode.CreatedByBuildSystem", "true"])
            for path in command[4:]:
                Path(path).relative_to(self.runtime)
        with patch.object(installer.subprocess, "run", side_effect=subprocess.CalledProcessError(1, ["xattr"])):
            with self.assertRaises(installer.InstallError):
                installer.mark_build_directories(self.runtime)


if __name__ == "__main__":
    unittest.main()
