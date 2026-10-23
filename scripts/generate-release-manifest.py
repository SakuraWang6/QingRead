#!/usr/bin/env python3
"""Generate same-origin release metadata; APK publication is always explicit."""
from __future__ import annotations

import argparse
import datetime as dt
import hashlib
import json
import os
from pathlib import Path
import re
import shutil
import struct
import subprocess
import tempfile
from urllib.parse import urlsplit
import zipfile

ROOT = Path(__file__).resolve().parents[1]
VERSION = re.compile(r"[0-9]+\.[0-9]+\.[0-9]+")
ANDROID_PACKAGE = "app.qingread.android"


class ManifestError(ValueError):
    pass


def single_value(text: str, pattern: str) -> str:
    values = re.findall(pattern, text, re.MULTILINE)
    if len(values) != 1:
        raise ManifestError("Expected exactly one platform version or build setting.")
    return values[0]


def release_inputs(root: Path):
    info = json.loads((root / "App/Resources/AppInfo.json").read_text())
    if info.get("schemaVersion") != 1 or not VERSION.fullmatch(info.get("version", "")):
        raise ManifestError("AppInfo has an unsupported schema or version.")
    if (root / "LICENSE").read_bytes() != (root / "App/Resources/ProjectLicense.txt").read_bytes():
        raise ManifestError("ProjectLicense.txt must match the root LICENSE byte for byte.")
    config = (root / "Config/App.xcconfig").read_text()
    gradle = (root / "web/android/app/build.gradle").read_text()
    versions = {
        "ios": single_value(config, r"^MARKETING_VERSION\s*=\s*([0-9.]+)\s*$"),
        "web": json.loads((root / "web/package.json").read_text())["version"],
        "android": single_value(gradle, r'^\s*versionName\s+"([^"]+)"\s*$'),
    }
    if any(value != info["version"] for value in versions.values()):
        raise ManifestError("iPhone, Web, Android and AppInfo versions must agree.")
    builds = {
        "ios": single_value(config, r"^CURRENT_PROJECT_VERSION\s*=\s*([0-9]+)\s*$"),
        "android": single_value(gradle, r"^\s*versionCode\s+([0-9]+)\s*$"),
    }
    latest = next((item for item in info.get("releases", []) if item.get("version") == info["version"]), None)
    if latest is None or not latest.get("changes") or not all(isinstance(item, str) and item.strip() for item in latest["changes"]):
        raise ManifestError("AppInfo needs release notes for the current version.")
    try:
        date = dt.date.fromisoformat(latest["date"])
    except (KeyError, TypeError, ValueError):
        raise ManifestError("Current release date must be YYYY-MM-DD.") from None
    return info, versions, builds, latest["changes"], date


def publication_time(value: str | None, release_date: dt.date) -> str:
    if value is None:
        return release_date.isoformat() + "T00:00:00+08:00"
    try:
        parsed = dt.datetime.fromisoformat(value.replace("Z", "+00:00"))
        if parsed.tzinfo is None or parsed.utcoffset() is None:
            raise ValueError()
        return parsed.isoformat(timespec="seconds")
    except ValueError:
        raise ManifestError("publishedAt must be an ISO timestamp with a timezone.") from None


def android_download_url(value: str) -> str:
    # Restrict to a single literal filename, so decoding, redirects and browser
    # URL normalization cannot turn the feed into an off-origin download.
    try:
        parsed = urlsplit(value)
    except ValueError:
        raise ManifestError("Android URL is malformed.") from None
    if parsed.scheme or parsed.netloc or parsed.query or parsed.fragment or not re.fullmatch(r"/downloads/[A-Za-z0-9][A-Za-z0-9._-]*\.apk", value):
        raise ManifestError("Android URL must be a same-origin /downloads/filename.apk path.")
    if ".." in value or "%" in value or "\\" in value:
        raise ManifestError("Android URL must not contain traversal or encoded characters.")
    return value


def android_manifest_values(data: bytes) -> dict:
    """Read just the package/version attributes from Android's binary XML."""
    def u16(offset):
        return struct.unpack_from("<H", data, offset)[0]
    def u32(offset):
        return struct.unpack_from("<I", data, offset)[0]
    def length8(offset):
        value = data[offset]
        return (((value & 0x7f) << 8) | data[offset + 1], offset + 2) if value & 0x80 else (value, offset + 1)
    def length16(offset):
        value = u16(offset)
        return (((value & 0x7fff) << 16) | u16(offset + 2), offset + 4) if value & 0x8000 else (value, offset + 2)
    try:
        if len(data) < 8 or u16(0) != 3 or u16(2) != 8 or u32(4) != len(data):
            raise ValueError()
        strings = []
        offset = 8
        while offset < len(data):
            kind, header, size = struct.unpack_from("<HHI", data, offset)
            if header < 8 or size < header or offset + size > len(data):
                raise ValueError()
            if kind == 1:
                count, flags, start = u32(offset + 8), u32(offset + 16), u32(offset + 20)
                if count > 10000 or header + count * 4 > size or start > size:
                    raise ValueError()
                for index in range(count):
                    position = offset + start + u32(offset + header + index * 4)
                    if flags & 0x100:
                        _, position = length8(position)
                        length, position = length8(position)
                        end = position + length
                        value = data[position:end].decode("utf-8")
                    else:
                        length, position = length16(position)
                        end = position + length * 2
                        value = data[position:end].decode("utf-16-le")
                    if end > offset + size:
                        raise ValueError()
                    strings.append(value)
            elif kind == 0x102 and strings[u32(offset + 20)] == "manifest":
                start, stride, count = u16(offset + 24), u16(offset + 26), u16(offset + 28)
                if stride < 20 or offset + 16 + start + count * stride > offset + size:
                    raise ValueError()
                attributes = {}
                for index in range(count):
                    position = offset + 16 + start + index * stride
                    key, raw, value = strings[u32(position + 4)], u32(position + 8), u32(position + 16)
                    if key in attributes:
                        raise ValueError()
                    attributes[key] = strings[raw] if raw != 0xffffffff else strings[value] if data[position + 15] == 3 else value
                return attributes
            offset += size
    except (IndexError, struct.error, UnicodeError, ValueError):
        pass
    raise ManifestError("APK has an invalid Android binary manifest.")


def find_apksigner(explicit: Path | None) -> Path:
    if explicit is not None:
        choices = [explicit]
    else:
        found = shutil.which("apksigner")
        choices = [Path(found)] if found else []
        sdk_roots = [Path(value) for name in ["ANDROID_HOME", "ANDROID_SDK_ROOT"] if (value := os.environ.get(name))]
        sdk_roots.append(Path.home() / "Library/Android/sdk")
        for sdk in sdk_roots:
            choices.extend(sorted((sdk / "build-tools").glob("*/apksigner"), reverse=True))
    tool = next((path for path in choices if path.is_file() and (path.suffix.lower() == ".jar" or os.access(path, os.X_OK))), None)
    if tool is None:
        raise ManifestError("APK publication requires the Android SDK apksigner; set --apksigner or ANDROID_HOME.")
    return tool


def verify_apk_signature(apk: Path, apksigner: Path | None) -> None:
    try:
        tool = find_apksigner(apksigner)
        command = [str(tool)]
        if tool.suffix.lower() == ".jar":
            java = shutil.which("java")
            if not java:
                raise ManifestError("Java is required for the supplied apksigner JAR.")
            command = [java, "-jar", str(tool)]
        result = subprocess.run(command + ["verify", "--verbose", str(apk)],
                                stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=60)
    except (OSError, subprocess.TimeoutExpired):
        raise ManifestError("APK signature verification could not complete.") from None
    if result.returncode != 0:
        raise ManifestError("APK signature verification failed; no download entry was generated.")


def apk_artifact(apk: Path, url: str, version: str, build: str, apksigner: Path | None = None) -> dict:
    url = android_download_url(url)
    if url != f"/downloads/QingRead-Android-{version}.apk":
        raise ManifestError("Android URL must name the immutable QingRead APK for this exact version.")
    if apk.suffix.lower() != ".apk" or apk.is_symlink() or not apk.is_file():
        raise ManifestError("Android artifact must be an existing regular .apk file.")
    before = apk.stat()
    size = before.st_size
    if not 0 < size <= 512 * 1024 * 1024:
        raise ManifestError("APK is empty or larger than the publication limit.")
    try:
        with zipfile.ZipFile(apk) as archive:
            names = archive.namelist()
            if len(set(names)) != len(names) or "classes.dex" not in names:
                raise ManifestError("APK is missing executable content or has duplicate ZIP entries.")
            manifest = archive.getinfo("AndroidManifest.xml")
            if manifest.file_size > 2 * 1024 * 1024 or sum(item.file_size for item in archive.infolist()) > 1024 * 1024 * 1024:
                raise ManifestError("APK archive expands beyond the publication limit.")
            if archive.testzip() is not None or not archive.open("classes.dex").read(8).startswith(b"dex\n"):
                raise ManifestError("APK archive or DEX content is invalid.")
            values = android_manifest_values(archive.read(manifest))
    except (OSError, KeyError, zipfile.BadZipFile, RuntimeError):
        raise ManifestError("Artifact is not a readable Android APK.") from None
    if values.get("package") != ANDROID_PACKAGE or values.get("versionName") != version or str(values.get("versionCode")) != build:
        raise ManifestError("APK package, version or build does not match this release.")
    verify_apk_signature(apk, apksigner)
    checksum = hashlib.sha256()
    with apk.open("rb") as stream:
        for block in iter(lambda: stream.read(1024 * 1024), b""):
            checksum.update(block)
    after = apk.stat()
    if (before.st_ino, before.st_dev, size, before.st_mtime_ns) != (after.st_ino, after.st_dev, after.st_size, after.st_mtime_ns):
        raise ManifestError("APK changed during verification; no download entry was generated.")
    return {"url": url, "sha256": checksum.hexdigest(), "size": size}


def build_manifest(root: Path, android_apk: Path | None = None, android_url: str | None = None,
                   published_at: str | None = None, apksigner: Path | None = None) -> dict:
    if (android_apk is None) != (android_url is None):
        raise ManifestError("--android-apk and --android-url must be provided together.")
    _, versions, builds, notes, date = release_inputs(root)
    platforms = {platform: {"version": version, **({"build": builds[platform]} if platform in builds else {}), "notes": list(notes)}
                 for platform, version in versions.items()}
    if android_apk is not None:
        platforms["android"]["artifact"] = apk_artifact(android_apk, android_url, versions["android"], builds["android"], apksigner)
    return {"schemaVersion": 1, "publishedAt": publication_time(published_at, date), "platforms": platforms}


def write_manifest(output: Path, manifest: dict) -> None:
    # A generic local build must never silently remove a previously verified
    # download entry from a deployment-specific feed.
    if output.exists() and "artifact" not in manifest["platforms"]["android"]:
        existing = json.loads(output.read_text())
        if existing.get("platforms", {}).get("android", {}).get("artifact"):
            raise ManifestError("Refusing to replace an APK release feed with a generic manifest; choose another --output.")
    output.parent.mkdir(parents=True, exist_ok=True)
    descriptor, temporary = tempfile.mkstemp(prefix=".releases-", suffix=".json", dir=output.parent)
    try:
        with os.fdopen(descriptor, "w", encoding="utf-8") as stream:
            json.dump(manifest, stream, ensure_ascii=False, indent=2)
            stream.write("\n")
            stream.flush()
            os.fsync(stream.fileno())
        os.chmod(temporary, 0o644)
        os.replace(temporary, output)
    finally:
        if os.path.exists(temporary):
            os.unlink(temporary)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output", type=Path, default=ROOT / "web/public/releases.json")
    parser.add_argument("--android-apk", type=Path)
    parser.add_argument("--android-url")
    parser.add_argument("--apksigner", type=Path, help="Existing Android SDK apksigner executable (APK publication only)")
    parser.add_argument("--published-at", help="Explicit ISO publication timestamp with timezone")
    args = parser.parse_args()
    try:
        manifest = build_manifest(ROOT, args.android_apk, args.android_url, args.published_at, args.apksigner)
        write_manifest(args.output, manifest)
    except (ManifestError, OSError, KeyError, json.JSONDecodeError) as error:
        parser.exit(1, f"Release manifest failed: {error}\n")
    print("Generated release manifest; Android download " + ("included." if args.android_apk else "not advertised."))


if __name__ == "__main__":
    main()
