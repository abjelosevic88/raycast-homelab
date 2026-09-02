import { getPreferenceValues } from "@raycast/api";

interface Preferences {
  kumaUrl?: string;
  kumaStatusSlug?: string;
  kumaApiKey?: string;
}

export const KUMA_URL = "https://kuma.bjelke.org";
const TIMEOUT_MS = 8000;

function prefs() {
  const p = getPreferenceValues<Preferences>();
  return {
    url: !p.kumaUrl || p.kumaUrl.includes(".ts.net") ? KUMA_URL : p.kumaUrl.replace(/\/+$/, ""),
    slug: p.kumaStatusSlug || "home",
    apiKey: p.kumaApiKey ?? "",
  };
}

export interface MonitorStatus {
  name: string;
  // 0 down, 1 up, 2 pending, 3 maintenance
  status: number;
  ping?: number;
  uptime24?: number; // 0..1
  group?: string;
}

export interface KumaData {
  monitors: MonitorStatus[];
  source: "metrics" | "status-page";
  fetchedAt: number;
}

// Full coverage: Prometheus /metrics with an API key (all monitors)
async function loadFromMetrics(url: string, apiKey: string): Promise<MonitorStatus[]> {
  const res = await fetch(`${url}/metrics`, {
    headers: { Authorization: `Basic ${Buffer.from(`:${apiKey}`).toString("base64")}` },
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`Kuma /metrics → HTTP ${res.status}`);
  const text = await res.text();
  const byName = new Map<string, MonitorStatus>();
  for (const line of text.split("\n")) {
    const m = line.match(/^(monitor_status|monitor_response_time)\{([^}]*)\}\s+([\d.]+)/);
    if (!m) continue;
    const name = m[2].match(/monitor_name="((?:[^"\\]|\\.)*)"/)?.[1];
    if (!name) continue;
    const entry = byName.get(name) ?? { name, status: 1 };
    if (m[1] === "monitor_status") entry.status = Number(m[3]);
    else entry.ping = Number(m[3]);
    byName.set(name, entry);
  }
  return [...byName.values()];
}

// Zero-config: the published status page (only monitors added to it)
async function loadFromStatusPage(url: string, slug: string): Promise<MonitorStatus[]> {
  const [cfgRes, hbRes] = await Promise.all([
    fetch(`${url}/api/status-page/${slug}`, { signal: AbortSignal.timeout(TIMEOUT_MS) }),
    fetch(`${url}/api/status-page/heartbeat/${slug}`, { signal: AbortSignal.timeout(TIMEOUT_MS) }),
  ]);
  if (!cfgRes.ok) throw new Error(`Kuma status page → HTTP ${cfgRes.status}`);
  if (!hbRes.ok) throw new Error(`Kuma heartbeat → HTTP ${hbRes.status}`);
  const cfg = (await cfgRes.json()) as {
    publicGroupList?: { name: string; monitorList: { id: number; name: string }[] }[];
  };
  const hb = (await hbRes.json()) as {
    heartbeatList: Record<string, { status: number; ping?: number }[]>;
    uptimeList: Record<string, number>;
  };
  const monitors: MonitorStatus[] = [];
  for (const group of cfg.publicGroupList ?? []) {
    for (const mon of group.monitorList) {
      const beats = hb.heartbeatList[String(mon.id)] ?? [];
      const last = beats[beats.length - 1];
      monitors.push({
        name: mon.name,
        status: last?.status ?? 2,
        ping: last?.ping ?? undefined,
        uptime24: hb.uptimeList[`${mon.id}_24`],
        group: group.name,
      });
    }
  }
  return monitors;
}

export async function loadKuma(): Promise<KumaData> {
  const { url, slug, apiKey } = prefs();
  if (apiKey) {
    return { monitors: await loadFromMetrics(url, apiKey), source: "metrics", fetchedAt: Date.now() };
  }
  return { monitors: await loadFromStatusPage(url, slug), source: "status-page", fetchedAt: Date.now() };
}
