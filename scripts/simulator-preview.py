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
               for device in devices if device["name"].startswith("iPhone")]
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
    launch = run("xcrun", "simctl", "launch", udid, "app.qingread.personal")
    print(launch.strip())
    time.sleep(3)
    destination = ROOT / ".build/preview.png"
    run("xcrun", "simctl", "io", udid, "screenshot", str(destination))
    print(f"Captured {device['name']}: {destination}")


if __name__ == "__main__":
    main()
