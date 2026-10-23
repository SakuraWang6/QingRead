"""Host-only command orchestration checks; never launch a simulator."""
import contextlib
import importlib.util
import io
from pathlib import Path
import subprocess
import unittest
from unittest.mock import patch

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


if __name__ == "__main__":
    unittest.main()
