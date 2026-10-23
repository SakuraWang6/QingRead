"""Release metadata consistency and publication boundary tests; no SDK needed."""
import importlib.util
import json
from pathlib import Path
import struct
import tempfile
import unittest
from unittest import mock
import zipfile

SCRIPT = Path(__file__).with_name("generate-release-manifest.py")
spec = importlib.util.spec_from_file_location("release_manifest", SCRIPT)
release = importlib.util.module_from_spec(spec)
spec.loader.exec_module(release)


def binary_manifest(package="app.qingread.android", version="0.11.0", build=11):
    """A small binary-XML parser fixture; signature checks are mocked separately."""
    strings = ["manifest", "package", package, "versionName", version, "versionCode"]
    values = bytearray()
    offsets = []
    for value in strings:
        offsets.append(len(values))
        encoded = value.encode()
        values.extend(bytes([len(value), len(encoded)]) + encoded + b"\0")
    values.extend(b"\0" * (-len(values) % 4))
    pool = struct.pack("<HHIIIIII", 1, 28, 28 + len(offsets) * 4 + len(values), len(offsets), 0, 0x100, 28 + len(offsets) * 4, 0)
    pool += struct.pack("<" + "I" * len(offsets), *offsets) + values
    attrs = b"".join(struct.pack("<IIIHBBI", 0xffffffff, name, raw, 8, 0, kind, value)
                     for name, raw, kind, value in [(1, 2, 3, 2), (3, 4, 3, 4), (5, 0xffffffff, 0x10, build)])
    node = struct.pack("<HHIII", 0x102, 16, 16 + 20 + len(attrs), 1, 0xffffffff)
    node += struct.pack("<IIHHHHHH", 0xffffffff, 0, 20, 20, 3, 0, 0, 0) + attrs
    return struct.pack("<HHI", 3, 8, 8 + len(pool) + len(node)) + pool + node


class ReleaseManifestTests(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.addCleanup(self.directory.cleanup)
        self.root = Path(self.directory.name)
        self.info = {"schemaVersion": 1, "version": "0.11.0", "releases": [
            {"version": "0.11.0", "date": "2026-10-23", "changes": ["关于清读与检查更新。"]}]}
        self.write("App/Resources/AppInfo.json", json.dumps(self.info))
        self.write("LICENSE", "Fixture license\n")
        self.write("App/Resources/ProjectLicense.txt", "Fixture license\n")
        self.write("Config/App.xcconfig", "MARKETING_VERSION = 0.11.0\nCURRENT_PROJECT_VERSION = 15\n")
        self.write("web/package.json", '{"version":"0.11.0"}')
        self.write("web/android/app/build.gradle", 'versionName "0.11.0"\nversionCode 11\n')

    def write(self, name, text):
        path = self.root / name
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(text)
        return path

    def apk(self, manifest=None, dex=b"dex\n035\0"):
        path = self.root / "private-release.apk"
        with zipfile.ZipFile(path, "w") as archive:
            archive.writestr("AndroidManifest.xml", manifest if manifest is not None else binary_manifest())
            if dex is not None:
                archive.writestr("classes.dex", dex)
        return path

    def artifact(self, path, **kwargs):
        return release.build_manifest(self.root, path, "/downloads/QingRead-Android-0.11.0.apk", **kwargs)

    def test_generic_manifest_is_deterministic_and_does_not_offer_an_apk(self):
        first = release.build_manifest(self.root)
        self.assertEqual(first, release.build_manifest(self.root))
        self.assertEqual(first["publishedAt"], "2026-10-23T00:00:00+08:00")
        self.assertEqual(first["platforms"]["ios"]["build"], "15")
        self.assertEqual(first["platforms"]["android"]["build"], "11")
        self.assertNotIn("artifact", first["platforms"]["android"])

    def test_shared_license_and_actual_repository_versions_are_consistent(self):
        info, versions, _, _, _ = release.release_inputs(SCRIPT.resolve().parents[1])
        self.assertTrue(all(version == info["version"] for version in versions.values()))

    def test_platform_version_mismatch_is_rejected(self):
        for path, text in [("web/package.json", '{"version":"0.10.1"}'),
                           ("Config/App.xcconfig", "MARKETING_VERSION = 0.10.1\nCURRENT_PROJECT_VERSION = 15\n"),
                           ("web/android/app/build.gradle", 'versionName "0.10.1"\nversionCode 11\n')]:
            original = (self.root / path).read_text()
            with self.subTest(path=path):
                self.write(path, text)
                with self.assertRaises(release.ManifestError):
                    release.build_manifest(self.root)
            self.write(path, original)

    def test_license_drift_and_missing_notes_are_rejected(self):
        self.write("App/Resources/ProjectLicense.txt", "Different license\n")
        with self.assertRaises(release.ManifestError):
            release.build_manifest(self.root)
        self.write("App/Resources/ProjectLicense.txt", "Fixture license\n")
        self.info["releases"] = []
        self.write("App/Resources/AppInfo.json", json.dumps(self.info))
        with self.assertRaises(release.ManifestError):
            release.build_manifest(self.root)

    def test_explicit_timestamp_requires_timezone(self):
        feed = release.build_manifest(self.root, published_at="2026-10-23T10:30:00Z")
        self.assertEqual(feed["publishedAt"], "2026-10-23T10:30:00+00:00")
        with self.assertRaises(release.ManifestError):
            release.build_manifest(self.root, published_at="2026-10-23T10:30:00")

    def test_apk_and_url_must_be_supplied_together(self):
        with self.assertRaises(release.ManifestError):
            release.build_manifest(self.root, android_apk=self.apk())
        with self.assertRaises(release.ManifestError):
            release.build_manifest(self.root, android_url="/downloads/QingRead-Android-0.11.0.apk")

    def test_external_encoded_and_mutable_urls_are_rejected(self):
        path = self.apk()
        for url in ["http://example.com/app.apk", "https://example.com/app.apk", "//example.com/a.apk",
                    "/downloads/../a.apk", "/downloads/%61.apk", "/downloads/a.apk?x=1",
                    "/downloads/a.apk#fragment", "/downloads/a/b.apk", "/downloads/QingRead-latest.apk",
                    "/downloads/QingRead-Android-0.10.1.apk", "/downloads/a\\b.apk"]:
            with self.subTest(url=url), self.assertRaises(release.ManifestError):
                release.build_manifest(self.root, path, url)

    def test_non_apks_and_symlinks_are_rejected(self):
        fake = self.write("fake.apk", "<html>download failed</html>")
        with self.assertRaises(release.ManifestError):
            self.artifact(fake)
        link = self.root / "link.apk"
        link.symlink_to(self.apk())
        with self.assertRaises(release.ManifestError):
            self.artifact(link)

    def test_wrong_package_version_or_build_is_rejected(self):
        for values in [{"package": "another.app"}, {"version": "0.10.1"}, {"build": 10}]:
            with self.subTest(values=values), self.assertRaises(release.ManifestError):
                self.artifact(self.apk(binary_manifest(**values)))

    def test_invalid_binary_manifest_and_missing_dex_are_rejected(self):
        for data in [b"<manifest/>", b"\x03\x00\x08\x00\xff\xff\xff\xff"]:
            with self.subTest(data=data), self.assertRaises(release.ManifestError):
                self.artifact(self.apk(data))
        for dex in [None, b"not dex"]:
            with self.subTest(dex=dex), self.assertRaises(release.ManifestError):
                self.artifact(self.apk(dex=dex))

    def test_verified_artifact_contains_only_relative_url_hash_and_size(self):
        path = self.apk()
        with mock.patch.object(release, "verify_apk_signature") as verify:
            feed = self.artifact(path)
        verify.assert_called_once_with(path, None)
        artifact = feed["platforms"]["android"]["artifact"]
        self.assertEqual(set(artifact), {"url", "sha256", "size"})
        self.assertEqual(artifact["sha256"], release.hashlib.sha256(path.read_bytes()).hexdigest())
        self.assertEqual(artifact["size"], path.stat().st_size)
        self.assertNotIn(str(path), json.dumps(feed))

    def test_apk_signature_failure_and_changed_file_are_rejected(self):
        path = self.apk()
        with mock.patch.object(release, "verify_apk_signature", side_effect=release.ManifestError("Invalid signature")):
            with self.assertRaises(release.ManifestError):
                self.artifact(path)
        def change(*_args):
            path.write_bytes(path.read_bytes() + b"changed")
        with mock.patch.object(release, "verify_apk_signature", side_effect=change):
            with self.assertRaises(release.ManifestError):
                self.artifact(path)

    def test_apksigner_jar_is_run_through_java_and_failure_is_not_ignored(self):
        jar = self.write("apksigner.jar", "fixture")
        apk = self.apk()
        with mock.patch.object(release.shutil, "which", return_value="/usr/bin/java"), mock.patch.object(release.subprocess, "run") as run:
            run.return_value.returncode = 0
            release.verify_apk_signature(apk, jar)
            self.assertEqual(run.call_args.args[0], ["/usr/bin/java", "-jar", str(jar), "verify", "--verbose", str(apk)])
            run.return_value.returncode = 1
            with self.assertRaises(release.ManifestError):
                release.verify_apk_signature(apk, jar)

    def test_atomic_output_and_generic_feed_do_not_remove_existing_artifact(self):
        path = self.root / "private-feed/releases.json"
        generic = release.build_manifest(self.root)
        release.write_manifest(path, generic)
        self.assertEqual(json.loads(path.read_text()), generic)
        self.assertEqual(list(path.parent.glob(".releases-*")), [])
        with mock.patch.object(release, "verify_apk_signature"):
            signed = self.artifact(self.apk())
        release.write_manifest(path, signed)
        before = path.read_bytes()
        with self.assertRaises(release.ManifestError):
            release.write_manifest(path, generic)
        self.assertEqual(path.read_bytes(), before)


if __name__ == "__main__":
    unittest.main()
