"""Host-only command orchestration checks; never launch a simulator."""
import contextlib
import importlib.util
import io
from pathlib import Path
import subprocess
import tempfile
import unittest
from unittest.mock import Mock, patch

SPEC = importlib.util.spec_from_file_location("qingread_simulator_preview", Path(__file__).with_name("simulator-preview.py"))
preview = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(preview)


class CommandDiagnosticsTests(unittest.TestCase):
    def test_success_preserves_output_arguments_and_timeout_without_logging_private_arguments(self):
        args = ("xcrun", "simctl", "install", "A1234567-1234-1234-1234-123456789ABC", "/Users/example/Private/QingRead.app")
        result = subprocess.CompletedProcess(args, 0, stdout="CLI output\n", stderr="")
        log = io.StringIO()
        with patch.object(preview.subprocess, "run", return_value=result) as child, \
                patch.object(preview.time, "monotonic", side_effect=[10, 10.25]), contextlib.redirect_stdout(log):
            self.assertEqual(preview.run(*args, timeout=17), "CLI output\n")
        child.assert_called_once_with(args, check=True, text=True, capture_output=True, timeout=17)
        self.assertIn("command=simctl install started timeoutSeconds=17", log.getvalue())
        self.assertIn("completed elapsedSeconds=0.2", log.getvalue())
        self.assertNotIn(args[3], log.getvalue())
        self.assertNotIn(args[4], log.getvalue())
        self.assertNotIn("CLI output", log.getvalue())

    def test_nonzero_exit_keeps_original_failure_and_bounds_redacted_diagnostics(self):
        error = subprocess.CalledProcessError(9, ["xcrun", "simctl", "install"],
                                            output="discard-me\n" + "x" * 5000 + " person@example.com /Users/example/private/app",
                                            stderr="device A1234567-1234-1234-1234-123456789ABC failed")
        log = io.StringIO()
        with patch.object(preview.subprocess, "run", side_effect=error) as child, \
                patch.object(preview.time, "monotonic", side_effect=[20, 21.5]), contextlib.redirect_stdout(log):
            with self.assertRaises(subprocess.CalledProcessError) as caught:
                preview.run("xcrun", "simctl", "install")
        self.assertIs(caught.exception, error)
        self.assertEqual(caught.exception.returncode, 9)
        child.assert_called_once()
        output = log.getvalue()
        self.assertIn("failed=CalledProcessError returnCode=9 elapsedSeconds=1.5", output)
        self.assertNotIn("completed", output)
        self.assertNotIn("discard-me", output)
        self.assertNotIn("person@example.com", output)
        self.assertNotIn("/Users/example", output)
        self.assertNotIn("A1234567-1234-1234-1234-123456789ABC", output)
        self.assertIn("[email] [path]", output)
        self.assertIn("[device]", output)
        stdout_tail = output.split("stdout tail (at most 4000 characters):\n", 1)[1].split("\nstderr tail", 1)[0]
        self.assertEqual(len(stdout_tail), preview.ERROR_OUTPUT_LIMIT)

    def test_timeout_preserves_original_failure_and_handles_byte_output(self):
        error = subprocess.TimeoutExpired(["xcrun", "simctl", "launch"], 180,
                                          output=b"partial \xff output", stderr=b"account person@example.com")
        log = io.StringIO()
        with patch.object(preview.subprocess, "run", side_effect=error) as child, \
                patch.object(preview.time, "monotonic", side_effect=[30, 210]), contextlib.redirect_stdout(log):
            with self.assertRaises(subprocess.TimeoutExpired) as caught:
                preview.run("xcrun", "simctl", "launch")
        self.assertIs(caught.exception, error)
        child.assert_called_once_with(("xcrun", "simctl", "launch"), check=True, text=True,
                                      capture_output=True, timeout=180)
        self.assertIn("failed=TimeoutExpired elapsedSeconds=180.0", log.getvalue())
        self.assertIn("partial \ufffd output", log.getvalue())
        self.assertIn("account [email]", log.getvalue())
        self.assertNotIn("completed", log.getvalue())

    def test_missing_tool_still_raises_and_reports_empty_streams(self):
        error = FileNotFoundError("tool unavailable")
        log = io.StringIO()
        with patch.object(preview.subprocess, "run", side_effect=error), \
                patch.object(preview.time, "monotonic", side_effect=[1, 1.1]), contextlib.redirect_stdout(log):
            with self.assertRaises(FileNotFoundError) as caught:
                preview.run("/private/tools/missing-command")
        self.assertIs(caught.exception, error)
        self.assertIn("command=missing-command failed=FileNotFoundError", log.getvalue())
        self.assertNotIn("/private/tools", log.getvalue())
        self.assertEqual(log.getvalue().count("[empty]"), 2)


class SimulatorBootTests(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        self.directory = Path(temporary.name)
        self.runtime = "com.apple.CoreSimulator.SimRuntime.iOS-test"
        self.device = {"name": "iPhone fixture", "udid": "fixture-device", "state": "Shutdown"}

    def timeout(self, command="bootstatus", seconds=600):
        return subprocess.TimeoutExpired(["xcrun", "simctl", command], seconds,
                                         output=b"Waiting for migration", stderr=b"Boot diagnostic")

    def prepare(self, runner, warm=False):
        device = {**self.device, "state": "Booted"} if warm else self.device
        with contextlib.redirect_stdout(io.StringIO()):
            preview.prepare_simulator(self.runtime, device, self.directory, runner)

    def calls(self, runner):
        return [(call.args[2], call.kwargs["timeout"]) for call in runner.call_args_list]

    def test_device_selection_keeps_booted_preference_and_runtime(self):
        active = {**self.device, "udid": "active-device", "state": "Booted"}
        runtime, selected = preview.select_device({"iOS-first": [self.device], "iOS-active": [active]})
        self.assertEqual((runtime, selected), ("iOS-active", active))

    def test_cold_first_ready_wait_allows_migration_without_recovery(self):
        runner = Mock(return_value="Ready")
        self.prepare(runner)
        self.assertEqual(self.calls(runner), [("boot", 60), ("bootstatus", 600)])
        self.assertEqual(runner.call_args.args, ("xcrun", "simctl", "bootstatus", self.device["udid"], "-b"))

    def test_warm_device_only_uses_ordinary_ready_wait(self):
        runner = Mock(return_value="Ready")
        self.prepare(runner, warm=True)
        self.assertEqual(self.calls(runner), [("bootstatus", 300)])

    def test_cold_timeout_recovers_same_device_once_with_ordinary_second_wait(self):
        runner = Mock(side_effect=["", self.timeout(), "", "", "Ready after restart"])
        self.prepare(runner)
        self.assertEqual(self.calls(runner), [("boot", 60), ("bootstatus", 600), ("shutdown", 120),
                                             ("boot", 60), ("bootstatus", 300)])
        self.assertTrue(all(call.args[3] == self.device["udid"] for call in runner.call_args_list))
        log = (self.directory / "simulator-boot.log").read_text()
        self.assertIn("Waiting for migration", log)
        self.assertIn("Boot diagnostic", log)
        self.assertIn("bootstatusAttempt=2", log)

    def test_warm_timeout_does_not_receive_cold_ready_budget(self):
        runner = Mock(side_effect=[self.timeout(seconds=300), "", "", "Ready after restart"])
        self.prepare(runner, warm=True)
        self.assertEqual(self.calls(runner), [("bootstatus", 300), ("shutdown", 120),
                                             ("boot", 60), ("bootstatus", 300)])

    def test_second_timeout_propagates_without_another_recovery(self):
        failure = self.timeout(seconds=300)
        runner = Mock(side_effect=["", self.timeout(), "", "", failure])
        with self.assertRaises(subprocess.TimeoutExpired) as caught:
            self.prepare(runner)
        self.assertIs(caught.exception, failure)
        self.assertEqual(self.calls(runner), [("boot", 60), ("bootstatus", 600), ("shutdown", 120),
                                             ("boot", 60), ("bootstatus", 300)])
        self.assertIn("no further recovery", (self.directory / "simulator-boot.log").read_text())

    def test_shutdown_failure_propagates_and_never_starts_recovery_boot(self):
        failures = [self.timeout("shutdown", 120), subprocess.CalledProcessError(1, ["shutdown"])]
        for failure in failures:
            with self.subTest(failure=type(failure).__name__):
                runner = Mock(side_effect=["", self.timeout(), failure])
                with self.assertRaises(type(failure)) as caught:
                    self.prepare(runner)
                self.assertIs(caught.exception, failure)
                self.assertEqual(self.calls(runner), [("boot", 60), ("bootstatus", 600), ("shutdown", 120)])

    def test_second_non_timeout_failure_is_not_swallowed(self):
        failure = subprocess.CalledProcessError(1, ["bootstatus"], stderr="A real error")
        runner = Mock(side_effect=["", self.timeout(), "", "", failure])
        with self.assertRaises(subprocess.CalledProcessError) as caught:
            self.prepare(runner)
        self.assertIs(caught.exception, failure)
        self.assertEqual(len(runner.call_args_list), 5)

    def test_non_timeout_ready_failure_does_not_trigger_recovery(self):
        failure = subprocess.CalledProcessError(1, ["bootstatus"], stderr="A real error")
        runner = Mock(side_effect=failure)
        with self.assertRaises(subprocess.CalledProcessError) as caught:
            self.prepare(runner, warm=True)
        self.assertIs(caught.exception, failure)
        self.assertEqual(self.calls(runner), [("bootstatus", 300)])
        self.assertIn("A real error", (self.directory / "simulator-boot.log").read_text())

    def test_initial_boot_timeout_is_not_misclassified_as_ready_timeout(self):
        failure = self.timeout("boot", 60)
        runner = Mock(side_effect=failure)
        with self.assertRaises(subprocess.TimeoutExpired) as caught:
            self.prepare(runner)
        self.assertIs(caught.exception, failure)
        self.assertEqual(self.calls(runner), [("boot", 60)])


if __name__ == "__main__":
    unittest.main()
