"""Offline tests: no Apple tool, account, profile directory, or device is used."""
import argparse
import datetime as dt
import importlib.util
import json
from pathlib import Path
import plistlib
import shutil
import sys
import tempfile
import unittest
from unittest.mock import patch


SPEC = importlib.util.spec_from_file_location("qingread_refresh_device", Path(__file__).with_name("refresh-device.py"))
refresh = importlib.util.module_from_spec(SPEC)
sys.modules[SPEC.name] = refresh
SPEC.loader.exec_module(refresh)
UTC = dt.timezone.utc
BUNDLE = "com.example.Reader"
NOW = dt.datetime(2026, 10, 20, 10, 0, tzinfo=UTC)
OLD_UUID = "11111111-2222-3333-4444-555555555555"
NEW_UUID = "AAAAAAAA-BBBB-CCCC-DDDD-EEEEEEEEEEEE"


def profile(identifier=OLD_UUID, created=NOW - dt.timedelta(days=6), expires=NOW + dt.timedelta(days=1), app="TESTTEAM01." + BUNDLE):
    return refresh.ProfileMetadata(identifier, app, created, expires)


def encoded(metadata):
    return json.dumps(metadata.to_json()).encode()


def fake_decode(path, _runner=None):
    return refresh.ProfileMetadata.from_json(json.loads(path.read_bytes()))


class MetadataTests(unittest.TestCase):
    def test_cms_plist_dates_are_normalized_to_utc(self):
        value = {"UUID": OLD_UUID.lower(), "CreationDate": NOW.replace(tzinfo=None),
                 "ExpirationDate": (NOW + dt.timedelta(days=7)).replace(tzinfo=None),
                 "Entitlements": {"application-identifier": "TESTTEAM01." + BUNDLE}}
        parsed = refresh.ProfileMetadata.from_plist(plistlib.loads(plistlib.dumps(value)))
        self.assertEqual(parsed.created, NOW)
        self.assertEqual(parsed.identifier, OLD_UUID)
        self.assertTrue(parsed.matches_bundle(BUNDLE))
        self.assertEqual(refresh.ProfileMetadata.from_json(parsed.to_json()), parsed)

    def test_wildcard_traversal_uuid_and_bad_dates_are_rejected(self):
        base = {"UUID": OLD_UUID, "CreationDate": NOW, "ExpirationDate": NOW + dt.timedelta(days=7),
                "Entitlements": {"application-identifier": "TESTTEAM01." + BUNDLE}}
        for change in [{"UUID": "../../not-owned"}, {"ExpirationDate": NOW},
                       {"CreationDate": "2026-10-20"}, {"Entitlements": {"application-identifier": "TESTTEAM01.*"}}]:
            with self.subTest(change=list(change)):
                with self.assertRaises(refresh.RefreshError):
                    refresh.ProfileMetadata.from_plist(dict(base, **change))

    def test_three_day_boundary_force_and_expiration(self):
        self.assertFalse(refresh.needs_refresh(profile(expires=NOW + dt.timedelta(days=3, seconds=1)), NOW))
        self.assertTrue(refresh.needs_refresh(profile(expires=NOW + dt.timedelta(days=3)), NOW))
        self.assertTrue(refresh.needs_refresh(profile(expires=NOW - dt.timedelta(seconds=1)), NOW))
        self.assertTrue(refresh.needs_refresh(profile(expires=NOW + dt.timedelta(days=7)), NOW, force=True))

    def test_replacement_requires_new_creation_expiry_and_same_application(self):
        old = profile()
        good = profile(NEW_UUID, created=NOW, expires=NOW + dt.timedelta(days=7))
        refresh.validate_replacement(old, good, BUNDLE, NOW)
        for bad in [profile(NEW_UUID, created=old.created, expires=good.expires),
                    profile(NEW_UUID, created=good.created, expires=old.expires),
                    profile(NEW_UUID, created=good.created, expires=NOW + dt.timedelta(days=2)),
                    profile(NEW_UUID, created=good.created, expires=good.expires, app="OTHERTEAM1." + BUNDLE),
                    profile(NEW_UUID, created=good.created, expires=good.expires, app="TESTTEAM01.com.example.Other")]:
            with self.assertRaises(refresh.RefreshError):
                refresh.validate_replacement(old, bad, BUNDLE, NOW)

    def test_device_requires_live_success_result(self):
        refresh.validate_device_response(b'{"info":{"outcome":"success"},"result":{"deviceIsLocked":false}}')
        for data in [b"not json", b'{"info":{"outcome":"failure"},"result":{"cached":true}}',
                     b'{"info":{"outcome":"success"},"result":{}}']:
            with self.assertRaises(refresh.RefreshError):
                refresh.validate_device_response(data)

    def test_installed_app_requires_exact_bundle_and_nonempty_version_fields(self):
        def payload(apps):
            return json.dumps({"info": {"outcome": "success"}, "result": {"matchingBundleIdentifier": BUNDLE, "apps": apps}}).encode()
        version = refresh.parse_installed_app(payload([{"bundleIdentifier": BUNDLE, "version": "0.2.0", "bundleVersion": "2"}]), BUNDLE)
        self.assertEqual(version, refresh.AppVersion("0.2.0", "2"))
        for apps in [[], [{"bundleIdentifier": "com.example.Other", "version": "0.2.0", "bundleVersion": "2"}],
                     [{"bundleIdentifier": BUNDLE, "version": "0.2.0"}]]:
            with self.assertRaises(refresh.RefreshError):
                refresh.parse_installed_app(payload(apps), BUNDLE)

    def test_marketing_version_must_match_and_build_comparison_is_numeric(self):
        for installed, built in [(refresh.AppVersion("0.3.0", "3"), refresh.AppVersion("0.2.0", "2")),
                                 (refresh.AppVersion("0.2.0", "2"), refresh.AppVersion("0.3.0", "3")),
                                 (refresh.AppVersion("0.2.0", "10"), refresh.AppVersion("0.2.0", "9")),
                                 (refresh.AppVersion("0.2.0", "2.10"), refresh.AppVersion("0.2.0", "2.9")),
                                 (refresh.AppVersion("0.2.0", "2b2"), refresh.AppVersion("0.2.0", "2b1"))]:
            with self.assertRaises(refresh.RefreshError):
                refresh.validate_no_downgrade(installed, built)
        for installed, built in [("2", "2.0"), ("2.0", "2"), ("2", "3"), ("2.9", "2.10"), ("2b1", "2b1")]:
            refresh.validate_no_downgrade(refresh.AppVersion("0.2.0", installed), refresh.AppVersion("0.2.0", built))


class CacheScopeTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name)
        self.directories = [self.root / "modern", self.root / "legacy"]
        self.backup = self.root / "backup"
        self.backup.mkdir()
        for directory in self.directories:
            directory.mkdir()

    def tearDown(self):
        self.temp.cleanup()

    def write_owned(self, directory=0):
        path = self.directories[directory] / (OLD_UUID + ".mobileprovision")
        path.write_bytes(encoded(profile()))
        return path

    def test_only_exact_owned_uuid_is_read_and_moved(self):
        original = self.write_owned()
        unrelated = self.directories[0] / (NEW_UUID + ".mobileprovision")
        unrelated.write_bytes(b"do-not-read-or-move")
        reads = []
        def read(path):
            reads.append(path)
            return fake_decode(path)
        backup = refresh.CacheBackup.move_owned(profile(), self.directories, self.backup, read)
        self.assertEqual(reads, [original])
        self.assertFalse(original.exists())
        self.assertEqual(unrelated.read_bytes(), b"do-not-read-or-move")
        self.assertEqual(backup.restore(), (1, 0))
        self.assertEqual(fake_decode(original), profile())
        self.assertTrue(backup.entries[0][1].exists())
        original.write_bytes(b"future-cache-write")
        self.assertEqual(fake_decode(backup.entries[0][1]), profile())

    def test_restore_never_overwrites_a_new_cache(self):
        original = self.write_owned()
        backup = refresh.CacheBackup.move_owned(profile(), self.directories, self.backup, fake_decode)
        original.write_bytes(b"new-cache-must-remain")
        self.assertEqual(backup.restore(), (0, 1))
        self.assertEqual(original.read_bytes(), b"new-cache-must-remain")
        self.assertTrue(backup.entries[0][1].exists())

    def test_metadata_mismatch_and_symlink_fail_without_mutation(self):
        original = self.write_owned()
        original.write_bytes(encoded(profile(app="OTHERTEAM1." + BUNDLE)))
        with self.assertRaises(refresh.RefreshError):
            refresh.CacheBackup.move_owned(profile(), self.directories, self.backup, fake_decode)
        self.assertTrue(original.is_file())
        original.unlink()
        target = self.root / "external"
        target.write_bytes(b"untouched")
        original.symlink_to(target)
        with self.assertRaises(refresh.RefreshError):
            refresh.CacheBackup.move_owned(profile(), self.directories, self.backup, fake_decode)
        self.assertEqual(target.read_bytes(), b"untouched")

    def test_both_exact_copies_restore_without_touching_other_names(self):
        for number in [0, 1]:
            self.write_owned(number)
        backup = refresh.CacheBackup.move_owned(profile(), self.directories, self.backup, fake_decode)
        self.assertEqual(len(backup.entries), 2)
        self.assertEqual(backup.restore(), (2, 0))

    def test_lock_blocks_reentry(self):
        with refresh.exclusive_lock(self.root / "run.lock"):
            with self.assertRaises(refresh.AlreadyRunning):
                with refresh.exclusive_lock(self.root / "run.lock"):
                    self.fail("Must not acquire a second lock")


class WorkflowTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.repo = Path(self.temp.name) / "repo"
        self.home = Path(self.temp.name) / "home"
        self.app = self.repo / ".build/device/Build/Products/Debug-iphoneos/QingRead.app"
        self.app.mkdir(parents=True)
        self.initial_version = refresh.AppVersion("0.2.0", "2")
        self.installed_version = self.initial_version
        self.rebuilt_version = None
        self.installed_after_build = None
        self.app_removed = False
        self.remove_during_build = False
        self.build_finished = False
        with (self.app / "Info.plist").open("wb") as stream:
            plistlib.dump({"CFBundleIdentifier": BUNDLE, "CFBundleShortVersionString": "0.2.0", "CFBundleVersion": "2"}, stream)
        now = dt.datetime.now(UTC)
        self.old = profile(created=now - dt.timedelta(days=6), expires=now + dt.timedelta(days=1))
        self.new = profile(NEW_UUID, created=now, expires=now + dt.timedelta(days=7))
        (self.app / "embedded.mobileprovision").write_bytes(encoded(self.old))
        self.cache = refresh.cache_directories(self.home)[0]
        self.cache.mkdir(parents=True)
        (self.cache / (OLD_UUID + ".mobileprovision")).write_bytes(encoded(self.old))
        self.commands = []
        self.fail_signature = False
        self.fail_preflight = False
        self.args = argparse.Namespace(device="test-device-only", force=True, launch=False, derived_data=".build/device", timeout=60)

    def tearDown(self):
        self.temp.cleanup()

    def run_refresh(self):
        owner = self
        class FakeRunner:
            def __init__(self, _timeout): pass
            def run(self, command, _label, _limit=None):
                owner.commands.append(list(command))
                if command[:5] == ["xcrun", "devicectl", "device", "info", "lockState"]:
                    if owner.fail_preflight:
                        raise refresh.RefreshError("Test device offline")
                    return b'{"info":{"outcome":"success"},"result":{"deviceIsLocked":false}}'
                if command[:5] == ["xcrun", "devicectl", "device", "info", "apps"]:
                    owner.assertEqual(command[command.index("--bundle-id") + 1], BUNDLE)
                    current = owner.installed_after_build if owner.build_finished and owner.installed_after_build is not None else owner.installed_version
                    absent = owner.app_removed or (owner.build_finished and owner.remove_during_build)
                    apps = [] if absent else [{"bundleIdentifier": BUNDLE, "version": current.version, "bundleVersion": current.build}]
                    return json.dumps({"info": {"outcome": "success"}, "result": {"matchingBundleIdentifier": BUNDLE, "apps": apps}}).encode()
                if command[0] == "xcodebuild":
                    owner.assertIn("clean", command)
                    owner.assertIn("build", command)
                    owner.assertIn("CODE_SIGNING_ALLOWED=YES", command)
                    new_version = owner.rebuilt_version or (refresh.read_app_version(owner.app) if owner.app.exists() else owner.initial_version)
                    if owner.app.exists():
                        shutil.rmtree(owner.app)
                    owner.app.mkdir(parents=True)
                    with (owner.app / "Info.plist").open("wb") as stream:
                        plistlib.dump({"CFBundleIdentifier": BUNDLE, "CFBundleShortVersionString": new_version.version,
                                      "CFBundleVersion": new_version.build}, stream)
                    (owner.app / "embedded.mobileprovision").write_bytes(encoded(owner.new))
                    (owner.cache / (owner.new.identifier + ".mobileprovision")).write_bytes(encoded(owner.new))
                    owner.build_finished = True
                if command[0] == "/usr/bin/codesign" and owner.fail_signature:
                    raise refresh.RefreshError("Test signature invalid")
                if command[:5] == ["xcrun", "devicectl", "device", "install", "app"]:
                    owner.assertTrue(Path(command[-1]).is_absolute())
                    owner.installed_version = refresh.read_app_version(owner.app)
                return b""
        with patch.object(refresh, "REPO", self.repo), patch.object(refresh, "ToolRunner", FakeRunner), \
             patch.object(refresh, "decode_profile", fake_decode), patch.object(refresh.Path, "home", return_value=self.home), \
             patch.object(refresh, "log"):
            refresh.refresh(self.args)

    def test_verified_clean_build_installs_without_launch_and_updates_baseline(self):
        self.run_refresh()
        commands = [entry[0:5] for entry in self.commands]
        verification = next(i for i, command in enumerate(self.commands) if command[0] == "/usr/bin/codesign")
        installation = next(i for i, command in enumerate(commands) if command == ["xcrun", "devicectl", "device", "install", "app"])
        self.assertLess(verification, installation)
        self.assertFalse(any("launch" in command for command in self.commands))
        state = json.loads((self.repo / "work/signing-backup/refresh-state.json").read_text())
        self.assertFalse(state["pending"])
        self.assertEqual(refresh.ProfileMetadata.from_json(state["baseline"]), self.new)
        self.assertEqual(state["app_version"], self.initial_version.to_json())
        self.assertFalse((self.cache / (OLD_UUID + ".mobileprovision")).exists())

    def test_bad_signature_does_not_install_and_restores_only_old_cache(self):
        self.fail_signature = True
        with self.assertRaises(refresh.RefreshError):
            self.run_refresh()
        self.assertFalse(any(command[:5] == ["xcrun", "devicectl", "device", "install", "app"] for command in self.commands))
        self.assertEqual(fake_decode(self.cache / (OLD_UUID + ".mobileprovision")), self.old)
        self.assertEqual(fake_decode(self.cache / (NEW_UUID + ".mobileprovision")), self.new)
        state = json.loads((self.repo / "work/signing-backup/refresh-state.json").read_text())
        self.assertTrue(state["pending"])
        self.assertEqual(refresh.ProfileMetadata.from_json(state["baseline"]), self.old)
        # The successful but uninstalled product has seven days left. Recovery
        # still uses the one-day installed baseline, so a normal run must retry.
        self.commands.clear()
        self.fail_signature = False
        self.args.force = False
        shutil.rmtree(self.app)
        self.run_refresh()
        self.assertTrue(any(command[:5] == ["xcrun", "devicectl", "device", "install", "app"] for command in self.commands))

    def test_offline_preflight_leaves_cache_and_build_untouched(self):
        self.fail_preflight = True
        with self.assertRaises(refresh.RefreshError):
            self.run_refresh()
        self.assertTrue((self.cache / (OLD_UUID + ".mobileprovision")).exists())
        self.assertFalse(any(command[0] == "xcodebuild" for command in self.commands))
        self.assertFalse((self.repo / "work/signing-backup").exists())

    def test_skip_uses_no_device_or_build_command(self):
        fresh = profile(created=dt.datetime.now(UTC), expires=dt.datetime.now(UTC) + dt.timedelta(days=7))
        (self.app / "embedded.mobileprovision").write_bytes(encoded(fresh))
        self.args.force = False
        self.run_refresh()
        self.assertEqual(self.commands, [])

    def assert_preflight_rejected_without_cache_mutation(self):
        with self.assertRaises(refresh.RefreshError):
            self.run_refresh()
        self.assertTrue((self.cache / (OLD_UUID + ".mobileprovision")).exists())
        self.assertFalse(any(command[0] == "xcodebuild" for command in self.commands))
        self.assertFalse((self.repo / "work/signing-backup").exists())

    def test_newer_installed_version_refuses_before_cache_move(self):
        self.installed_version = refresh.AppVersion("0.3.0", "3")
        self.assert_preflight_rejected_without_cache_mutation()

    def test_same_version_newer_installed_build_refuses_before_cache_move(self):
        self.installed_version = refresh.AppVersion("0.2.0", "10")
        self.assert_preflight_rejected_without_cache_mutation()

    def test_removed_app_is_not_reinstalled(self):
        self.app_removed = True
        self.assert_preflight_rejected_without_cache_mutation()

    def test_changed_source_version_after_clean_is_not_installed(self):
        self.rebuilt_version = refresh.AppVersion("0.1.0", "1")
        with self.assertRaises(refresh.RefreshError):
            self.run_refresh()
        self.assertFalse(any(command[:5] == ["xcrun", "devicectl", "device", "install", "app"] for command in self.commands))
        self.assertEqual(fake_decode(self.cache / (OLD_UUID + ".mobileprovision")), self.old)

    def test_upgrade_during_build_is_rechecked_before_install(self):
        self.installed_after_build = refresh.AppVersion("0.2.0", "10")
        with self.assertRaises(refresh.RefreshError):
            self.run_refresh()
        self.assertFalse(any(command[:5] == ["xcrun", "devicectl", "device", "install", "app"] for command in self.commands))
        self.assertEqual(fake_decode(self.cache / (OLD_UUID + ".mobileprovision")), self.old)

    def test_removal_during_build_is_rechecked_before_install(self):
        self.remove_during_build = True
        with self.assertRaises(refresh.RefreshError):
            self.run_refresh()
        self.assertFalse(any(command[:5] == ["xcrun", "devicectl", "device", "install", "app"] for command in self.commands))
        self.assertEqual(fake_decode(self.cache / (OLD_UUID + ".mobileprovision")), self.old)

    def test_legacy_baseline_migrates_version_only_after_successful_install(self):
        backup = self.repo / "work/signing-backup"
        backup.mkdir(parents=True)
        saved = backup / "legacy.mobileprovision"
        shutil.copyfile(self.app / "embedded.mobileprovision", saved)
        state = {"version": 1, "product": "QingRead", "pending": False, "bundle_id": BUNDLE,
                 "baseline": self.old.to_json(), "embedded_backup": saved.name}
        (backup / "refresh-state.json").write_text(json.dumps(state))
        self.run_refresh()
        upgraded = json.loads((backup / "refresh-state.json").read_text())
        self.assertEqual(upgraded["app_version"], self.initial_version.to_json())
        self.assertFalse(upgraded["pending"])

    def test_updated_runtime_matching_phone_advances_existing_baseline(self):
        self.run_refresh()
        now = dt.datetime.now(UTC)
        self.new = profile("BBBBBBBB-CCCC-DDDD-EEEE-FFFFFFFFFFFF", created=now + dt.timedelta(seconds=10), expires=now + dt.timedelta(days=7, seconds=10))
        current = refresh.AppVersion("0.3.0", "3")
        self.installed_version = current
        self.build_finished = False
        with (self.app / "Info.plist").open("wb") as stream:
            plistlib.dump({"CFBundleIdentifier": BUNDLE, "CFBundleShortVersionString": current.version, "CFBundleVersion": current.build}, stream)
        self.run_refresh()
        state = json.loads((self.repo / "work/signing-backup/refresh-state.json").read_text())
        self.assertEqual(state["app_version"], current.to_json())
        self.assertEqual(refresh.ProfileMetadata.from_json(state["baseline"]), self.new)


if __name__ == "__main__":
    unittest.main()
