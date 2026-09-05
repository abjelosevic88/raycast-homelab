import { environment } from "@raycast/api";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";
import { ConfigError, setting } from "./config";
import {
  ServiceUnit,
  ServicesSnapshot,
  TimerUnit,
  UnitHealth,
  UnitLogs,
  UnitScope,
  UnitState,
} from "./services-types";

const UNIT_NAME = /^[a-zA-Z0-9:_.@\\-]+\.(service|timer)$/;
const TIMEOUT_MS = 30_000;
const MAX_OUTPUT = 4 * 1024 * 1024;

export function hasServicesHost(): boolean {
  return Boolean(setting("servicesSshHost"));
}

export function servicesConnectionKey(): string {
  return createHash("sha256")
    .update(
      JSON.stringify(
        ["servicesSshHost", "servicesSshPort", "servicesSshIdentityFile"].map(
          setting,
        ),
      ),
    )
    .digest("hex");
}

function connectionArgs(): string[] {
  const host = setting("servicesSshHost");
  if (!host)
    throw new ConfigError(
      "Set the Services SSH Host in extension preferences.",
    );
  // SSH receives argv directly, but validates the destination too: no flags, URIs,
  // whitespace, shell syntax, or options smuggled into a username/hostname.
  if (
    !/^(?:[a-zA-Z0-9_][a-zA-Z0-9_.-]*@)?(?:[a-zA-Z0-9_][a-zA-Z0-9_.-]*|\[[a-fA-F0-9:]+\])$/.test(
      host,
    )
  )
    throw new ConfigError(
      "Services SSH Host must be a hostname, SSH alias, or user@host (use brackets for IPv6).",
    );

  const args = [
    "-T",
    "-o",
    "BatchMode=yes",
    "-o",
    "StrictHostKeyChecking=yes",
    "-o",
    "ConnectTimeout=8",
    "-o",
    "ConnectionAttempts=1",
    "-o",
    "ServerAliveInterval=5",
    "-o",
    "ServerAliveCountMax=2",
    "-o",
    "ClearAllForwardings=yes",
    "-o",
    "PermitLocalCommand=no",
    "-o",
    "ForwardAgent=no",
    "-o",
    "ForwardX11=no",
    "-o",
    "RequestTTY=no",
    "-o",
    "LogLevel=ERROR",
  ];
  const port = setting("servicesSshPort");
  if (port) {
    if (!/^\d+$/.test(port) || Number(port) < 1 || Number(port) > 65535)
      throw new ConfigError("Services SSH Port must be between 1 and 65535.");
    args.push("-p", port);
  }
  const identity = setting("servicesSshIdentityFile");
  if (identity) {
    const path = identity.startsWith("~/")
      ? join(homedir(), identity.slice(2))
      : identity;
    if (!isAbsolute(path) || /[\r\n\0]/.test(path))
      throw new ConfigError(
        "Services SSH Identity File must be an absolute path or start with ~/.",
      );
    args.push("-i", path, "-o", "IdentitiesOnly=yes");
  }
  return [...args, "--", host.replace(/\[([a-fA-F0-9:]+)\]$/, "$1")];
}

function sshError(
  error: Error & { code?: string | number | null; killed?: boolean },
  stderr: string,
): Error {
  if (error.code === "ENOENT")
    return new Error(
      "OpenSSH is not installed or ssh is unavailable in Raycast's PATH.",
    );
  if (error.killed)
    return new Error(
      "Services & Jobs request timed out. Check SSH connectivity and the server.",
    );
  if (
    /host key verification failed|REMOTE HOST IDENTIFICATION HAS CHANGED/i.test(
      stderr,
    )
  )
    return new Error(
      "SSH host verification failed. Verify and trust this host in Terminal before connecting from Raycast.",
    );
  if (
    /permission denied|authentication failed|too many authentication failures/i.test(
      stderr,
    )
  )
    return new Error(
      "SSH authentication failed. Set up key or agent access in Terminal, or configure the Services SSH Identity File.",
    );
  if (/python3.*(not found|No such file)/i.test(stderr))
    return new Error("Python 3 is required on the Services & Jobs server.");
  if (
    /could not resolve hostname|connection refused|no route to host|network is unreachable|connection timed out/i.test(
      stderr,
    )
  )
    return new Error(
      "Services & Jobs server is unreachable. Check the SSH host, port and VPN connection.",
    );
  if (error.code === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER")
    return new Error("Services & Jobs response exceeded the output limit.");
  // Do not surface raw SSH output: server login banners and command failures can
  // contain private paths or settings. Collector diagnostics use JSON instead.
  return new Error(
    "Could not read Services & Jobs over SSH. Check Terminal access, Python 3 and systemd on the server.",
  );
}

async function collect(
  args: string[],
  asset = "services-jobs.py",
  timeout = TIMEOUT_MS,
): Promise<unknown> {
  const sshArgs = connectionArgs();
  const source = await readFile(join(environment.assetsPath, asset), "utf8");
  // The SSH protocol takes a remote shell command. Quote each argument even
  // though commands/scopes are fixed and unit names are validated separately.
  const command = ["python3", "-", ...args]
    .map((arg) => `'${arg.replace(/'/g, "'\\''")}'`)
    .join(" ");
  const output = await new Promise<string>((resolve, reject) => {
    const child = execFile(
      "ssh",
      [...sshArgs, command],
      {
        encoding: "utf8",
        timeout,
        killSignal: "SIGKILL",
        maxBuffer: MAX_OUTPUT,
        windowsHide: true,
        env: { ...process.env, SSH_ASKPASS_REQUIRE: "never" },
      },
      (error, stdout, stderr) => {
        if (error) reject(sshError(error, stderr));
        else resolve(stdout);
      },
    );
    // EPIPE occurs if SSH fails before reading the script; the callback reports
    // the useful authentication/connection error instead of crashing Node.
    child.stdin?.on("error", () => {});
    child.stdin?.end(source);
  });
  try {
    return JSON.parse(output);
  } catch {
    throw new Error(
      "Services & Jobs returned invalid JSON. Check Python 3, systemd support and SSH login scripts that print output.",
    );
  }
}

/** The storage collector reads its destination inventory on the SSH server. */
export async function collectBackupStorage(): Promise<unknown> {
  return collect([], "backup-storage.py", 55_000);
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function strings(value: unknown): value is string[] {
  return (
    Array.isArray(value) && value.every((item) => typeof item === "string")
  );
}

function timestamp(value: unknown): boolean {
  return (
    value === null ||
    (typeof value === "string" && Number.isFinite(Date.parse(value)))
  );
}

function unitState(
  value: unknown,
): value is UnitState & Record<string, unknown> {
  return (
    record(value) &&
    (value.scope === "user" || value.scope === "system") &&
    typeof value.unit === "string" &&
    value.unit.length <= 256 &&
    UNIT_NAME.test(value.unit) &&
    [
      "description",
      "loadState",
      "activeState",
      "subState",
      "unitFileState",
    ].every((key) => typeof value[key] === "string")
  );
}

function serviceUnit(value: unknown): value is ServiceUnit {
  return (
    unitState(value) &&
    value.unit.endsWith(".service") &&
    typeof value.type === "string" &&
    typeof value.result === "string" &&
    (value.exitCode === null || Number.isInteger(value.exitCode)) &&
    timestamp(value.startedAt) &&
    timestamp(value.finishedAt) &&
    (value.conditionResult === null ||
      typeof value.conditionResult === "boolean") &&
    (value.assertResult === null || typeof value.assertResult === "boolean") &&
    typeof value.restartCount === "number" &&
    Number.isFinite(value.restartCount) &&
    strings(value.triggeredBy)
  );
}

function timerUnit(value: unknown): value is TimerUnit {
  return (
    unitState(value) &&
    value.unit.endsWith(".timer") &&
    (value.service === null || typeof value.service === "string") &&
    timestamp(value.lastTriggerAt) &&
    timestamp(value.nextRunAt) &&
    strings(value.schedule) &&
    typeof value.persistent === "boolean" &&
    typeof value.accuracySeconds === "number" &&
    Number.isFinite(value.accuracySeconds) &&
    (value.serviceStatus === null || serviceUnit(value.serviceStatus))
  );
}

export async function loadServices(): Promise<ServicesSnapshot> {
  const data = await collect(["snapshot"]);
  if (
    !record(data) ||
    data.version !== 1 ||
    typeof data.host !== "string" ||
    typeof data.collectedAt !== "string" ||
    !timestamp(data.collectedAt) ||
    !Array.isArray(data.services) ||
    !data.services.every(serviceUnit) ||
    !Array.isArray(data.timers) ||
    !data.timers.every(timerUnit) ||
    !Array.isArray(data.errors) ||
    !data.errors.every(
      (e: unknown) =>
        record(e) &&
        (e.scope === "user" || e.scope === "system") &&
        typeof e.error === "string",
    )
  )
    throw new Error(
      "Services & Jobs returned an unsupported snapshot. Update the extension and check the server's systemd version.",
    );
  if (data.errors.length === 2 && !data.services.length && !data.timers.length)
    throw new Error(
      "Cannot read either systemd scope. Check the server's systemd version and SSH user's session bus.",
    );
  return data as unknown as ServicesSnapshot;
}

export async function loadUnitLogs(
  scope: UnitScope,
  unit: string,
): Promise<UnitLogs> {
  if (
    (scope !== "user" && scope !== "system") ||
    unit.length > 256 ||
    !UNIT_NAME.test(unit)
  )
    throw new Error("Invalid service or timer for journal lookup.");
  const data = await collect(["logs", scope, unit]);
  if (
    !record(data) ||
    data.scope !== scope ||
    data.unit !== unit ||
    typeof data.collectedAt !== "string" ||
    !timestamp(data.collectedAt) ||
    typeof data.text !== "string" ||
    !(data.warning === null || typeof data.warning === "string")
  )
    throw new Error(
      "Services & Jobs returned an unsupported journal response.",
    );
  return data as unknown as UnitLogs;
}

function health(
  label: string,
  level: UnitHealth["level"],
  detail: string,
): UnitHealth {
  return {
    label,
    level,
    detail,
    attention: level === "warning" || level === "error",
  };
}

export function serviceHealth(service: ServiceUnit): UnitHealth {
  if (service.loadState !== "loaded")
    return health(
      "Unavailable",
      "error",
      `Unit load state: ${service.loadState}.`,
    );
  if (service.activeState === "failed" || service.subState === "auto-restart")
    return health(
      "Failed",
      "error",
      `Last result: ${service.result || "unknown"}; state: ${service.subState}.`,
    );
  if (service.activeState === "active")
    return service.subState === "exited"
      ? health(
          "Completed",
          "ok",
          "The service completed and remains active after exit.",
        )
      : health("Running", "ok", "The service is active.");
  if (["activating", "reloading", "deactivating"].includes(service.activeState))
    return health(
      service.type === "oneshot"
        ? "Running"
        : service.activeState === "deactivating"
          ? "Stopping"
          : "Starting",
      "info",
      `Current state: ${service.activeState}/${service.subState}.`,
    );
  if (service.assertResult === false || service.result === "assert")
    return health(
      "Assertion failed",
      "error",
      "A systemd assertion prevented execution. Inspect the unit's requirements and recent logs.",
    );
  if (
    service.conditionResult === false ||
    ["condition", "exec-condition"].includes(service.result)
  )
    return health(
      "Skipped",
      "info",
      "A systemd condition prevented execution.",
    );
  if (service.result && service.result !== "success")
    return health(
      "Failed",
      "error",
      `Last result: ${service.result}${service.exitCode === null ? "" : ` (exit status ${service.exitCode})`}.`,
    );
  if (service.type === "oneshot")
    return service.startedAt
      ? health(
          "Succeeded",
          "ok",
          "The last recorded run succeeded; inactive is normal between jobs.",
        )
      : health(
          "Not run",
          "info",
          "No execution is recorded in the current systemd state.",
        );
  if (["enabled", "enabled-runtime"].includes(service.unitFileState))
    return health("Stopped", "warning", "The enabled service is not running.");
  return health(
    "Inactive",
    "info",
    "The service is inactive and is not enabled to start automatically.",
  );
}

export function timerHealth(timer: TimerUnit, now = Date.now()): UnitHealth {
  if (timer.loadState !== "loaded" || timer.activeState === "failed")
    return health(
      "Failed",
      "error",
      `Timer state: ${timer.loadState}/${timer.activeState}.`,
    );
  const service = timer.serviceStatus;
  if (service) {
    const status = serviceHealth(service);
    if (status.level === "error") return status;
  }
  if (timer.activeState !== "active")
    return ["enabled", "enabled-runtime"].includes(timer.unitFileState)
      ? health(
          "Stopped",
          "warning",
          "The enabled timer is not active; scheduled runs will not start.",
        )
      : health(
          "Inactive",
          "info",
          "The timer is inactive; it has no scheduled execution.",
        );
  if (
    service &&
    (["activating", "deactivating", "reloading"].includes(
      service.activeState,
    ) ||
      (service.activeState === "active" && service.subState !== "exited"))
  )
    return health(
      "Running",
      "info",
      "The timer's service is currently running.",
    );
  const next = timer.nextRunAt ? Date.parse(timer.nextRunAt) : NaN;
  if (
    Number.isFinite(next) &&
    now > next + Math.max(60, timer.accuracySeconds) * 1000
  )
    return health(
      "Overdue",
      "warning",
      "The next trigger time has passed beyond the timer accuracy window and a 60-second grace period.",
    );
  if (!timer.nextRunAt)
    return timer.subState === "elapsed"
      ? health(
          "Elapsed",
          "info",
          "This timer has elapsed and has no further run scheduled.",
        )
      : health(
          "No schedule",
          "warning",
          "The active timer has no next execution time; inspect its schedule and logs.",
        );
  if (!service)
    return health(
      "Scheduled",
      "info",
      "A trigger is scheduled; the target service's result is unavailable.",
    );
  return health(
    "Scheduled",
    "ok",
    timer.lastTriggerAt
      ? "The timer is active with a future run scheduled. See last result and recent logs for execution details."
      : "The timer is active with a future run scheduled; no previous trigger is recorded.",
  );
}
