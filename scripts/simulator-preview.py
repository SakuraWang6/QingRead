#!/usr/bin/env python3
"""Install, launch, and capture the actual Debug build in an available iPhone simulator."""
import json
from pathlib import Path
import subprocess
import time

ROOT = Path(__file__).resolve().parents[1]


def run(*args, timeout=180):
    return subprocess.run(args, check=True, text=True, capture_output=True, timeout=timeout).stdout


def main():
    inventory = json.loads(run("xcrun", "simctl", "list", "devices", "available", "--json"))["devices"]
    choices = [device for runtime, devices in inventory.items() if "iOS" in runtime
               for device in devices if "iPhone" in device["name"]]
    if not choices:
        raise SystemExit("No iPhone simulator runtime is installed")
    device = next((item for item in choices if item["state"] == "Booted"), choices[0])
    udid = device["udid"]
    if device["state"] != "Booted":
        run("xcrun", "simctl", "boot", udid)
    run("xcrun", "simctl", "bootstatus", udid, "-b")
    app = ROOT / ".build/xcode/Build/Products/Debug-iphonesimulator/QingRead.app"
    run("xcrun", "simctl", "status_bar", udid, "override", "--time", "9:41", "--dataNetwork", "wifi", "--wifiMode", "active", "--wifiBars", "3", "--batteryState", "charged", "--batteryLevel", "100")
    run("xcrun", "simctl", "ui", udid, "appearance", "light")
    run("xcrun", "simctl", "install", udid, str(app))
    directory = ROOT / ".build/previews"
    directory.mkdir(parents=True, exist_ok=True)
    for index, screen in enumerate(["library", "search", "sources", "reader", "recommendations", "categories", "reader-controls", "catalog", "audio"]):
        if index:
            run("xcrun", "simctl", "terminate", udid, "app.qingread.personal")
        if screen == "library":
            arguments = ["--storage-self-test", "--cover-self-test", "--ai-self-test"]
        elif screen in ["reader-controls", "catalog", "audio"]:
            flag = {"reader-controls": "--reader-controls", "catalog": "--reader-catalog", "audio": "--reader-audio"}[screen]
            arguments = ["--qingread-preview", "reader", flag]
        else:
            arguments = ["--qingread-preview", screen]
            if screen == "reader": arguments.append("--reader-self-test")
        stdout = directory / f"{screen}.stdout.log"
        stderr = directory / f"{screen}.stderr.log"
        launch = run("xcrun", "simctl", "launch", f"--stdout={stdout}", f"--stderr={stderr}", udid, "app.qingread.personal", *arguments)
        print(launch.strip())
        time.sleep(6)
        markers = {"library": ["QINGREAD_STORAGE_SELFTEST", "QINGREAD_COVER_SELFTEST", "QINGREAD_AI_MODEL_SELFTEST"],
                   "reader": ["QINGREAD_SPEECH_SELFTEST", "QINGREAD_READER_SELFTEST"]}.get(screen, [])
        if markers:
            output = stdout.read_text() if stdout.exists() else ""
            if not all(marker in output for marker in markers):
                raise SystemExit(f"Missing diagnostics for {screen}; inspect {stdout} and {stderr}")
            print("Verified " + ", ".join(markers))
        destination = directory / f"{screen}.png"
        run("xcrun", "simctl", "io", udid, "screenshot", str(destination))
        print(f"Captured {device['name']} / {screen}: {destination}")


if __name__ == "__main__":
    main()
