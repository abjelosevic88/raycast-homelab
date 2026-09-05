#!/usr/bin/env python3
"""Read allocated backup storage; no backup, prune, mount or sync commands.

Configuration: ~/.config/raycast-homelab/backup-storage.json
{"locations": [{"id": "main", "label": "Main backup", "repoId": "main",
  "kind": "local", "group": "repository", "path": "/backups/restic"}]}

SSH locations additionally set host (and optionally port); rclone locations use
their configured remote:path as path. A local requireMount prevents probing an
unmounted removable disk. Repository/replica filesystem locations must contain
the restic config marker. Cloud totals count current objects, not old versions.
"""

import concurrent.futures
import datetime
import json
import os
from pathlib import Path
import re
import shlex
import signal
import subprocess
import time


CONFIG = Path.home() / ".config/raycast-homelab/backup-storage.json"
MAX_LOCATIONS = 32
TOTAL_TIMEOUT = 42
SSH_HOST = re.compile(
    r"^(?:[a-zA-Z0-9_][a-zA-Z0-9_.-]*@)?"
    r"(?:[a-zA-Z0-9_][a-zA-Z0-9_.-]*|\[[a-fA-F0-9:]+\])$"
)


class StorageError(Exception):
    pass


def run(argv, timeout):
    """Bound subprocess lifetime and terminate its process group on timeout."""
    env = dict(os.environ)
    env["PATH"] = str(Path.home() / ".nix-profile/bin") + os.pathsep + env.get(
        "PATH", "/usr/bin:/bin"
    )
    try:
        process = subprocess.Popen(
            argv, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
            text=True, start_new_session=True, env=env,
        )
    except FileNotFoundError:
        raise StorageError("Required measurement tool is unavailable.") from None
    try:
        stdout, stderr = process.communicate(timeout=max(0.1, timeout))
    except subprocess.TimeoutExpired:
        try:
            os.killpg(process.pid, signal.SIGKILL)
        except ProcessLookupError:
            pass
        process.communicate()
        raise StorageError("Storage measurement timed out.") from None
    if process.returncode:
        # Diagnostics never echo paths, remote names or tool output.
        if "host key verification failed" in stderr.lower() or "REMOTE HOST IDENTIFICATION" in stderr:
            message = "SSH host verification failed; trust the NAS host from the server first."
        elif "permission denied" in stderr.lower() or "authentication failed" in stderr.lower():
            message = "Storage access denied; check server permissions or authentication."
        elif process.returncode == 124:
            message = "Storage measurement timed out."
        else:
            message = "Storage measurement failed; check the configured location and connectivity."
        raise StorageError(message)
    return stdout


def safe_text(value, maximum=512):
    return isinstance(value, str) and 0 < len(value) <= maximum and not any(
        ord(char) < 32 or ord(char) == 127 for char in value
    )


def validate(raw):
    if not isinstance(raw, dict):
        raise StorageError("Each storage location must be an object.")
    for field in ("id", "label", "path"):
        if not safe_text(raw.get(field)):
            raise StorageError("A storage location has an invalid id, label or path.")
    if raw.get("kind") not in ("local", "ssh", "rclone"):
        raise StorageError("A storage location has an unsupported kind.")
    if raw.get("group") not in ("repository", "replica", "staging"):
        raise StorageError("A storage location has an unsupported group.")
    if "repoId" in raw and not safe_text(raw["repoId"]):
        raise StorageError("A storage location has an invalid repository id.")
    if raw["kind"] in ("local", "ssh") and not raw["path"].startswith("/"):
        raise StorageError("Filesystem storage locations need an absolute path.")
    if raw["kind"] == "ssh":
        if not isinstance(raw.get("host"), str) or not SSH_HOST.fullmatch(raw["host"]):
            raise StorageError("An SSH storage location has an invalid host.")
        if "port" in raw and (
            type(raw["port"]) is not int or not 1 <= raw["port"] <= 65535
        ):
            raise StorageError("An SSH storage location has an invalid port.")
    if raw["kind"] == "rclone" and not re.fullmatch(r"[\w][\w .-]*:.+", raw["path"]):
        raise StorageError("A cloud location needs a configured rclone remote and path.")
    if "requireMount" in raw:
        mount = raw["requireMount"]
        if raw["kind"] != "local" or not safe_text(mount) or not mount.startswith("/"):
            raise StorageError("Mount guards require an absolute local mount path.")
        if Path(mount) not in Path(raw["path"]).parents and Path(mount) != Path(raw["path"]):
            raise StorageError("A mount guard must contain its storage location.")
    return raw


def measure(raw, deadline):
    location = {
        key: raw[key] for key in ("id", "label", "repoId", "kind", "group") if key in raw
    }
    location["status"] = "error"
    try:
        remaining = deadline - time.monotonic()
        if remaining <= 0:
            raise StorageError("Storage measurement timed out.")
        path = raw["path"]
        if raw["kind"] == "local":
            if raw.get("requireMount") and not os.path.ismount(raw["requireMount"]):
                return {**location, "status": "offline", "error": "Backup disk is not mounted; its size is unavailable."}
            target = Path(path)
            if not target.is_dir() or target.is_symlink():
                raise StorageError("Backup directory is unavailable.")
            if raw["group"] != "staging" and not (target / "config").is_file():
                raise StorageError("Restic repository was not found at this location.")
            output = run(["du", "-s", "-B1", "--", path], min(15, remaining))
        elif raw["kind"] == "ssh":
            args = [
                "ssh", "-T", "-o", "BatchMode=yes", "-o", "StrictHostKeyChecking=yes",
                "-o", "ConnectTimeout=8", "-o", "ConnectionAttempts=1",
                "-o", "ServerAliveInterval=5", "-o", "ServerAliveCountMax=2",
                "-o", "ClearAllForwardings=yes", "-o", "PermitLocalCommand=no",
                "-o", "ForwardAgent=no", "-o", "ForwardX11=no", "-o", "LogLevel=ERROR",
            ]
            if "port" in raw:
                args += ["-p", str(raw["port"])]
            host = re.sub(r"\[([a-fA-F0-9:]+)\]$", r"\1", raw["host"])
            # SSH runs a remote shell: shlex.join protects even unusual paths.
            command = shlex.join(["timeout", "18s", "du", "-s", "-B1", "--", path])
            if raw["group"] != "staging":
                command = shlex.join(["test", "-f", str(Path(path) / "config")]) + " && " + command
            output = run(args + ["--", host, command], min(22, remaining))
        else:
            output = run([
                "rclone", "size", "--json", "--timeout", "12s", "--contimeout", "8s",
                "--retries", "1", "--low-level-retries", "1", "--", path,
            ], min(25, remaining))
            value = json.loads(output)
            size, count = value.get("bytes"), value.get("count")
            if type(size) is not int or size < 0 or type(count) is not int or count < 0:
                raise StorageError("Cloud storage returned an invalid size.")
            if value.get("sizeless", 0):
                raise StorageError("Some cloud objects have unknown sizes; a total is unavailable.")
            if not count and raw["group"] != "staging":
                raise StorageError("No backup objects were found at this cloud location.")
            return {**location, "status": "ok", "bytes": size, "objectCount": count}
        size_text = output.split()[0] if output.split() else ""
        if not size_text.isdigit():
            raise StorageError("Filesystem storage returned an invalid size.")
        return {**location, "status": "ok", "bytes": int(size_text)}
    except (StorageError, OSError, ValueError, TypeError, AttributeError) as error:
        location["error"] = str(error) if isinstance(error, StorageError) else "Could not measure this backup location."
        return location


def collect(config_path=CONFIG):
    result = {
        "collectedAt": datetime.datetime.now(datetime.timezone.utc).isoformat(),
        "locations": [], "errors": [],
    }
    try:
        with open(config_path, encoding="utf-8") as stream:
            contents = stream.read(262145)
        if len(contents) > 262144:
            raise StorageError("Backup storage configuration is too large.")
        config = json.loads(contents)
        raw_locations = config.get("locations") if isinstance(config, dict) else None
        if not isinstance(raw_locations, list) or not 1 <= len(raw_locations) <= MAX_LOCATIONS:
            raise StorageError("Configure between 1 and 32 backup storage locations.")
        locations = [validate(raw) for raw in raw_locations]
        if len({raw["id"] for raw in locations}) != len(locations):
            raise StorageError("Backup storage location ids must be unique.")
        # Reject duplicate locations rather than inflate the displayed totals.
        keys = [(raw["kind"], raw.get("host"), raw.get("port", 22), raw["path"].rstrip("/")) for raw in locations]
        if len(set(keys)) != len(keys):
            raise StorageError("Backup storage configuration contains duplicate locations.")
        deadline = time.monotonic() + TOTAL_TIMEOUT
        with concurrent.futures.ThreadPoolExecutor(max_workers=4) as executor:
            result["locations"] = list(executor.map(lambda raw: measure(raw, deadline), locations))
    except FileNotFoundError:
        result["errors"].append("Create ~/.config/raycast-homelab/backup-storage.json on the Services SSH server to measure backup storage.")
    except (StorageError, OSError, ValueError, TypeError) as error:
        result["errors"].append(str(error) if isinstance(error, StorageError) else "Could not read the server backup storage configuration.")
    return result


if __name__ == "__main__":
    print(json.dumps(collect()))
