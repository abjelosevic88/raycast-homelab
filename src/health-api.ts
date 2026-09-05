import { requireUrl, urlGroup } from "./config";

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
