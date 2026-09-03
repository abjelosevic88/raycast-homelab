import { getPreferenceValues } from "@raycast/api";

interface Preferences {
  backrestUsername?: string;
  backrestPassword?: string;
}

export const HEALTH_URLS = {
  backrest: "https://backrest.bjelke.org",
  scrutiny: "https://scrutiny.bjelke.org",
  speedtest: "https://speedtest.bjelke.org",
};

const TIMEOUT_MS = 10000;

// ---------- Scrutiny (no auth) ----------

export interface DiskHealth {
  total: number;
  warnings: string[]; // device names with non-passed status
}

export async function loadDiskHealth(): Promise<DiskHealth> {
  const res = await fetch(`${HEALTH_URLS.scrutiny}/api/summary`, { signal: AbortSignal.timeout(TIMEOUT_MS) });
  if (!res.ok) throw new Error(`Scrutiny → HTTP ${res.status}`);
  const body = (await res.json()) as {
    data: { summary: Record<string, { device: { device_status: number; device_name?: string; host_id?: string } }> };
  };
  const devices = Object.values(body.data.summary);
  const warnings = devices
    .filter((d) => d.device.device_status !== 0)
    .map((d) => `${d.device.host_id ? `${d.device.host_id}:` : ""}${d.device.device_name ?? "?"}`);
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
  const res = await fetch(`${HEALTH_URLS.speedtest}/api/speedtest/latest`, { signal: AbortSignal.timeout(TIMEOUT_MS) });
  if (!res.ok) throw new Error(`Speedtest Tracker → HTTP ${res.status}`);
  const body = (await res.json()) as { data?: Record<string, unknown> } & Record<string, unknown>;
  const d = (body.data ?? body) as { download?: number; upload?: number; ping?: number; created_at?: string };
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
  const p = getPreferenceValues<Preferences>();
  if (!p.backrestPassword) throw new Error("Backrest password not set");
  if (backrestToken && Date.now() - backrestToken.at < 30 * 60 * 1000) return backrestToken.value;
  const res = await fetch(`${HEALTH_URLS.backrest}/v1.Authentication/Login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    signal: AbortSignal.timeout(TIMEOUT_MS),
    body: JSON.stringify({ username: p.backrestUsername || "admin", password: p.backrestPassword }),
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
  const res = await fetch(`${HEALTH_URLS.backrest}/v1.Backrest/GetOperations`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
    signal: AbortSignal.timeout(TIMEOUT_MS),
    body: JSON.stringify({ lastN: "100" }),
  });
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
    const isBackup = op.operationBackup !== undefined || (op.op && "operationBackup" in op.op);
    if (!isBackup || !op.planId) continue;
    if (op.status === "STATUS_INPROGRESS" || op.status === "STATUS_PENDING") continue;
    const when = Number(op.unixTimeStartMs ?? 0);
    const prev = latest.get(op.planId);
    if (!prev || when > prev.when) {
      latest.set(op.planId, { planId: op.planId, ok: op.status === "STATUS_SUCCESS", when });
    }
  }
  return [...latest.values()].sort((a, b) => b.when - a.when);
}
