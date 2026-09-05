#!/usr/bin/env python3
"""Read-only systemd inventory, streamed to the host over SSH; Python stdlib only."""

import datetime as dt
import json
import os
import re
import socket
import subprocess
import sys
import time


UTC = dt.timezone.utc
COMMAND_TIMEOUT = 7
TOTAL_TIMEOUT = 22
LOG_LINES = 150
LOG_CHARS = 65536
UNIT_PATTERN = re.compile(r"[A-Za-z0-9_:.@-]+(?:\\x[0-9A-Fa-f]{2}[A-Za-z0-9_:.@-]*)*\.(?:service|timer)\Z")
# Never request ExecStart, Environment, credentials, or arbitrary unit properties.
PROPERTIES = (
    "Id", "Description", "LoadState", "ActiveState", "SubState", "UnitFileState",
    "Type", "Result", "ExecMainStatus", "ExecMainStartTimestamp",
    "ExecMainExitTimestamp", "NRestarts", "TriggeredBy", "Triggers",
    "ConditionResult", "ConditionTimestamp", "AssertResult", "AssertTimestamp",
    "LastTriggerUSec", "NextElapseUSecRealtime", "TimersCalendar",
    "TimersMonotonic", "Persistent", "AccuracyUSec",
)


class CollectionError(Exception):
    """A safe, user-facing error; subprocess stderr is never forwarded."""


def now_iso():
    return dt.datetime.now(UTC).isoformat(timespec="milliseconds").replace("+00:00", "Z")


def timestamp(value):
    """Parse systemd UTC display timestamps or list-timers epoch microseconds."""
    if value is None or isinstance(value, bool):
        return None
    value = str(value).strip()
    if value in ("", "0", "n/a", "infinity", "never", "18446744073709551615"):
        return None
    try:
        if value.isdigit():
            micros = int(value)
            if micros <= 0:
                return None
            parsed = dt.datetime.fromtimestamp(micros // 1000000, UTC).replace(microsecond=micros % 1000000)
        else:
            parsed = None
            for fmt in ("%a %Y-%m-%d %H:%M:%S UTC", "%a %Y-%m-%d %H:%M:%S.%f UTC"):
                try:
                    parsed = dt.datetime.strptime(value, fmt).replace(tzinfo=UTC)
                    break
                except ValueError:
                    pass
            if parsed is None:
                return None
        return parsed.isoformat(timespec="milliseconds").replace("+00:00", "Z")
    except (ValueError, OverflowError, OSError):
        return None


def duration_seconds(value):
    if not value or value in ("infinity", "n/a"):
        return 0
    scales = {"us": 0.000001, "ms": 0.001, "s": 1, "min": 60, "h": 3600, "d": 86400, "w": 604800}
    return sum(float(amount) * scales[unit] for amount, unit in re.findall(r"([\d.]+)(us|ms|min|s|h|d|w)", value))


def integer(value, default=None):
    try:
        return int(value)
    except (TypeError, ValueError):
        return default


def valid_unit(unit):
    return isinstance(unit, str) and len(unit) <= 255 and not unit.startswith("-") and bool(UNIT_PATTERN.fullmatch(unit)) and "@." not in unit


def check_scope(scope):
    if scope not in ("user", "system"):
        raise CollectionError("Scope must be user or system.")


def clean_text(value):
    # Remove terminal control characters, preserving ordinary log newlines/tabs.
    value = re.sub(r"\x1b\[[0-?]*[ -/]*[@-~]", "", value)
    return re.sub(r"[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]", "", value)


class Runner:
    def __init__(self):
        self.deadline = time.monotonic() + TOTAL_TIMEOUT
        self.env = os.environ.copy()
        self.env.update({"LC_ALL": "C", "LANG": "C", "TZ": "UTC", "SYSTEMD_COLORS": "0", "SYSTEMD_PAGER": "cat"})
        runtime = self.env.setdefault("XDG_RUNTIME_DIR", "/run/user/" + str(os.getuid()))
        self.env.setdefault("DBUS_SESSION_BUS_ADDRESS", "unix:path=" + runtime + "/bus")

    def __call__(self, args):
        remaining = self.deadline - time.monotonic()
        if remaining <= 0:
            raise CollectionError("Systemd inspection exceeded its time limit.")
        try:
            return subprocess.run(args, capture_output=True, text=True, encoding="utf-8", errors="replace", env=self.env, timeout=min(COMMAND_TIMEOUT, remaining), check=False, shell=False)
        except subprocess.TimeoutExpired:
            raise CollectionError("Systemd inspection timed out.") from None
        except FileNotFoundError:
            raise CollectionError("The host requires systemctl and journalctl (systemd).") from None
        except OSError:
            raise CollectionError("Could not execute the host's systemd tools.") from None


def systemctl(runner, scope, *args):
    check_scope(scope)
    result = runner(["systemctl", "--" + scope, "--no-pager", *args])
    if result.returncode:
        if scope == "user":
            raise CollectionError("Cannot read user systemd units; check the SSH user's systemd session and user bus.")
        raise CollectionError("Cannot read system systemd units; check access to the system bus.")
    return result.stdout


def json_list(runner, scope, command, *args):
    try:
        value = json.loads(systemctl(runner, scope, command, *args, "--output=json"))
        if not isinstance(value, list) or not all(isinstance(item, dict) for item in value):
            raise ValueError()
        return value
    except (ValueError, TypeError):
        raise CollectionError("Cannot parse systemd inventory; the host must support systemctl JSON output.") from None


def parse_show(output):
    records = {}
    for block in output.strip().split("\n\n"):
        props = {}
        for line in block.splitlines():
            key, sep, value = line.partition("=")
            if sep and key in PROPERTIES:
                if key in ("TimersCalendar", "TimersMonotonic"):
                    props.setdefault(key, []).append(value)
                else:
                    props[key] = value
        unit = props.get("Id")
        if valid_unit(unit) and props.get("LoadState") != "not-found":
            records[unit] = props
    return records


def discover_units(loaded, files):
    names = {row.get("unit") for row in loaded if valid_unit(row.get("unit")) and row.get("load") != "not-found"}
    file_states = {}
    for row in files:
        name, state = row.get("unit_file"), row.get("state", "")
        if not valid_unit(name) or state == "alias":
            continue
        file_states[name] = state
        if name.endswith(".timer") or state in ("enabled", "enabled-runtime"):
            names.add(name)
    return names, file_states


def common_state(scope, unit, props, file_states):
    return {
        "scope": scope, "unit": unit, "description": props.get("Description", unit),
        "loadState": props.get("LoadState", "unknown"),
        "activeState": props.get("ActiveState", "unknown"),
        "subState": props.get("SubState", "unknown"),
        "unitFileState": props.get("UnitFileState") or file_states.get(unit, ""),
    }


def service_state(scope, unit, props, file_states):
    started = timestamp(props.get("ExecMainStartTimestamp"))
    finished = timestamp(props.get("ExecMainExitTimestamp"))

    def checked_result(kind):
        checked = timestamp(props.get(kind + "Timestamp"))
        value = props.get(kind + "Result")
        if not checked or (started and checked < started) or value not in ("yes", "no"):
            return None
        return value == "yes"

    return {
        **common_state(scope, unit, props, file_states),
        "type": props.get("Type", ""), "result": props.get("Result", ""),
        "exitCode": integer(props.get("ExecMainStatus")) if started or finished else None,
        "startedAt": started, "finishedAt": finished,
        "restartCount": integer(props.get("NRestarts"), 0),
        "triggeredBy": [name for name in props.get("TriggeredBy", "").split() if valid_unit(name)],
        "conditionResult": checked_result("Condition"),
        "assertResult": checked_result("Assert"),
    }


def schedule_labels(props):
    labels = []
    for prop in ("TimersCalendar", "TimersMonotonic"):
        for row in props.get(prop, []):
            label = row.strip().removeprefix("{").split(" ; next_elapse=", 1)[0].strip().removesuffix("}").strip()
            if label:
                labels.append(label)
    return labels


def collect_scope(runner, scope):
    loaded = json_list(runner, scope, "list-units", "--all", "--type=service,timer")
    files = json_list(runner, scope, "list-unit-files", "--type=service,timer")
    names, file_states = discover_units(loaded, files)
    # Loading timer metadata via show does not start a unit. It also discovers disabled timers.
    records = {}
    ordered = sorted(names)
    for offset in range(0, len(ordered), 100):
        records.update(parse_show(systemctl(runner, scope, "show", "--property=" + ",".join(PROPERTIES), *ordered[offset:offset + 100])))
    timer_rows = {row.get("unit"): row for row in json_list(runner, scope, "list-timers", "--all") if valid_unit(row.get("unit"))}
    # Timer Unit= may name a service absent from list-units (including disabled timers).
    related = {name for props in records.values() for name in props.get("Triggers", "").split() if valid_unit(name) and name.endswith(".service")}
    related.update(row.get("activates") for row in timer_rows.values() if valid_unit(row.get("activates")) and row["activates"].endswith(".service"))
    missing = sorted(related - records.keys())
    for offset in range(0, len(missing), 100):
        records.update(parse_show(systemctl(runner, scope, "show", "--property=" + ",".join(PROPERTIES), *missing[offset:offset + 100])))
    services = {name: service_state(scope, name, props, file_states) for name, props in records.items() if name.endswith(".service")}
    timers = []
    for name, props in records.items():
        if not name.endswith(".timer"):
            continue
        row = timer_rows.get(name, {})
        targets = [target for target in props.get("Triggers", "").split() if valid_unit(target) and target.endswith(".service")]
        service = targets[0] if targets else row.get("activates")
        if not valid_unit(service) or not service.endswith(".service"):
            service = None
        status = services.get(service)
        if status and name not in status["triggeredBy"]:
            status["triggeredBy"].append(name)
        timers.append({
            **common_state(scope, name, props, file_states), "service": service,
            "lastTriggerAt": timestamp(row.get("last")) or timestamp(props.get("LastTriggerUSec")),
            "nextRunAt": timestamp(row.get("next")) or timestamp(props.get("NextElapseUSecRealtime")),
            "schedule": schedule_labels(props), "persistent": props.get("Persistent") == "yes",
            "accuracySeconds": duration_seconds(props.get("AccuracyUSec")), "serviceStatus": status,
        })
    return sorted(services.values(), key=lambda item: item["unit"]), sorted(timers, key=lambda item: item["unit"])


def snapshot(runner):
    result = {"version": 1, "host": socket.gethostname(), "collectedAt": now_iso(), "services": [], "timers": [], "errors": []}
    for scope in ("user", "system"):
        try:
            services, timers = collect_scope(runner, scope)
            result["services"].extend(services)
            result["timers"].extend(timers)
        except CollectionError as error:
            result["errors"].append({"scope": scope, "error": str(error)})
    return result


def logs(runner, scope, unit):
    check_scope(scope)
    if not valid_unit(unit):
        raise CollectionError("Select a valid service or timer unit.")
    result = runner(["journalctl", "--" + scope, "--no-pager", "--output=short-iso", "--lines=" + str(LOG_LINES), "--since=7 days ago", "--unit=" + unit])
    error = result.stderr.lower()
    denied = any(term in error for term in ("permission", "access denied", "not seeing messages", "no journal files were opened"))
    if result.returncode and not denied:
        raise CollectionError("Could not read the unit journal; check journal availability on the host.")
    warning = "Journal access is restricted for the SSH user; entries may be missing. Grant journal read access on the host to see this scope." if denied else None
    if result.stderr.strip() and not warning:
        warning = "journalctl reported a warning; some entries may be unavailable."
    output = clean_text(result.stdout)
    if len(output) > LOG_CHARS:
        output = output[-LOG_CHARS:]
        warning = ((warning + " ") if warning else "") + "Log output was truncated to the most recent 64 KiB of text."
    return {"scope": scope, "unit": unit, "collectedAt": now_iso(), "text": output, "warning": warning}


def main(args=None):
    args = sys.argv[1:] if args is None else args
    try:
        runner = Runner()
        if args == ["snapshot"]:
            value = snapshot(runner)
        elif len(args) == 3 and args[0] == "logs":
            value = logs(runner, args[1], args[2])
        else:
            raise CollectionError("Usage: services-jobs.py snapshot | logs <user|system> <unit.service|unit.timer>")
        print(json.dumps(value, ensure_ascii=True))
        return 0
    except CollectionError as error:
        print(json.dumps({"error": str(error)}), file=sys.stderr)
        return 1


if __name__ == "__main__":
    sys.exit(main())
