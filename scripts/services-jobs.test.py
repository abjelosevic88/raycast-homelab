#!/usr/bin/env python3
"""Behavioral checks for the read-only systemd collector (no host mutations)."""

import contextlib
import importlib.util
import io
import json
from pathlib import Path
import subprocess
import sys
import unittest
from unittest.mock import patch


sys.dont_write_bytecode = True
spec = importlib.util.spec_from_file_location("services_jobs", Path(__file__).resolve().parents[1] / "assets" / "services-jobs.py")
collector = importlib.util.module_from_spec(spec)
spec.loader.exec_module(collector)


def completed(stdout="", stderr="", code=0):
    return subprocess.CompletedProcess([], code, stdout, stderr)


class ParsingTests(unittest.TestCase):
    def test_utc_and_epoch_microseconds_agree(self):
        expected = "2026-09-05T09:10:00.123Z"
        self.assertEqual(collector.timestamp("Sat 2026-09-05 09:10:00.123456 UTC"), expected)
        self.assertEqual(collector.timestamp(1788599400123456), expected)
        self.assertEqual(collector.timestamp("Sat 2026-09-05 09:10:00 UTC"), "2026-09-05T09:10:00.000Z")

    def test_missing_infinite_and_invalid_timestamps_are_null(self):
        for value in (None, "", "n/a", "infinity", "never", 0, "0", -1, True, "18446744073709551615", 10**100, "broken", "Sat 2026-09-05 09:10:00 CEST"):
            with self.subTest(value=value):
                self.assertIsNone(collector.timestamp(value))

    def test_repeated_schedules_and_only_allowed_properties(self):
        props = collector.parse_show("Id=scan.timer\nLoadState=loaded\nTimersMonotonic={ OnBootUSec=5min ; next_elapse=5min }\nTimersMonotonic={ OnUnitActiveUSec=15min ; next_elapse=3w }\nTimersCalendar={ OnCalendar=*-*-* 02:00:00 ; next_elapse=Sun 2026-09-06 02:00:00 UTC }\nEnvironment=SECRET=value\nExecStart=credential\n")
        self.assertEqual(collector.schedule_labels(props["scan.timer"]), ["OnCalendar=*-*-* 02:00:00", "OnBootUSec=5min", "OnUnitActiveUSec=15min"])
        self.assertNotIn("Environment", props["scan.timer"])
        self.assertNotIn("ExecStart", props["scan.timer"])
        self.assertEqual(collector.duration_seconds("1min 500ms"), 60.5)

    def test_not_found_and_template_units_are_omitted(self):
        self.assertEqual(collector.parse_show("Id=missing.service\nLoadState=not-found\n\nId=worker@.service\nLoadState=loaded\n"), {})

    def test_valid_instance_and_escaped_names(self):
        for name in ("jellyfin.service", "user@1000.service", r"app-snap\x2duserd@autostart.service"):
            self.assertTrue(collector.valid_unit(name), name)
        for name in ("../ssh.service", "--all.service", "foo.service;id", "a*.service", "foo\nbar.service", "a.socket", "template@.timer", r"bad\q.service", "a" * 256 + ".service"):
            self.assertFalse(collector.valid_unit(name), name)

    def test_discover_disabled_timers_and_unloaded_enabled_services(self):
        loaded = [{"unit": "running.service", "load": "loaded"}, {"unit": "old.service", "load": "not-found"}]
        files = [
            {"unit_file": "stopped.service", "state": "enabled"},
            {"unit_file": "runtime.service", "state": "enabled-runtime"},
            {"unit_file": "disabled.timer", "state": "disabled"},
            {"unit_file": "masked.timer", "state": "masked"},
            {"unit_file": "optional.service", "state": "disabled"},
            {"unit_file": "alias.timer", "state": "alias"},
            {"unit_file": "template@.timer", "state": "disabled"},
        ]
        names, _ = collector.discover_units(loaded, files)
        self.assertEqual(names, {"running.service", "stopped.service", "runtime.service", "disabled.timer", "masked.timer"})

    def test_never_run_service_has_no_exit_code(self):
        result = collector.service_state("user", "new.service", {"ExecMainStatus": "0", "Result": "success"}, {})
        self.assertIsNone(result["startedAt"])
        self.assertIsNone(result["finishedAt"])
        self.assertIsNone(result["exitCode"])

    def test_recent_check_metadata_describes_latest_attempt(self):
        props = {
            "ExecMainStartTimestamp": "Sat 2026-09-05 09:00:00 UTC",
            "ExecMainExitTimestamp": "Sat 2026-09-05 09:00:01 UTC",
            "Result": "success", "ExecMainStatus": "0",
            "ConditionResult": "no", "ConditionTimestamp": "Sat 2026-09-05 09:05:00 UTC",
            "AssertResult": "yes", "AssertTimestamp": "Sat 2026-09-05 09:05:00 UTC",
        }
        result = collector.service_state("user", "job.service", props, {})
        self.assertFalse(result["conditionResult"])
        self.assertTrue(result["assertResult"])
        self.assertEqual(result["result"], "success")
        self.assertEqual(result["startedAt"], "2026-09-05T09:00:00.000Z")

    def test_check_results_without_timestamps_are_unknown(self):
        for default_value in ("yes", "no"):
            with self.subTest(value=default_value):
                result = collector.service_state("user", "new.service", {"ConditionResult": default_value, "AssertResult": default_value}, {})
                self.assertIsNone(result["conditionResult"])
                self.assertIsNone(result["assertResult"])

    def test_stale_check_results_do_not_override_newer_execution(self):
        props = {
            "ExecMainStartTimestamp": "Sat 2026-09-05 09:10:00 UTC",
            "ConditionResult": "no", "ConditionTimestamp": "Sat 2026-09-05 09:05:00 UTC",
            "AssertResult": "no", "AssertTimestamp": "Sat 2026-09-05 09:05:00 UTC",
        }
        result = collector.service_state("user", "job.service", props, {})
        self.assertIsNone(result["conditionResult"])
        self.assertIsNone(result["assertResult"])

    def test_failed_assertion_before_first_execution_is_reported(self):
        props = {
            "ConditionResult": "yes", "ConditionTimestamp": "Sat 2026-09-05 09:10:00 UTC",
            "AssertResult": "no", "AssertTimestamp": "Sat 2026-09-05 09:10:00 UTC",
        }
        result = collector.service_state("user", "new.service", props, {})
        self.assertTrue(result["conditionResult"])
        self.assertFalse(result["assertResult"])
        self.assertIsNone(result["startedAt"])

    def test_check_at_same_time_as_start_is_valid(self):
        props = {
            "ExecMainStartTimestamp": "Sat 2026-09-05 09:10:00 UTC",
            "ConditionResult": "yes", "ConditionTimestamp": "Sat 2026-09-05 09:10:00 UTC",
            "AssertResult": "yes", "AssertTimestamp": "Sat 2026-09-05 09:10:00 UTC",
        }
        result = collector.service_state("user", "job.service", props, {})
        self.assertTrue(result["conditionResult"])
        self.assertTrue(result["assertResult"])


class InventoryTests(unittest.TestCase):
    def test_monotonic_and_disabled_timers_keep_linked_service_status(self):
        calls = []

        def runner(args):
            calls.append(args)
            if "list-units" in args:
                return completed(json.dumps([{"unit": "scan.timer", "load": "loaded"}]))
            if "list-unit-files" in args:
                return completed(json.dumps([{"unit_file": "scan.timer", "state": "enabled"}, {"unit_file": "old.timer", "state": "disabled"}]))
            if "list-timers" in args:
                return completed(json.dumps([{"unit": "scan.timer", "activates": "scan.service", "next": 1788599400123456, "last": 1788599100123456}, {"unit": "old.timer", "activates": "custom.service", "next": 18446744073709551615, "last": 0}]))
            if "show" in args and "scan.timer" in args:
                return completed("Id=scan.timer\nLoadState=loaded\nActiveState=active\nSubState=waiting\nUnitFileState=enabled\nTriggers=scan.service\nTimersMonotonic={ OnUnitActiveUSec=5min ; next_elapse=3w }\nAccuracyUSec=1min\n\nId=old.timer\nLoadState=loaded\nActiveState=inactive\nTriggers=custom.service\n")
            if "show" in args:
                return completed("Id=scan.service\nLoadState=loaded\nType=oneshot\nResult=success\nExecMainStartTimestamp=Sat 2026-09-05 09:05:00 UTC\nExecMainExitTimestamp=Sat 2026-09-05 09:05:01 UTC\nExecMainStatus=0\n\nId=custom.service\nLoadState=loaded\nType=oneshot\nResult=success\n")
            self.fail("Unexpected call: " + repr(args))

        services, timers = collector.collect_scope(runner, "user")
        scan = next(t for t in timers if t["unit"] == "scan.timer")
        old = next(t for t in timers if t["unit"] == "old.timer")
        self.assertEqual(scan["nextRunAt"], "2026-09-05T09:10:00.123Z")
        self.assertEqual(scan["lastTriggerAt"], "2026-09-05T09:05:00.123Z")
        self.assertEqual(scan["schedule"], ["OnUnitActiveUSec=5min"])
        self.assertEqual(scan["serviceStatus"]["exitCode"], 0)
        self.assertEqual(scan["accuracySeconds"], 60)
        self.assertEqual(old["unitFileState"], "disabled")
        self.assertIsNone(old["nextRunAt"])
        self.assertIsNone(old["lastTriggerAt"])
        self.assertEqual(old["serviceStatus"]["triggeredBy"], ["old.timer"])
        self.assertEqual({s["unit"] for s in services}, {"scan.service", "custom.service"})
        self.assertEqual(len([c for c in calls if "show" in c]), 2)
        for call in calls:
            self.assertEqual(call[0], "systemctl")
            self.assertTrue(any(command in call for command in ("list-units", "list-unit-files", "show", "list-timers")))
            if "show" in call:
                properties = next(arg.split("=", 1)[1].split(",") for arg in call if arg.startswith("--property="))
                self.assertEqual(tuple(properties), collector.PROPERTIES)
                self.assertNotIn("ExecStart", properties)
                self.assertNotIn("Environment", properties)

    def test_partial_scope_failure_is_explicit_and_other_scope_survives(self):
        def scope(_runner, name):
            if name == "user":
                raise collector.CollectionError("User bus unavailable.")
            return [{"scope": "system", "unit": "ssh.service"}], []

        with patch.object(collector, "collect_scope", side_effect=scope):
            result = collector.snapshot(None)
        self.assertEqual(result["services"][0]["unit"], "ssh.service")
        self.assertEqual(result["errors"], [{"scope": "user", "error": "User bus unavailable."}])

    def test_both_failed_scopes_retain_structured_diagnostics(self):
        with patch.object(collector, "collect_scope", side_effect=collector.CollectionError("Bus unavailable.")):
            result = collector.snapshot(None)
        self.assertEqual(result["services"], [])
        self.assertEqual(result["timers"], [])
        self.assertEqual(result["errors"], [{"scope": "user", "error": "Bus unavailable."}, {"scope": "system", "error": "Bus unavailable."}])

    def test_systemctl_failure_does_not_expose_stderr(self):
        with self.assertRaises(collector.CollectionError) as failure:
            collector.systemctl(lambda _args: completed(stderr="SECRET=private", code=1), "user", "list-units")
        self.assertNotIn("SECRET", str(failure.exception))
        self.assertIn("user bus", str(failure.exception))

    def test_old_or_malformed_json_fails_clearly(self):
        for output in ("not-json", "{}", '["unexpected"]'):
            with self.subTest(output=output):
                with self.assertRaisesRegex(collector.CollectionError, "JSON output"):
                    collector.json_list(lambda _args: completed(output), "system", "list-units")


class LogsAndExecutionTests(unittest.TestCase):
    def test_journal_request_is_read_only_scoped_and_bounded(self):
        calls = []

        def runner(args):
            calls.append(args)
            return completed("2026-09-05T09:00:00+0000 host example: Ready\n")

        result = collector.logs(runner, "user", "example.service")
        self.assertEqual(result["unit"], "example.service")
        self.assertIsNone(result["warning"])
        self.assertEqual(calls, [["journalctl", "--user", "--no-pager", "--output=short-iso", "--lines=150", "--since=7 days ago", "--unit=example.service"]])

    def test_log_size_and_terminal_controls_are_bounded(self):
        result = collector.logs(lambda _args: completed("a" * 70000 + "\x1b[31mLAST\x00\n"), "system", "ssh.service")
        self.assertEqual(len(result["text"]), collector.LOG_CHARS)
        self.assertTrue(result["text"].endswith("LAST\n"))
        self.assertNotIn("\x1b", result["text"])
        self.assertIn("truncated", result["warning"])

    def test_permission_denied_is_a_warning_even_on_success(self):
        for code in (0, 1):
            with self.subTest(code=code):
                result = collector.logs(lambda _args: completed("-- No entries --\n", "Hint: You are currently not seeing messages from other users and the system.\nNo journal files were opened due to insufficient permissions.", code), "system", "ssh.service")
                self.assertIn("restricted", result["warning"])

    def test_arbitrary_scope_and_units_never_reach_subprocess(self):
        def forbidden(_args):
            self.fail("Unsafe input reached execution")

        for scope, unit in (("root", "ssh.service"), ("user", "--all.service"), ("system", "ssh.service; whoami")):
            with self.subTest(scope=scope, unit=unit):
                with self.assertRaises(collector.CollectionError):
                    collector.logs(forbidden, scope, unit)

    def test_runner_has_deadlines_no_shell_utc_and_user_bus_bootstrap(self):
        with patch.dict(collector.os.environ, {}, clear=True), patch.object(collector.os, "getuid", return_value=1234):
            runner = collector.Runner()
        with patch.object(collector.subprocess, "run", return_value=completed()) as run:
            runner(["systemctl", "--user", "list-units"])
        kwargs = run.call_args.kwargs
        self.assertFalse(kwargs["shell"])
        self.assertGreater(kwargs["timeout"], 0)
        self.assertLessEqual(kwargs["timeout"], collector.COMMAND_TIMEOUT)
        self.assertEqual(kwargs["env"]["TZ"], "UTC")
        self.assertEqual(kwargs["env"]["XDG_RUNTIME_DIR"], "/run/user/1234")
        self.assertEqual(kwargs["env"]["DBUS_SESSION_BUS_ADDRESS"], "unix:path=/run/user/1234/bus")

    def test_timeout_errors_are_sanitized(self):
        runner = collector.Runner()
        with patch.object(collector.subprocess, "run", side_effect=subprocess.TimeoutExpired("secret command", 7)):
            with self.assertRaisesRegex(collector.CollectionError, "timed out") as failure:
                runner(["systemctl", "--user", "list-units"])
        self.assertNotIn("secret", str(failure.exception))

    def test_cli_error_is_json_on_stderr_with_nonzero_exit(self):
        output, error = io.StringIO(), io.StringIO()
        with contextlib.redirect_stdout(output), contextlib.redirect_stderr(error):
            code = collector.main(["logs", "user", "$(touch marker).service"])
        self.assertEqual(code, 1)
        self.assertEqual(output.getvalue(), "")
        self.assertEqual(json.loads(error.getvalue()), {"error": "Select a valid service or timer unit."})


if __name__ == "__main__":
    unittest.main()
