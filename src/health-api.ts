import { requireUrl, setting, urlGroup } from "./config";

export const HEALTH_URLS = urlGroup({
  backrest: "backrestUrl",
  scrutiny: "scrutinyUrl",
  speedtest: "speedtestUrl",
});

const TIMEOUT_MS = 10000;

// ---------- Scrutiny (no auth) ----------

export interface DiskHealth {
  total: number;
  warnings: string[]; // device names with non-passed status
}

export async function loadDiskHealth(): Promise<DiskHealth> {
  const res = await fetch(
    `${requireUrl("scrutinyUrl", "Scrutiny")}/api/summary`,
    { signal: AbortSignal.timeout(TIMEOUT_MS) },
  );
  if (!res.ok) throw new Error(`Scrutiny → HTTP ${res.status}`);
  const body = (await res.json()) as {
    data: {
      summary: Record<
        string,
        {
          device: {
            device_status: number;
            device_name?: string;
            host_id?: string;
          };
        }
      >;
    };
  };
  const devices = Object.values(body.data.summary);
  const warnings = devices
    .filter((d) => d.device.device_status !== 0)
    .map(
      (d) =>
        `${d.device.host_id ? `${d.device.host_id}:` : ""}${d.device.device_name ?? "?"}`,
    );
  return { total: devices.length, warnings };
}

// ---------- Speedtest Tracker (legacy open endpoint) ----------

export interface SpeedtestResult {
  download: number; // Mbps
  upload: number;
  ping: number;
  createdAt: string;
}

export async function loadSpeedtest(): Promise<SpeedtestResult> {
  const res = await fetch(
    `${requireUrl("speedtestUrl", "Speedtest Tracker")}/api/speedtest/latest`,
    { signal: AbortSignal.timeout(TIMEOUT_MS) },
  );
  if (!res.ok) throw new Error(`Speedtest Tracker → HTTP ${res.status}`);
  const body = (await res.json()) as {
    data?: Record<string, unknown>;
  } & Record<string, unknown>;
  const d = (body.data ?? body) as {
    download?: number;
    upload?: number;
    ping?: number;
    created_at?: string;
  };
  return {
    download: d.download ?? 0,
    upload: d.upload ?? 0,
    ping: d.ping ?? 0,
    createdAt: d.created_at ?? "",
  };
}

// ---------- Backrest (login → operations) ----------

let backrestToken: { value: string; at: number } | null = null;

async function backrestLogin(): Promise<string> {
  const url = requireUrl("backrestUrl", "Backrest");
  const password = setting("backrestPassword");
  if (!password) throw new Error("Backrest password not set");
  if (backrestToken && Date.now() - backrestToken.at < 30 * 60 * 1000)
    return backrestToken.value;
  const res = await fetch(`${url}/v1.Authentication/Login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    signal: AbortSignal.timeout(TIMEOUT_MS),
    body: JSON.stringify({
      username: setting("backrestUsername") || "admin",
      password,
    }),
  });
  if (!res.ok) throw new Error(`Backrest login → HTTP ${res.status}`);
  const body = (await res.json()) as { token?: string };
  if (!body.token) throw new Error("Backrest login: no token");
  backrestToken = { value: body.token, at: Date.now() };
  return body.token;
}

export interface BackupPlanStatus {
  planId: string;
  ok: boolean;
  when: number; // unix ms
}

export async function loadBackups(): Promise<BackupPlanStatus[]> {
  const token = await backrestLogin();
  const res = await fetch(
    `${requireUrl("backrestUrl", "Backrest")}/v1.Backrest/GetOperations`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
      },
      signal: AbortSignal.timeout(TIMEOUT_MS),
      body: JSON.stringify({ lastN: "100" }),
    },
  );
  if (!res.ok) throw new Error(`Backrest GetOperations → HTTP ${res.status}`);
  const body = (await res.json()) as {
    operations?: {
      planId?: string;
      status?: string;
      unixTimeStartMs?: string | number;
      operationBackup?: unknown;
      op?: Record<string, unknown>;
    }[];
  };
  const latest = new Map<string, BackupPlanStatus>();
  for (const op of body.operations ?? []) {
    const isBackup =
      op.operationBackup !== undefined || (op.op && "operationBackup" in op.op);
    if (!isBackup || !op.planId) continue;
    if (op.status === "STATUS_INPROGRESS" || op.status === "STATUS_PENDING")
      continue;
    const when = Number(op.unixTimeStartMs ?? 0);
    const prev = latest.get(op.planId);
    if (!prev || when > prev.when) {
      latest.set(op.planId, {
        planId: op.planId,
        ok: op.status === "STATUS_SUCCESS",
        when,
      });
    }
  }
  return [...latest.values()].sort((a, b) => b.when - a.when);
}
