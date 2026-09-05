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
import selectors
import shlex
import signal
import subprocess
import sys
import time


CONFIG = Path.home() / ".config/raycast-homelab/backup-storage.json"
MAX_LOCATIONS = 32
TOTAL_TIMEOUT = 42
MAX_ENTRIES = 200
MAX_OBJECTS = 50000
MAX_LISTING_BYTES = 16 * 1024 * 1024
SSH_HOST = re.compile(
    r"^(?:[a-zA-Z0-9_][a-zA-Z0-9_.-]*@)?"
    r"(?:[a-zA-Z0-9_][a-zA-Z0-9_.-]*|\[[a-fA-F0-9:]+\])$"
)


class StorageError(Exception):
    pass


def run(argv, timeout, maximum_output=None):
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
        if maximum_output is None:
            stdout, stderr = process.communicate(timeout=max(0.1, timeout))
        else:
            stdout, stderr = bounded_output(process, timeout, maximum_output)
    except StorageError:
        terminate(process)
        raise
    except subprocess.TimeoutExpired:
        try:
            os.killpg(process.pid, signal.SIGKILL)
        except ProcessLookupError:
            pass
        process.communicate()
        raise StorageError("Storage measurement timed out.") from None
    finally:
        process.stdout.close()
        process.stderr.close()
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


def terminate(process):
    try:
        os.killpg(process.pid, signal.SIGKILL)
    except ProcessLookupError:
        pass
    process.communicate()


def bounded_output(process, timeout, maximum_output):
    """Drain both pipes while bounding memory and process lifetime."""
    deadline = time.monotonic() + max(0.1, timeout)
    buffers = {process.stdout: bytearray(), process.stderr: bytearray()}
    with selectors.DefaultSelector() as selector:
        for stream in buffers:
            selector.register(stream, selectors.EVENT_READ)
        while selector.get_map():
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                raise StorageError("Storage measurement timed out.")
            for key, _ in selector.select(min(0.1, remaining)):
                chunk = os.read(key.fileobj.fileno(), 65536)
                if not chunk:
                    selector.unregister(key.fileobj)
                    continue
                buffer = buffers[key.fileobj]
                limit = maximum_output if key.fileobj is process.stdout else 65536
                if len(buffer) + len(chunk) > limit:
                    raise StorageError("Storage listing exceeded the safe output limit; no partial total is available.")
                buffer.extend(chunk)
        try:
            process.wait(timeout=max(0.001, deadline - time.monotonic()))
        except subprocess.TimeoutExpired:
            raise StorageError("Storage measurement timed out.") from None
    try:
        return tuple(bytes(buffers[stream]).decode("utf-8") for stream in (process.stdout, process.stderr))
    except UnicodeDecodeError:
        raise StorageError("Storage listing returned invalid text.") from None


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


def read_locations(config_path):
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
    return locations


def collect(config_path=CONFIG):
    result = {
        "collectedAt": datetime.datetime.now(datetime.timezone.utc).isoformat(),
        "locations": [], "errors": [],
    }
    try:
        locations = read_locations(config_path)
        deadline = time.monotonic() + TOTAL_TIMEOUT
        with concurrent.futures.ThreadPoolExecutor(max_workers=4) as executor:
            result["locations"] = list(executor.map(lambda raw: measure(raw, deadline), locations))
    except FileNotFoundError:
        result["errors"].append("Create ~/.config/raycast-homelab/backup-storage.json on the Services SSH server to measure backup storage.")
    except (StorageError, OSError, ValueError, TypeError) as error:
        result["errors"].append(str(error) if isinstance(error, StorageError) else "Could not read the server backup storage configuration.")
    return result


# The same descriptor-relative scanner runs locally and on the configured NAS.
# O_NOFOLLOW is applied at every descent: a symlink is measured, never opened.
# Its process is bounded by run() as filesystem calls themselves can block.
FILESYSTEM_SCANNER = r'''
import json, os, stat, sys, time

class ScanError(Exception):
    pass

def safe_name(name):
    return (0 < len(name) <= 255 and name not in (".", "..")
            and "/" not in name and "\\" not in name
            and not any(ord(c) < 32 or ord(c) == 127 or 0xd800 <= ord(c) <= 0xdfff for c in name))

def scan(root, relative, group, budget, maximum, entry_limit):
    if relative and (len(relative) > 2048 or any(not safe_name(p) for p in relative.split("/"))):
        raise ScanError("Backup folder path is invalid.")
    deadline = time.monotonic() + budget
    flags = os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW
    root_fd = os.open(root.rstrip("/") or "/", flags)
    seen = set()
    visited = 0

    def checkpoint():
        if time.monotonic() >= deadline:
            raise ScanError("Storage measurement timed out.")

    def amount(info):
        nonlocal visited
        checkpoint()
        visited += 1
        if visited > maximum:
            raise ScanError("Storage listing exceeded the safe object limit; no partial total is available.")
        identity = (info.st_dev, info.st_ino)
        if info.st_nlink > 1 and not stat.S_ISDIR(info.st_mode):
            if identity in seen:
                return 0
            seen.add(identity)
        return info.st_blocks * 512

    def directory(fd, depth=0, include_entries=False):
        checkpoint()
        if depth > 128:
            raise ScanError("Storage folder nesting exceeded the safe limit; no partial total is available.")
        total = amount(os.fstat(fd))
        entries = []
        # Bound a single directory before allocating its full list of names.
        with os.scandir(fd) as stream:
            names = []
            for item in stream:
                checkpoint()
                if len(names) >= maximum:
                    raise ScanError("Storage listing exceeded the safe object limit; no partial total is available.")
                if not safe_name(item.name):
                    raise ScanError("Storage contains an unsupported folder or file name; no partial total is available.")
                names.append(item.name)
        for name in sorted(names):
            checkpoint()
            info = os.stat(name, dir_fd=fd, follow_symlinks=False)
            if stat.S_ISDIR(info.st_mode):
                child = os.open(name, flags, dir_fd=fd)
                try:
                    opened = os.fstat(child)
                    if (opened.st_dev, opened.st_ino) != (info.st_dev, info.st_ino):
                        raise ScanError("Backup folder changed during measurement; refresh to retry.")
                    size, _ = directory(child, depth + 1)
                finally:
                    os.close(child)
                kind = "directory"
            elif stat.S_ISREG(info.st_mode) or stat.S_ISLNK(info.st_mode):
                size = amount(info)
                kind = "symlink" if stat.S_ISLNK(info.st_mode) else "file"
            else:
                raise ScanError("Storage contains an unsupported file type; no partial total is available.")
            total += size
            if include_entries:
                entries.append({"name": name, "relativePath": relative + "/" + name if relative else name,
                                "kind": kind, "bytes": size})
        return total, entries

    try:
        if group != "staging":
            try:
                marker = os.stat("config", dir_fd=root_fd, follow_symlinks=False)
            except FileNotFoundError:
                raise ScanError("Restic repository was not found at this location.") from None
            if not stat.S_ISREG(marker.st_mode):
                raise ScanError("Restic repository was not found at this location.")
        target_fd = os.dup(root_fd)
        try:
            for component in relative.split("/") if relative else []:
                child = os.open(component, flags, dir_fd=target_fd)
                os.close(target_fd)
                target_fd = child
            total, entries = directory(target_fd, include_entries=True)
        finally:
            os.close(target_fd)
    finally:
        os.close(root_fd)
    entries.sort(key=lambda row: (-row["bytes"], row["name"]))
    truncated = len(entries) > entry_limit
    entries = entries[:entry_limit]
    return {"entries": entries, "totalBytes": total,
            "otherBytes": total - sum(row["bytes"] for row in entries), "truncated": truncated}

try:
    result = scan(sys.argv[1], sys.argv[2], sys.argv[3], float(sys.argv[4]), int(sys.argv[5]), int(sys.argv[6]))
except ScanError as error:
    result = {"error": str(error)}
except PermissionError:
    result = {"error": "Storage access denied; check server permissions or authentication."}
except OSError:
    result = {"error": "Backup folder is unavailable, changed, or is a symlink; refresh to retry."}
except Exception:
    result = {"error": "Could not read the backup folder."}
print(json.dumps(result))
'''


def validate_relative_path(value):
    if value == "":
        return value
    if not safe_text(value, 2048) or "\\" in value or any(
        component in ("", ".", "..") or len(component) > 255
        or any(0xd800 <= ord(char) <= 0xdfff for char in component)
        for component in value.split("/")
    ):
        raise StorageError("Backup folder path is invalid.")
    return value


def ssh_arguments(raw):
    args = [
        "ssh", "-T", "-o", "BatchMode=yes", "-o", "StrictHostKeyChecking=yes",
        "-o", "ConnectTimeout=8", "-o", "ConnectionAttempts=1",
        "-o", "ServerAliveInterval=5", "-o", "ServerAliveCountMax=2",
        "-o", "ClearAllForwardings=yes", "-o", "PermitLocalCommand=no",
        "-o", "ForwardAgent=no", "-o", "ForwardX11=no", "-o", "LogLevel=ERROR",
    ]
    if "port" in raw:
        args += ["-p", str(raw["port"])]
    return args + ["--", re.sub(r"\[([a-fA-F0-9:]+)\]$", r"\1", raw["host"])]


def filesystem_breakdown(raw, relative_path, deadline):
    remaining = deadline - time.monotonic()
    if remaining <= 0:
        raise StorageError("Storage measurement timed out.")
    budget = min(32, remaining)
    script_args = [
        "-c", FILESYSTEM_SCANNER, raw["path"], relative_path, raw["group"],
        str(max(0.1, budget - 1)), str(MAX_OBJECTS), str(MAX_ENTRIES),
    ]
    if raw["kind"] == "ssh":
        # Both the configured root and relative path are individual shell tokens.
        command = shlex.join(["timeout", str(max(1, int(budget))) + "s", "python3"] + script_args)
        argv = ssh_arguments(raw) + [command]
    else:
        argv = [sys.executable] + script_args
    value = json.loads(run(argv, budget, maximum_output=MAX_LISTING_BYTES))
    if not isinstance(value, dict):
        raise StorageError("Storage listing returned invalid data.")
    if value.get("error"):
        # The helper emits only fixed, redacted messages.
        allowed = {
            "Backup folder path is invalid.", "Storage measurement timed out.",
            "Storage listing exceeded the safe object limit; no partial total is available.",
            "Storage folder nesting exceeded the safe limit; no partial total is available.",
            "Storage contains an unsupported folder or file name; no partial total is available.",
            "Backup folder changed during measurement; refresh to retry.",
            "Storage contains an unsupported file type; no partial total is available.",
            "Restic repository was not found at this location.",
            "Storage access denied; check server permissions or authentication.",
            "Backup folder is unavailable, changed, or is a symlink; refresh to retry.",
            "Could not read the backup folder.",
        }
        raise StorageError(value["error"] if value["error"] in allowed else "Could not read the backup folder.")
    entries = value.get("entries")
    if not isinstance(entries, list) or len(entries) > MAX_ENTRIES:
        raise StorageError("Storage listing returned invalid data.")
    for entry in entries:
        if not isinstance(entry, dict) or entry.get("kind") not in ("directory", "file", "symlink"):
            raise StorageError("Storage listing returned invalid data.")
        name = entry.get("name")
        if not safe_text(name, 255) or "/" in name:
            raise StorageError("Storage listing returned an invalid name.")
        path = validate_relative_path(entry.get("relativePath"))
        if path != (relative_path + "/" if relative_path else "") + name:
            raise StorageError("Storage listing returned an invalid path.")
        if type(entry.get("bytes")) is not int or entry["bytes"] < 0:
            raise StorageError("Storage listing returned an invalid size.")
    total, other = value.get("totalBytes"), value.get("otherBytes")
    if (type(total) is not int or total < 0 or type(other) is not int or other < 0
            or total != other + sum(entry["bytes"] for entry in entries)
            or type(value.get("truncated")) is not bool):
        raise StorageError("Storage listing returned an invalid total.")
    return {"entries": [{key: entry[key] for key in ("name", "relativePath", "kind", "bytes")} for entry in entries],
            "totalBytes": total, "otherBytes": other, "truncated": value["truncated"]}


def cloud_breakdown(raw, relative_path, deadline):
    remaining = deadline - time.monotonic()
    if remaining <= 0:
        raise StorageError("Storage measurement timed out.")
    destination = raw["path"].rstrip("/") + ("/" + relative_path if relative_path else "")
    # rclone documents Path as relative to the requested location. Sizes count
    # current objects only; no historical versions or provider billing overhead.
    output = run([
        "rclone", "lsjson", "-R", "--files-only", "--no-modtime", "--no-mimetype",
        "--timeout", "12s", "--contimeout", "8s", "--retries", "1",
        "--low-level-retries", "1", "--", destination,
    ], min(32, remaining), maximum_output=MAX_LISTING_BYTES)
    objects = json.loads(output)
    if not isinstance(objects, list):
        raise StorageError("Cloud storage returned an invalid listing.")
    if len(objects) > MAX_OBJECTS:
        raise StorageError("Storage listing exceeded the safe object limit; no partial total is available.")
    if not objects and (relative_path or raw["group"] != "staging"):
        raise StorageError("No backup objects were found in this cloud folder; it may be empty or unavailable.")
    children, seen, total = {}, set(), 0
    for item in objects:
        if time.monotonic() >= deadline:
            raise StorageError("Storage measurement timed out.")
        if not isinstance(item, dict) or item.get("IsDir") is not False:
            raise StorageError("Cloud storage returned an invalid object.")
        path = validate_relative_path(item.get("Path"))
        if not path or path in seen:
            raise StorageError("Cloud storage returned duplicate or invalid objects.")
        seen.add(path)
        size = item.get("Size")
        if type(size) is not int or size < 0:
            raise StorageError("Some cloud objects have unknown sizes; a total is unavailable.")
        name = path.split("/", 1)[0]
        kind = "directory" if "/" in path else "file"
        child_path = validate_relative_path((relative_path + "/" if relative_path else "") + name)
        child = children.setdefault(name, {
            "name": name, "relativePath": child_path,
            "kind": kind, "bytes": 0, "objectCount": 0,
        })
        if child["kind"] != kind:
            raise StorageError("Cloud storage contains overlapping file and folder names; a breakdown is unavailable.")
        child["bytes"] += size
        child["objectCount"] += 1
        total += size
    entries = sorted(children.values(), key=lambda row: (-row["bytes"], row["name"]))[:MAX_ENTRIES]
    return {"entries": entries, "totalBytes": total, "objectCount": len(objects),
            "otherBytes": total - sum(entry["bytes"] for entry in entries), "truncated": len(children) > MAX_ENTRIES}


def collect_breakdown(location_id, relative_path, config_path=CONFIG):
    result = {
        "collectedAt": datetime.datetime.now(datetime.timezone.utc).isoformat(),
        "relativePath": "", "entries": [], "truncated": False, "errors": [],
    }
    try:
        if not safe_text(location_id):
            raise StorageError("Backup storage location id is invalid.")
        result["relativePath"] = validate_relative_path(relative_path)
        raw = next((row for row in read_locations(config_path) if row["id"] == location_id), None)
        if raw is None:
            raise StorageError("Backup storage location is not configured on the server.")
        result["location"] = {
            key: raw[key] for key in ("id", "label", "repoId", "kind", "group") if key in raw
        }
        result["location"]["status"] = "error"
        if raw.get("requireMount") and not os.path.ismount(raw["requireMount"]):
            result["location"].update({"status": "offline", "error": "Backup disk is not mounted; its size is unavailable."})
            result["errors"].append(result["location"]["error"])
            return result
        deadline = time.monotonic() + TOTAL_TIMEOUT
        if relative_path:
            result["location"] = measure(raw, deadline)
            if result["location"]["status"] != "ok":
                raise StorageError(result["location"].get("error", "Backup storage location is unavailable."))
        data = (cloud_breakdown if raw["kind"] == "rclone" else filesystem_breakdown)(raw, relative_path, deadline)
        result.update({key: data[key] for key in ("entries", "totalBytes", "otherBytes", "truncated")})
        if not relative_path:
            result["location"].update({"status": "ok", "bytes": data["totalBytes"]})
            if "objectCount" in data:
                result["location"]["objectCount"] = data["objectCount"]
    except FileNotFoundError:
        result["errors"].append("Backup storage configuration is unavailable on the server.")
    except (StorageError, OSError, ValueError, TypeError, AttributeError) as error:
        result["errors"].append(str(error) if isinstance(error, StorageError) else "Could not read this backup folder.")
    if result["errors"] and result.get("location", {}).get("status") == "error":
        result["location"]["error"] = result["errors"][0]
    return result


if __name__ == "__main__":
    if len(sys.argv) == 1:
        print(json.dumps(collect()))
    elif len(sys.argv) == 4 and sys.argv[1] == "breakdown":
        print(json.dumps(collect_breakdown(sys.argv[2], sys.argv[3])))
    else:
        print(json.dumps({"errors": ["Use backup-storage.py or backup-storage.py breakdown LOCATION_ID RELATIVE_PATH."]}))
