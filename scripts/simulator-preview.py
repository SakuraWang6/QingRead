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
    directory = ROOT / ".build/previews"
    directory.mkdir(parents=True, exist_ok=True)
    for index, screen in enumerate(["library", "search", "sources", "reader"]):
        if index:
            run("xcrun", "simctl", "terminate", udid, "app.qingread.personal")
        arguments = [] if screen == "library" else ["--qingread-preview", screen]
        launch = run("xcrun", "simctl", "launch", udid, "app.qingread.personal", *arguments)
        print(launch.strip())
        time.sleep(6)
        destination = directory / f"{screen}.png"
        run("xcrun", "simctl", "io", udid, "screenshot", str(destination))
        print(f"Captured {device['name']} / {screen}: {destination}")


if __name__ == "__main__":
    main()
