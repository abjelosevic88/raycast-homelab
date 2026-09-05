#!/usr/bin/env python3
"""Read-only collector regressions; all filesystem/cloud probes are isolated."""
import importlib.util
import json
from pathlib import Path
import sys
import tempfile
import time
import unittest
from unittest.mock import patch

sys.dont_write_bytecode = True

spec = importlib.util.spec_from_file_location(
    "backup_storage", Path(__file__).resolve().parents[1] / "assets/backup-storage.py"
)
storage = importlib.util.module_from_spec(spec)
spec.loader.exec_module(storage)


class BackupStorageTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.path = Path(self.temp.name)
        (self.path / "config").write_text("{}")
        self.local = {
            "id": "main", "label": "Main", "kind": "local", "group": "repository",
            "repoId": "main", "path": str(self.path),
        }

    def measure(self, location):
        return storage.measure(location, time.monotonic() + 10)

    def test_allocated_bytes_are_not_logical_snapshot_sizes(self):
        with patch.object(storage, "run", return_value="8192\t/repo\n") as run:
            result = self.measure(self.local)
        self.assertEqual(result["bytes"], 8192)
        self.assertEqual(result["status"], "ok")
        self.assertEqual(run.call_args.args[0], ["du", "-s", "-B1", "--", str(self.path)])

    def test_offline_disk_does_not_report_zero_or_run_mount(self):
        with patch.object(storage.os.path, "ismount", return_value=False), patch.object(storage, "run") as run:
            result = self.measure({**self.local, "requireMount": str(self.path)})
        self.assertEqual(result["status"], "offline")
        self.assertNotIn("bytes", result)
        run.assert_not_called()

    def test_missing_repository_marker_is_an_error(self):
        (self.path / "config").unlink()
        with patch.object(storage, "run") as run:
            result = self.measure(self.local)
        self.assertEqual(result["status"], "error")
        self.assertNotIn("bytes", result)
        run.assert_not_called()

    def test_staging_does_not_require_a_restic_marker(self):
        (self.path / "config").unlink()
        with patch.object(storage, "run", return_value="4096\t/staging\n"):
            result = self.measure({**self.local, "group": "staging"})
        self.assertEqual(result["bytes"], 4096)

    def test_cloud_counts_current_object_bytes(self):
        with patch.object(storage, "run", return_value='{"bytes":1234,"count":8,"sizeless":0}') as run:
            result = self.measure({**self.local, "kind": "rclone", "path": "remote:backup"})
        self.assertEqual(result["bytes"], 1234)
        self.assertEqual(result["objectCount"], 8)
        self.assertEqual(run.call_args.args[0][-2:], ["--", "remote:backup"])

    def test_cloud_unknown_objects_are_not_counted_as_zero(self):
        with patch.object(storage, "run", return_value='{"bytes":1234,"count":8,"sizeless":1}'):
            result = self.measure({**self.local, "kind": "rclone", "path": "remote:backup"})
        self.assertEqual(result["status"], "error")
        self.assertNotIn("bytes", result)

    def test_empty_cloud_replica_is_unavailable_not_zero(self):
        with patch.object(storage, "run", return_value='{"bytes":0,"count":0}'):
            result = self.measure({**self.local, "kind": "rclone", "path": "remote:backup"})
        self.assertEqual(result["status"], "error")
        self.assertNotIn("bytes", result)

    def test_cloud_malformed_sizes_are_rejected(self):
        for body in ('{"bytes":-1,"count":8}', '{"bytes":true,"count":8}', '[]'):
            with self.subTest(body=body), patch.object(storage, "run", return_value=body):
                result = self.measure({**self.local, "kind": "rclone", "path": "remote:backup"})
            self.assertEqual(result["status"], "error")
            self.assertNotIn("bytes", result)

    def test_ssh_quotes_unusual_paths_and_preserves_host_verification(self):
        path = "/backup/name with 'quotes' $(touch /tmp/unsafe)"
        with patch.object(storage, "run", return_value="1024\t/repo\n") as run:
            result = self.measure({**self.local, "kind": "ssh", "host": "me@nas", "path": path})
        args = run.call_args.args[0]
        self.assertIn("StrictHostKeyChecking=yes", args)
        self.assertIn("BatchMode=yes", args)
        self.assertIn("ForwardAgent=no", args)
        self.assertEqual(args[-2], "me@nas")
        # Each remote path remains a single shell token. No shell interpolation.
        self.assertEqual(storage.shlex.split(args[-1])[-1], path)
        self.assertEqual(result["bytes"], 1024)

    def test_ssh_option_injection_and_invalid_mount_guard_rejected(self):
        for override in (
            {"kind": "ssh", "host": "-oProxyCommand=evil"},
            {"kind": "ssh", "host": "nas;touch /tmp/unsafe"},
            {"kind": "ssh", "host": "nas", "port": True},
            {"requireMount": "/different/mount"},
        ):
            with self.subTest(override=override), self.assertRaises(storage.StorageError):
                storage.validate({**self.local, **override})

    def test_failed_probe_does_not_hide_successful_locations(self):
        config = self.path / "storage.json"
        config.write_text(json.dumps({"locations": [self.local, {
            **self.local, "id": "offline", "path": str(self.path / "missing"),
        }]}))
        with patch.object(storage, "run", return_value="4096\t/repo\n"):
            result = storage.collect(config)
        self.assertEqual([row["status"] for row in result["locations"]], ["ok", "error"])
        self.assertNotIn("bytes", result["locations"][1])

    def test_duplicate_locations_cannot_inflate_total(self):
        config = self.path / "storage.json"
        config.write_text(json.dumps({"locations": [self.local, {**self.local, "id": "copy"}]}))
        result = storage.collect(config)
        self.assertEqual(result["locations"], [])
        self.assertIn("duplicate", result["errors"][0])

    def test_configuration_errors_are_visible_and_redacted(self):
        config = self.path / "storage.json"
        config.write_text("sensitive-token = not-json")
        result = storage.collect(config)
        self.assertTrue(result["errors"])
        self.assertNotIn("sensitive-token", json.dumps(result))

    def test_expired_budget_does_not_start_commands(self):
        with patch.object(storage, "run") as run:
            result = storage.measure(self.local, time.monotonic() - 1)
        run.assert_not_called()
        self.assertEqual(result["status"], "error")

    def test_timeout_terminates_command(self):
        started = time.monotonic()
        with self.assertRaisesRegex(storage.StorageError, "timed out"):
            storage.run([sys.executable, "-c", "import time; time.sleep(10)"], 0.05)
        self.assertLess(time.monotonic() - started, 2)


if __name__ == "__main__":
    unittest.main()
