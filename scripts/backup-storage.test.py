#!/usr/bin/env python3
"""Read-only collector regressions; all filesystem/cloud probes are isolated."""
import importlib.util
import json
import os
from pathlib import Path
import subprocess
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


class BackupBreakdownTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.path = Path(self.temp.name)
        self.root = self.path / "repository"
        self.root.mkdir()
        (self.root / "config").write_text("{}")
        self.local = {
            "id": "main", "label": "Main", "kind": "local", "group": "repository",
            "repoId": "main", "path": str(self.root),
        }
        self.config = self.path / "storage.json"

    def browse(self, relative="", location=None, location_id="main"):
        self.config.write_text(json.dumps({"locations": [location or self.local]}))
        return storage.collect_breakdown(location_id, relative, self.config)

    def test_actual_local_files_include_recursive_allocated_sizes(self):
        data = self.root / "data"
        data.mkdir()
        (data / "pack").write_bytes(b"x" * 10000)
        sparse = self.root / "sparse"
        with sparse.open("wb") as stream:
            stream.truncate(10000000)
        result = self.browse()
        expected = int(subprocess.check_output(["du", "-s", "-B1", "--", str(self.root)]).split()[0])
        self.assertEqual(result["errors"], [])
        self.assertEqual(result["totalBytes"], expected)
        self.assertEqual(result["location"]["bytes"], expected)
        self.assertEqual(result["location"]["status"], "ok")
        self.assertEqual(result["entries"][0]["name"], "data")
        self.assertEqual(result["entries"][0]["kind"], "directory")
        self.assertEqual(result["entries"][0]["bytes"], data.stat().st_blocks * 512 + (data / "pack").stat().st_blocks * 512)
        self.assertEqual(next(row for row in result["entries"] if row["name"] == "sparse")["bytes"], sparse.stat().st_blocks * 512)
        self.assertEqual(result["otherBytes"], self.root.stat().st_blocks * 512)
        self.assertNotIn(str(self.root), json.dumps(result))

    def test_nested_folder_reports_its_total_and_whole_instance_total(self):
        nested = self.root / "data" / "aa"
        nested.mkdir(parents=True)
        (nested / "pack").write_bytes(b"x" * 10000)
        result = self.browse("data/aa")
        self.assertEqual(result["errors"], [])
        self.assertEqual(result["relativePath"], "data/aa")
        self.assertEqual(result["entries"][0]["relativePath"], "data/aa/pack")
        self.assertGreater(result["location"]["bytes"], result["totalBytes"])
        self.assertEqual(result["totalBytes"], result["entries"][0]["bytes"] + result["otherBytes"])

    def test_symlink_contents_never_follow_or_escape_root(self):
        outside = self.path / "outside"
        outside.mkdir()
        (outside / "secret").write_bytes(b"x" * 100000)
        (self.root / "escape").symlink_to(outside, target_is_directory=True)
        root_result = self.browse()
        entry = next(row for row in root_result["entries"] if row["name"] == "escape")
        self.assertEqual(entry["kind"], "symlink")
        self.assertEqual(entry["bytes"], (self.root / "escape").lstat().st_blocks * 512)
        for relative in ("escape", "escape/secret"):
            with self.subTest(relative=relative):
                result = self.browse(relative)
                self.assertTrue(result["errors"])
                self.assertEqual(result["entries"], [])
                self.assertNotIn("totalBytes", result)
                self.assertNotIn(str(outside), json.dumps(result))

    def test_symlink_root_and_repository_marker_are_rejected(self):
        alias = self.path / "alias"
        alias.symlink_to(self.root, target_is_directory=True)
        result = self.browse(location={**self.local, "path": str(alias) + "/"})
        self.assertTrue(result["errors"])
        (self.root / "config").unlink()
        (self.path / "marker").write_text("{}")
        (self.root / "config").symlink_to(self.path / "marker")
        result = self.browse()
        self.assertIn("repository", result["errors"][0])

    def test_hardlinks_count_once_and_reconcile_to_total(self):
        (self.root / "a").write_bytes(b"x" * 10000)
        os.link(self.root / "a", self.root / "b")
        result = self.browse()
        entries = {row["name"]: row for row in result["entries"]}
        self.assertEqual(entries["a"]["bytes"], (self.root / "a").stat().st_blocks * 512)
        self.assertEqual(entries["b"]["bytes"], 0)
        self.assertEqual(result["totalBytes"], result["otherBytes"] + sum(row["bytes"] for row in result["entries"]))

    def test_invalid_paths_never_run_a_probe_or_echo_input(self):
        for relative in ("/etc", "../outside", "data/../outside", "data//pack", "./data", "data/", "data\\pack", "bad\nname", "a" * 2049, None):
            with self.subTest(relative=relative), patch.object(storage, "run") as run:
                result = self.browse(relative)
            run.assert_not_called()
            self.assertEqual(result["relativePath"], "")
            self.assertTrue(result["errors"])

    def test_unconfigured_location_id_never_accepts_a_destination(self):
        with patch.object(storage, "run") as run:
            result = self.browse(location_id="secret-remote:sensitive-backup-path")
        run.assert_not_called()
        self.assertIn("not configured", result["errors"][0])
        self.assertNotIn("secret-remote", json.dumps(result))

    def test_missing_and_offline_locations_are_explicit(self):
        missing = self.browse(location={**self.local, "path": str(self.path / "missing")})
        self.assertEqual(missing["location"]["status"], "error")
        self.assertNotIn("totalBytes", missing)
        with patch.object(storage.os.path, "ismount", return_value=False), patch.object(storage, "run") as run:
            offline = self.browse(location={**self.local, "requireMount": str(self.root)})
        run.assert_not_called()
        self.assertEqual(offline["location"]["status"], "offline")
        self.assertTrue(offline["errors"])
        self.assertNotIn("bytes", offline["location"])

    def test_actual_local_entry_limit_retains_largest_and_accounts_for_remainder(self):
        for index in range(202):
            (self.root / ("pack-%03d" % index)).write_bytes(b"x" * (8192 if index == 201 else 4096))
        result = self.browse()
        self.assertTrue(result["truncated"])
        self.assertEqual(len(result["entries"]), 200)
        self.assertEqual(result["entries"][0]["name"], "pack-201")
        self.assertEqual(result["totalBytes"], result["otherBytes"] + sum(row["bytes"] for row in result["entries"]))
        self.assertGreater(result["otherBytes"], self.root.stat().st_blocks * 512)

    def test_scanner_limit_and_unsafe_names_do_not_report_partial_totals(self):
        (self.root / "a").write_text("a")
        with patch.object(storage, "MAX_OBJECTS", 2):
            result = self.browse()
        self.assertIn("limit", result["errors"][0])
        self.assertNotIn("totalBytes", result)
        self.assertEqual(result["entries"], [])
        (self.root / "bad\nname").write_text("a")
        result = self.browse()
        self.assertIn("unsupported", result["errors"][0])
        self.assertNotIn("totalBytes", result)
        self.assertNotIn("bad", json.dumps(result))

    def test_ssh_scanner_quotes_each_argument_and_keeps_verification(self):
        raw_path = "/backup/name with 'quotes' $(touch /tmp/unsafe)"
        raw_relative = "data/also 'quoted' $(whoami)"
        payload = {"entries": [], "totalBytes": 4096, "otherBytes": 4096, "truncated": False}
        with patch.object(storage, "run", side_effect=["8192\t/repo\n", json.dumps(payload)]) as run:
            result = self.browse(raw_relative, {**self.local, "kind": "ssh", "host": "me@nas", "port": 2222, "path": raw_path})
        self.assertEqual(result["errors"], [])
        args = run.call_args.args[0]
        self.assertIn("StrictHostKeyChecking=yes", args)
        self.assertIn("BatchMode=yes", args)
        self.assertIn("ForwardAgent=no", args)
        self.assertEqual(args[-2], "me@nas")
        self.assertEqual(args[args.index("-p") + 1], "2222")
        command = storage.shlex.split(args[-1])
        self.assertEqual(command[:1], ["timeout"])
        self.assertEqual(command[2:4], ["python3", "-c"])
        self.assertEqual(command[5:7], [raw_path, raw_relative])
        self.assertEqual(run.call_args.kwargs["maximum_output"], storage.MAX_LISTING_BYTES)
        self.assertNotIn(raw_path, json.dumps(result))
        self.assertNotIn("me@nas", json.dumps(result))

    def test_cloud_aggregates_immediate_children_largest_first(self):
        objects = [
            {"Path": "config", "Size": 100, "IsDir": False},
            {"Path": "data/aa/pack", "Size": 500, "IsDir": False},
            {"Path": "data/bb/pack", "Size": 300, "IsDir": False},
            {"Path": "index/idx", "Size": 50, "IsDir": False},
        ]
        with patch.object(storage, "run", return_value=json.dumps(objects)) as run:
            result = self.browse(location={**self.local, "kind": "rclone", "path": "secret-cloud:backup"})
        self.assertEqual(result["errors"], [])
        self.assertEqual(result["location"]["bytes"], 950)
        self.assertEqual(result["location"]["objectCount"], 4)
        self.assertEqual(result["entries"][0], {"name": "data", "relativePath": "data", "kind": "directory", "bytes": 800, "objectCount": 2})
        self.assertEqual(result["otherBytes"], 0)
        self.assertEqual(run.call_args.args[0][-2:], ["--", "secret-cloud:backup"])
        self.assertIn("--files-only", run.call_args.args[0])
        self.assertIn("-R", run.call_args.args[0])
        self.assertNotIn("secret-cloud", json.dumps(result))

    def test_cloud_nested_path_uses_only_configured_root(self):
        objects = [{"Path": "aa/pack", "Size": 500, "IsDir": False}]
        with patch.object(storage, "run", side_effect=['{"bytes":950,"count":4}', json.dumps(objects)]) as run:
            result = self.browse("data", {**self.local, "kind": "rclone", "path": "remote:backup"})
        self.assertEqual(result["errors"], [])
        self.assertEqual(result["location"]["bytes"], 950)
        self.assertEqual(result["totalBytes"], 500)
        self.assertEqual(result["entries"][0]["relativePath"], "data/aa")
        self.assertEqual(run.call_args.args[0][-1], "remote:backup/data")

    def test_cloud_top_entries_preserve_full_total(self):
        objects = [{"Path": "pack-%03d" % index, "Size": index, "IsDir": False} for index in range(205)]
        with patch.object(storage, "run", return_value=json.dumps(objects)):
            result = self.browse(location={**self.local, "kind": "rclone", "path": "remote:backup"})
        self.assertEqual(len(result["entries"]), 200)
        self.assertTrue(result["truncated"])
        self.assertEqual(result["entries"][0]["bytes"], 204)
        self.assertEqual(result["totalBytes"], sum(range(205)))
        self.assertEqual(result["otherBytes"], sum(range(5)))

    def test_cloud_invalid_incomplete_and_oversized_listings_are_errors(self):
        for objects in (
            [], [{"Path": "pack", "Size": -1, "IsDir": False}],
            [{"Path": "pack", "Size": True, "IsDir": False}],
            [{"Path": "../secret", "Size": 1, "IsDir": False}],
            [{"Path": "/secret", "Size": 1, "IsDir": False}],
            [{"Path": "a", "Size": 1, "IsDir": False}, {"Path": "a", "Size": 2, "IsDir": False}],
            [{"Path": "a", "Size": 1, "IsDir": False}, {"Path": "a/file", "Size": 2, "IsDir": False}],
        ):
            with self.subTest(objects=objects), patch.object(storage, "run", return_value=json.dumps(objects)):
                result = self.browse(location={**self.local, "kind": "rclone", "path": "secret-cloud:backup"})
            self.assertTrue(result["errors"])
            self.assertNotIn("totalBytes", result)
            self.assertEqual(result["entries"], [])
            self.assertNotIn("secret-cloud", json.dumps(result))
        with patch.object(storage, "MAX_OBJECTS", 1), patch.object(storage, "run", return_value=json.dumps([
            {"Path": "a", "Size": 1, "IsDir": False}, {"Path": "b", "Size": 1, "IsDir": False},
        ])):
            result = self.browse(location={**self.local, "kind": "rclone", "path": "remote:backup"})
        self.assertIn("limit", result["errors"][0])
        self.assertNotIn("totalBytes", result)

    def test_empty_staging_is_measured_and_nested_unavailable_not_invented(self):
        with patch.object(storage, "run", return_value="[]"):
            result = self.browse(location={**self.local, "kind": "rclone", "group": "staging", "path": "remote:stage"})
        self.assertEqual(result["totalBytes"], 0)
        self.assertEqual(result["errors"], [])
        with patch.object(storage, "run", side_effect=['{"bytes":100,"count":1}', "[]"]):
            result = self.browse("missing", {**self.local, "kind": "rclone", "path": "remote:backup"})
        self.assertIn("empty or unavailable", result["errors"][0])
        self.assertNotIn("totalBytes", result)
        self.assertEqual(result["location"]["bytes"], 100)

    def test_bounded_output_terminates_oversized_process_and_redacts_errors(self):
        started = time.monotonic()
        with self.assertRaisesRegex(storage.StorageError, "output limit"):
            storage.run([sys.executable, "-c", "import sys; sys.stdout.write('x' * 1000000)"], 10, maximum_output=100)
        self.assertLess(time.monotonic() - started, 2)
        with self.assertRaisesRegex(storage.StorageError, "access denied") as raised:
            storage.run([sys.executable, "-c", "import sys; sys.stderr.write('permission denied secret-token'); sys.exit(1)"], 10, maximum_output=100)
        self.assertNotIn("secret-token", str(raised.exception))

    def test_bounded_output_timeout_and_expired_budget(self):
        started = time.monotonic()
        with self.assertRaisesRegex(storage.StorageError, "timed out"):
            storage.run([sys.executable, "-c", "import time; time.sleep(10)"], 0.05, maximum_output=100)
        self.assertLess(time.monotonic() - started, 2)
        for probe in (storage.filesystem_breakdown, storage.cloud_breakdown):
            with patch.object(storage, "run") as run, self.assertRaisesRegex(storage.StorageError, "timed out"):
                probe(self.local, "", time.monotonic() - 1)
            run.assert_not_called()


if __name__ == "__main__":
    unittest.main()
