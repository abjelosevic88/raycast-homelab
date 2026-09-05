import { createHash } from "node:crypto";
import { CronExpressionParser } from "cron-parser";
import { ConfigError, requireUrl, setting } from "./config";
import {
  BackupHealthSnapshot,
  BackupPlan,
  BackupRepository,
  BackupRun,
  BackupStatus,
} from "./backups-types";

type Json = Record<string, unknown>;
interface Schedule {
  disabled?: boolean;
  cron?: string;
  maxFrequencyDays?: number;
  maxFrequencyHours?: number;
}
interface PlanConfig {
  id: string;
  repo: string;
  schedule: Schedule;
}
interface RepoConfig {
  id: string;
  guid: string;
  checkSchedule: Schedule;
  checkMode: string;
}
interface Operation extends BackupRun {
  id: string;
  planId: string;
  kind: string;
  dryRun: boolean;
  storedBytes?: number;
  snapshotCount?: number;
  snapshotBytes?: number;
}

const TIMEOUT_MS = 15_000;
const MAX_BYTES = 16 * 1024 * 1024;
const HOUR = 3_600_000;
const STATUS = [
  "STATUS_UNKNOWN",
  "STATUS_PENDING",
  "STATUS_INPROGRESS",
  "STATUS_SUCCESS",
  "STATUS_ERROR",
  "STATUS_SYSTEM_CANCELLED",
  "STATUS_USER_CANCELLED",
  "STATUS_WARNING",
];
const ACTIVE = new Set(["STATUS_PENDING", "STATUS_INPROGRESS"]);
let session: { key: string; token: string; at: number } | undefined;
let loggingIn: { key: string; promise: Promise<string> } | undefined;

function record(value: unknown): Json {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error(
      "Backrest returned an unsupported response. Check the server version.",
    );
  return value as Json;
}
function optionalRecord(value: unknown): Json {
  return value === undefined ? {} : record(value);
}
function rows(value: unknown): Json[] {
  if (value === undefined) return [];
  if (!Array.isArray(value))
    throw new Error("Backrest returned an unsupported list.");
  return value.map(record);
}
function number(value: unknown): number | undefined {
  if ((typeof value !== "number" && typeof value !== "string") || value === "")
    return undefined;
  const n = Number(value);
  return Number.isSafeInteger(n) && n >= 0 ? n : undefined;
}
function time(value: unknown): number | undefined {
  const n = number(value);
  return n && n <= 8.64e15 ? n : undefined;
}
function id(value: unknown): string {
  if (typeof value !== "string" || !value.trim())
    throw new Error("Backrest configuration contains an entry without an ID.");
  return value;
}

export function backupConnectionKey(): string {
  return createHash("sha256")
    .update(
      JSON.stringify(
        [
          "backrestUrl",
          "backrestUsername",
          "backrestPassword",
          "backrestGraceHours",
        ].map(setting),
      ),
    )
    .digest("hex");
}

function baseUrl(): string {
  const raw = requireUrl("backrestUrl", "Backrest");
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new ConfigError("Backrest needs an HTTP(S) base URL.");
  }
  if (
    !["http:", "https:"].includes(url.protocol) ||
    url.username ||
    url.password ||
    url.search ||
    url.hash
  )
    throw new ConfigError(
      "Backrest needs an HTTP(S) base URL without credentials, query or fragment.",
    );
  return raw;
}

async function request(
  path: string,
  body: unknown,
  token?: string,
): Promise<Response> {
  const url = baseUrl();
  try {
    return await fetch(`${url}/v1.${path}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
      body: JSON.stringify(body),
      redirect: "manual",
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch (e) {
    if (
      e instanceof Error &&
      (e.name === "TimeoutError" || e.name === "AbortError")
    )
      throw new Error("Backrest request timed out. Check server connectivity.");
    throw new Error(
      "Backrest is unreachable. Check its URL and your VPN connection.",
    );
  }
}

async function responseJson(response: Response): Promise<Json> {
  if (!response.ok) {
    await response.body?.cancel();
    if (response.status === 401)
      throw new Error(
        "Backrest authentication failed. Check the username and password.",
      );
    if (response.status === 403)
      throw new Error(
        "Backrest access denied. Check this account's permissions.",
      );
    if (response.status >= 300 && response.status < 400)
      throw new Error(
        "Backrest redirected the API request. Configure the direct service URL and authentication.",
      );
    throw new Error(`Backrest API returned HTTP ${response.status}.`);
  }
  const reader = response.body?.getReader();
  if (!reader) throw new Error("Backrest returned an empty response.");
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_BYTES)
        throw new Error(
          "Backrest history exceeds the 16 MiB response limit; health could not be determined.",
        );
      chunks.push(value);
    }
  } catch (e) {
    await reader.cancel().catch(() => {});
    if (e instanceof Error && e.message.includes("16 MiB")) throw e;
    throw new Error("Backrest response was interrupted or timed out.");
  } finally {
    reader.releaseLock();
  }
  try {
    return record(JSON.parse(Buffer.concat(chunks).toString("utf8")));
  } catch {
    throw new Error(
      "Backrest returned invalid JSON. Check the service URL and server version.",
    );
  }
}

async function login(): Promise<string> {
  const key = backupConnectionKey();
  const password = setting("backrestPassword");
  if (!password)
    throw new ConfigError(
      "Backrest password is not set. Configure the extension's Backrest credentials.",
    );
  if (session?.key === key && Date.now() - session.at < 25 * 60_000)
    return session.token;
  if (loggingIn?.key === key) return loggingIn.promise;
  const promise = (async () => {
    const body = await responseJson(
      await request("Authentication/Login", {
        username: setting("backrestUsername") || "admin",
        password,
      }),
    );
    if (typeof body.token !== "string" || !body.token)
      throw new Error("Backrest login returned no session token.");
    session = { key, token: body.token, at: Date.now() };
    return body.token;
  })();
  loggingIn = { key, promise };
  try {
    return await promise;
  } finally {
    if (loggingIn?.promise === promise) loggingIn = undefined;
  }
}

async function rpc(method: string, body: unknown = {}): Promise<Json> {
  const token = await login();
  let response = await request(`Backrest/${method}`, body, token);
  if (response.status === 401) {
    await response.body?.cancel();
    if (session?.token === token) session = undefined;
    response = await request(`Backrest/${method}`, body, await login());
  }
  return responseJson(response);
}

function schedule(value: unknown): Schedule {
  const s = optionalRecord(value);
  return {
    disabled: s.disabled === true,
    cron: typeof s.cron === "string" ? s.cron : undefined,
    maxFrequencyDays: number(s.maxFrequencyDays),
    maxFrequencyHours: number(s.maxFrequencyHours),
  };
}
function enabled(s: Schedule): boolean {
  return (
    !s.disabled && Boolean(s.cron || s.maxFrequencyDays || s.maxFrequencyHours)
  );
}
function scheduleLabel(s: Schedule): string {
  if (!enabled(s)) return "Manual / schedule disabled";
  if (s.cron) return `Cron: ${s.cron} (Backrest server clock)`;
  if (s.maxFrequencyDays) return `Every ${s.maxFrequencyDays} day(s)`;
  return `Every ${s.maxFrequencyHours} hour(s)`;
}

/** A display-grade age bound, following Backrest's eight-gap nominal-period approach.
 * No exact wall-clock schedule is inferred in the Mac's timezone. Next runs come from Backrest.
 */
function nominalPeriod(s: Schedule, now: number): number | undefined {
  if (!enabled(s)) return undefined;
  if (s.maxFrequencyHours) return s.maxFrequencyHours * HOUR;
  if (s.maxFrequencyDays) return s.maxFrequencyDays * 24 * HOUR;
  try {
    // Backrest's six-field grammar ends with a year; cron-parser's starts with seconds.
    // Only the shared five-field grammar is accepted, never silently reinterpreted.
    if (!s.cron || s.cron.trim().split(/\s+/).length !== 5) return undefined;
    const expr = CronExpressionParser.parse(s.cron, {
      currentDate: now,
      tz: "UTC",
    });
    let prev = expr.next().getTime();
    let longest = 0;
    for (let i = 0; i < 8; i++) {
      const next = expr.next().getTime();
      longest = Math.max(longest, next - prev);
      prev = next;
    }
    return longest || undefined;
  } catch {
    return undefined;
  }
}

function health(
  label: string,
  level: BackupStatus["level"],
  detail: string,
): BackupStatus {
  return {
    label,
    level,
    detail,
    attention: level === "warning" || level === "error",
  };
}
function run(op?: Operation): BackupRun | undefined {
  return op
    ? { startedAt: op.startedAt, finishedAt: op.finishedAt, status: op.status }
    : undefined;
}
function completed(ops: Operation[]): Operation[] {
  return ops.filter((o) => !ACTIVE.has(o.status));
}
function success(ops: Operation[]): Operation | undefined {
  return ops.find((o) => o.status === "STATUS_SUCCESS");
}
function completedAt(op?: Operation): number | undefined {
  return op ? op.finishedAt || op.startedAt : undefined;
}

function operationHealth(
  ops: Operation[],
  sched: Schedule,
  now: number,
  grace: number,
  check = false,
): BackupStatus {
  const noun = check ? "check" : "backup";
  const latest = completed(ops)[0];
  const good = success(ops);
  const running = ops.some((o) => o.status === "STATUS_INPROGRESS");
  if (latest && latest.status !== "STATUS_SUCCESS") {
    const label =
      latest.status === "STATUS_WARNING"
        ? "Warnings"
        : latest.status.includes("CANCELLED")
          ? "Cancelled"
          : "Failed";
    return health(
      `${label}${running ? " · running" : ""}`,
      latest.status === "STATUS_ERROR" ? "error" : "warning",
      `The latest completed ${noun} ${label.toLowerCase()}. Open Backrest for its logs. Earlier successful runs do not clear this result.`,
    );
  }
  if (!enabled(sched))
    return health(
      running ? "Running" : check ? "No check scheduled" : "Manual",
      "info",
      `${scheduleLabel(sched)}. ${good ? `Last successful ${noun} is shown; no freshness deadline is applied.` : `No successful ${noun} is recorded.`}`,
    );
  if (!good)
    return health(
      running
        ? "First run in progress"
        : check
          ? "Never verified"
          : "Never run",
      "warning",
      `No successful ${noun} is recorded for this configured schedule.`,
    );
  const period = nominalPeriod(sched, now);
  if (!period)
    return health(
      "Freshness unknown",
      "warning",
      `The ${noun} schedule cannot be evaluated. Check its next run in Backrest.`,
    );
  const overdue = now > (completedAt(good) ?? 0) + period + grace;
  if (overdue)
    return health(
      `Overdue${running ? " · running" : ""}`,
      "warning",
      `Last successful ${noun} is older than the schedule's nominal maximum interval (${(period / HOUR).toFixed(1)} hours) plus ${(grace / HOUR).toFixed(1)} hours grace.`,
    );
  return health(
    running ? "Running" : check ? "Verified" : "Current",
    running ? "info" : "ok",
    `Last successful ${noun} is within the schedule's nominal interval plus ${(grace / HOUR).toFixed(1)} hours grace.`,
  );
}

function parseOperations(body: Json): Operation[] {
  return rows(body.operations)
    .map((o) => {
      const payload = o.op === undefined ? o : record(o.op);
      const kind =
        ["operationBackup", "operationCheck", "operationStats"].find(
          (k) => k in payload,
        ) || "other";
      const detail = optionalRecord(payload[kind]);
      const stats = optionalRecord(detail.stats);
      const summary = optionalRecord(optionalRecord(detail.lastStatus).summary);
      const startedAt = time(o.unixTimeStartMs);
      if (kind !== "other" && !startedAt)
        throw new Error(
          "Backrest returned an operation without a valid timestamp.",
        );
      return {
        id: String(o.id ?? ""),
        planId: typeof o.planId === "string" ? o.planId : "",
        startedAt: startedAt ?? 0,
        finishedAt: time(o.unixTimeEndMs),
        status:
          typeof o.status === "number"
            ? STATUS[o.status] || "STATUS_UNKNOWN"
            : String(o.status || "STATUS_UNKNOWN"),
        kind,
        dryRun: detail.dryRun === true,
        storedBytes: number(stats.totalSize),
        snapshotCount: number(stats.snapshotCount),
        snapshotBytes: number(summary.totalBytesProcessed),
      };
    })
    .sort((a, b) => b.startedAt - a.startedAt);
}

async function configuration(): Promise<{
  plans: PlanConfig[];
  repos: RepoConfig[];
  instanceId?: string;
}> {
  const body = await rpc("GetConfig");
  // GetConfig contains repository passwords, hooks, auth hashes and environment values.
  // Only this allowlist leaves this function or reaches Raycast's persistent cache.
  const plans = rows(body.plans).map((p) => ({
    id: id(p.id),
    repo: id(p.repo),
    schedule: schedule(p.schedule),
  }));
  const repos = rows(body.repos).map((r) => {
    const policy = optionalRecord(r.checkPolicy);
    const pct =
      typeof policy.readDataSubsetPercent === "number"
        ? policy.readDataSubsetPercent
        : undefined;
    return {
      id: id(r.id),
      guid: typeof r.guid === "string" ? r.guid : "",
      checkSchedule: schedule(policy.schedule),
      checkMode:
        policy.structureOnly === true
          ? "Structure only (current policy)"
          : pct !== undefined
            ? `${pct}% of repository data (current policy)`
            : "Backrest default / mode not recorded",
    };
  });
  if (
    new Set(plans.map((p) => p.id)).size !== plans.length ||
    new Set(repos.map((r) => r.id)).size !== repos.length
  )
    throw new Error("Backrest configuration contains duplicate IDs.");
  return {
    plans,
    repos,
    instanceId:
      typeof body.instance === "string"
        ? body.instance
        : typeof body.instanceId === "string"
          ? body.instanceId
          : undefined,
  };
}

export async function loadBackupHealth(): Promise<BackupHealthSnapshot> {
  const rawGrace = setting("backrestGraceHours");
  const graceHours = rawGrace ? Number(rawGrace) : 2;
  if (!Number.isFinite(graceHours) || graceHours < 0 || graceHours > 168)
    throw new ConfigError(
      "Backup Freshness Grace must be between 0 and 168 hours.",
    );
  const config = await configuration();
  const now = Date.now();
  const warnings: string[] = [];
  // Query each repository's complete recorded history: the old global last-100
  // limit could drop whole plans and their previous successful backups/checks.
  const histories = new Map<
    string,
    { operations: Operation[]; error?: string }
  >();
  const summaryPromise = rpc("GetSummaryDashboard")
    .then((body) => rows(body.planSummaries))
    .catch(() => {
      warnings.push(
        "Backrest's next-run summary is unavailable. Pending operations are used when available.",
      );
      return [] as Json[];
    });
  // Four at a time keeps a large installation from flooding the server.
  for (let i = 0; i < config.repos.length; i += 4) {
    await Promise.all(
      config.repos.slice(i, i + 4).map(async (repo) => {
        try {
          if (!repo.guid)
            throw new Error(
              "Repository GUID is unavailable. Update Backrest to read its history.",
            );
          const body = await rpc("GetOperations", {
            selector: {
              repoGuid: repo.guid,
              ...(config.instanceId ? { instanceId: config.instanceId } : {}),
            },
            lastN: "0",
          });
          histories.set(repo.id, { operations: parseOperations(body) });
        } catch (e) {
          histories.set(repo.id, {
            operations: [],
            error: e instanceof Error ? e.message : "History unavailable",
          });
        }
      }),
    );
  }
  const summaries = await summaryPromise;
  const plans: BackupPlan[] = config.plans.map((plan) => {
    const history = histories.get(plan.repo);
    const ops = (history?.operations ?? []).filter(
      (o) => o.kind === "operationBackup" && o.planId === plan.id && !o.dryRun,
    );
    const latest = completed(ops)[0];
    const good = success(ops);
    const summary = summaries.find((s) => s.id === plan.id);
    const next = ops
      .filter((o) => o.status === "STATUS_PENDING")
      .map((o) => o.startedAt)
      .sort((a, b) => a - b)[0];
    return {
      id: plan.id,
      repoId: plan.repo,
      schedule: scheduleLabel(plan.schedule),
      health:
        !history || history.error
          ? health(
              "Unavailable",
              "error",
              history?.error || "The configured repository could not be found.",
            )
          : operationHealth(ops, plan.schedule, now, graceHours * HOUR),
      lastBackup: run(latest),
      lastSuccessAt: completedAt(good),
      nextRunAt: enabled(plan.schedule)
        ? (time(summary?.nextBackupTimeMs) ?? next)
        : undefined,
      latestSnapshotBytes: good?.snapshotBytes,
    };
  });
  const repositories: BackupRepository[] = config.repos.map((repo) => {
    const history = histories.get(repo.id)!;
    const ops = history.operations;
    const checks = ops.filter((o) => o.kind === "operationCheck");
    const stat = ops.find(
      (o) =>
        o.kind === "operationStats" &&
        o.status === "STATUS_SUCCESS" &&
        o.storedBytes !== undefined,
    );
    return {
      id: repo.id,
      health: history.error
        ? health("Unavailable", "error", history.error)
        : operationHealth(
            checks,
            repo.checkSchedule,
            now,
            graceHours * HOUR,
            true,
          ),
      storedBytes: stat?.storedBytes,
      statsAt: completedAt(stat),
      snapshotCount: stat?.snapshotCount,
      lastCheck: run(completed(checks)[0]),
      lastSuccessfulCheckAt: completedAt(success(checks)),
      checkMode: repo.checkMode,
      nextCheckAt: checks
        .filter((o) => o.status === "STATUS_PENDING")
        .map((o) => o.startedAt)
        .sort((a, b) => a - b)[0],
    };
  });
  const measured = repositories.filter((r) => r.storedBytes !== undefined);
  return {
    fetchedAt: now,
    plans,
    repositories,
    warnings,
    totalStoredBytes: measured.length
      ? measured.reduce((sum, r) => sum + r.storedBytes!, 0)
      : undefined,
    measuredRepositoryCount: measured.length,
  };
}

export function formatBackupBytes(bytes?: number): string {
  if (bytes === undefined || !Number.isFinite(bytes) || bytes < 0)
    return "Unknown";
  if (bytes === 0) return "0 B";
  const unit = Math.min(5, Math.floor(Math.log(bytes) / Math.log(1024)));
  return `${(bytes / 1024 ** unit).toFixed(unit ? 2 : 0)} ${["B", "KiB", "MiB", "GiB", "TiB", "PiB"][unit]}`;
}

export function backupSummary(snapshot: BackupHealthSnapshot): string {
  const count = [...snapshot.plans, ...snapshot.repositories].filter(
    (p) => p.health.attention,
  ).length;
  const state = count
    ? `${count} need attention`
    : snapshot.plans.length
      ? `${snapshot.plans.length} plans`
      : "No plans configured";
  const coverage =
    snapshot.measuredRepositoryCount < snapshot.repositories.length
      ? " · partial"
      : "";
  return `${state} · ${formatBackupBytes(snapshot.totalStoredBytes)} cached repository data${coverage}`;
}
