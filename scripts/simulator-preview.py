#!/usr/bin/env python3
"""Install, launch, and capture the actual Debug build in an available iPhone simulator."""
import json
from pathlib import Path
import subprocess
import time

ROOT = Path(__file__).resolve().parents[1]
BOOT_TIMEOUT = 300


def run(*args, timeout=180):
    return subprocess.run(args, check=True, text=True, capture_output=True, timeout=timeout).stdout


def select_device(inventory):
    choices = [(runtime, device) for runtime, devices in inventory.items() if "iOS" in runtime
               for device in devices if "iPhone" in device["name"]]
    if not choices:
        raise SystemExit("No iPhone simulator runtime is installed")
    # Preserve the existing choice: prefer an already booted iPhone, otherwise
    # the first available iPhone. Recovery never silently switches devices.
    return next((item for item in choices if item[1]["state"] == "Booted"), choices[0])


def prepare_simulator(runtime, device, directory, runner=run):
    """Allow one cold-boot recovery, only after bootstatus times out."""
    log_path = directory / "simulator-boot.log"
    log_path.write_text("")

    def record(message):
        print(message, flush=True)
        with log_path.open("a") as stream:
            stream.write(message + "\n")

    def tail(value):
        if isinstance(value, bytes):
            value = value.decode("utf-8", errors="replace")
        return (value or "")[-12000:]

    def command(*arguments, timeout):
        started = time.monotonic()
        record(f"Simulator command={arguments[0]} timeoutSeconds={timeout}")
        try:
            output = runner("xcrun", "simctl", *arguments, timeout=timeout)
        except (subprocess.TimeoutExpired, subprocess.CalledProcessError) as error:
            record(f"Simulator command={arguments[0]} failed={type(error).__name__} "
                   f"elapsedSeconds={time.monotonic() - started:.1f}")
            record("stdout tail:\n" + (tail(error.stdout) or "[empty]"))
            record("stderr tail:\n" + (tail(error.stderr) or "[empty]"))
            raise
        record(f"Simulator command={arguments[0]} completed elapsedSeconds={time.monotonic() - started:.1f}")
        if output:
            record("stdout tail:\n" + tail(output))

    udid = device["udid"]
    record("Selected simulator " + json.dumps({"runtime": runtime, "name": device["name"],
                                              "udid": udid, "initialState": device["state"]}))
    if device["state"] != "Booted":
        command("boot", udid, timeout=60)
    for attempt in range(2):
        try:
            command("bootstatus", udid, "-b", timeout=BOOT_TIMEOUT)
            record(f"Simulator ready bootstatusAttempt={attempt + 1}")
            return
        except subprocess.TimeoutExpired:
            if attempt == 1:
                record("Simulator bootstatus timed out twice; no further recovery attempted.")
                raise
            record("Simulator cold start timed out; shut down and boot the same device once.")
            command("shutdown", udid, timeout=60)
            command("boot", udid, timeout=60)


def main():
    # Create this before booting so a cold-start failure still uploads evidence.
    directory = ROOT / ".build/previews"
    directory.mkdir(parents=True, exist_ok=True)
    inventory = json.loads(run("xcrun", "simctl", "list", "devices", "available", "--json"))["devices"]
    runtime, device = select_device(inventory)
    udid = device["udid"]
    prepare_simulator(runtime, device, directory)
    app = ROOT / ".build/xcode/Build/Products/Debug-iphonesimulator/QingRead.app"
    run("xcrun", "simctl", "status_bar", udid, "override", "--time", "9:41", "--dataNetwork", "wifi", "--wifiMode", "active", "--wifiBars", "3", "--batteryState", "charged", "--batteryLevel", "100")
    run("xcrun", "simctl", "ui", udid, "appearance", "light")
    run("xcrun", "simctl", "install", udid, str(app))
    for index, screen in enumerate(["library", "search", "sources", "reader", "recommendations", "categories", "reader-controls", "catalog", "audio", "about"]):
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
        print(launch.strip(), flush=True)
        time.sleep(6)
        markers = {"library": ["QINGREAD_STORAGE_SELFTEST", "QINGREAD_COVER_SELFTEST", "QINGREAD_AI_MODEL_SELFTEST"],
                   "reader": ["QINGREAD_SPEECH_SELFTEST", "QINGREAD_READER_SELFTEST",
                              "QINGREAD_CHAPTER_TURN mode=cover direction=1"]}.get(screen, [])
        if markers:
            output = stdout.read_text() if stdout.exists() else ""
            wait_started = time.monotonic()
            deadline = wait_started + 30
            while not all(marker in output for marker in markers) and time.monotonic() < deadline:
                time.sleep(0.25)
                output = stdout.read_text() if stdout.exists() else ""
            if not all(marker in output for marker in markers):
                missing = [marker for marker in markers if marker not in output]
                errors = stderr.read_text(errors="replace") if stderr.exists() else ""
                print(f"Diagnostics incomplete: screen={screen} launch={launch.strip()} "
                      f"waitSeconds={time.monotonic() - wait_started:.1f} "
                      f"stdoutBytes={stdout.stat().st_size if stdout.exists() else 0} "
                      f"stderrBytes={stderr.stat().st_size if stderr.exists() else 0} "
                      f"missing={missing}", flush=True)
                # Only the public-domain reader preview runs these diagnostics.
                # Surface its crash/marker context without dumping account data
                # from any other preview or from the simulator's app container.
                if screen == "reader":
                    for label, contents in [("reader.stdout.log", output), ("reader.stderr.log", errors)]:
                        tail = "\n".join(contents.splitlines()[-80:])[-12000:]
                        print(f"{label} (last 80 lines, at most 12000 characters):\n{tail or '[empty]'}", flush=True)
                raise SystemExit(f"Missing diagnostics for {screen}; inspect {stdout} and {stderr}")
            print("Verified " + ", ".join(markers), flush=True)
        destination = directory / f"{screen}.png"
        run("xcrun", "simctl", "io", udid, "screenshot", str(destination))
        print(f"Captured {device['name']} / {screen}: {destination}", flush=True)


if __name__ == "__main__":
    main()
