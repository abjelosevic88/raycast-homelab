import { getPreferenceValues } from "@raycast/api";

interface Preferences {
  adguardUsername?: string;
  adguardPassword?: string;
}

export const ADGUARD_URL = "https://dns.bjelke.org";
const TIMEOUT_MS = 8000;

export function hasAdguardCreds(): boolean {
  const p = getPreferenceValues<Preferences>();
  return Boolean(p.adguardUsername && p.adguardPassword);
}

async function ag<T>(path: string, init?: RequestInit): Promise<T> {
  const p = getPreferenceValues<Preferences>();
  const auth = Buffer.from(`${p.adguardUsername}:${p.adguardPassword}`).toString("base64");
  const res = await fetch(`${ADGUARD_URL}${path}`, {
    ...init,
    headers: { Authorization: `Basic ${auth}`, "Content-Type": "application/json", ...(init?.headers ?? {}) },
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`AdGuard ${path} → HTTP ${res.status}`);
  // GET endpoints return JSON; mutations answer with a bare "OK"
  const text = (await res.text()).trim();
  return (text.startsWith("{") || text.startsWith("[") ? JSON.parse(text) : undefined) as T;
}

export interface Counted {
  name: string;
  count: number;
  label?: string; // resolved client name, when AdGuard knows one
}

// Docker bridge / private ranges that never resolve to a device name
function guessLabel(ip: string): string | undefined {
  if (/^10\.2\d\d\./.test(ip) || /^172\.(1[6-9]|2\d|3[01])\./.test(ip)) return "docker container";
  return undefined;
}

// AdGuard resolves IPs against persistent clients, DHCP leases, rDNS, hosts
export async function resolveClientNames(ips: string[]): Promise<Record<string, string>> {
  if (ips.length === 0) return {};
  const qs = ips.map((ip, i) => `ip${i}=${encodeURIComponent(ip)}`).join("&");
  const r = await ag<Record<string, { name?: string }[]>[]>(`/control/clients/find?${qs}`);
  const out: Record<string, string> = {};
  for (const entry of r) {
    for (const [ip, infos] of Object.entries(entry)) {
      const name = infos?.[0]?.name;
      if (name) out[ip] = name;
    }
  }
  return out;
}

function counted(list?: Record<string, number>[]): Counted[] {
  return (list ?? []).map((o) => {
    const [name, count] = Object.entries(o)[0] ?? ["?", 0];
    return { name, count };
  });
}

export interface AdguardStats {
  protectionEnabled: boolean;
  disabledUntil?: number; // unix ms
  version: string;
  dnsAddresses: string[];
  queries: number;
  blocked: number;
  blockedPct: number;
  safeBrowsing: number;
  avgMs: number;
  topQueried: Counted[];
  topBlocked: Counted[];
  topClients: Counted[];
  timeUnits: string;
}

export async function loadAdguard(): Promise<AdguardStats> {
  const [status, stats] = await Promise.all([
    ag<{
      protection_enabled: boolean;
      protection_disabled_duration?: number;
      version?: string;
      dns_addresses?: string[];
    }>("/control/status"),
    ag<{
      num_dns_queries: number;
      num_blocked_filtering: number;
      num_replaced_safebrowsing?: number;
      avg_processing_time: number;
      top_queried_domains?: Record<string, number>[];
      top_blocked_domains?: Record<string, number>[];
      top_clients?: Record<string, number>[];
      time_units?: string;
    }>("/control/stats"),
  ]);
  const queries = stats.num_dns_queries ?? 0;
  const blocked = stats.num_blocked_filtering ?? 0;
  const topClients = counted(stats.top_clients);
  const names = await resolveClientNames(topClients.map((c) => c.name)).catch(() => ({}) as Record<string, string>);
  for (const c of topClients) c.label = names[c.name] ?? guessLabel(c.name);
  return {
    protectionEnabled: status.protection_enabled,
    disabledUntil: status.protection_disabled_duration ? Date.now() + status.protection_disabled_duration : undefined,
    version: status.version ?? "",
    dnsAddresses: status.dns_addresses ?? [],
    queries,
    blocked,
    blockedPct: queries > 0 ? (blocked / queries) * 100 : 0,
    safeBrowsing: stats.num_replaced_safebrowsing ?? 0,
    avgMs: (stats.avg_processing_time ?? 0) * 1000,
    topQueried: counted(stats.top_queried_domains),
    topBlocked: counted(stats.top_blocked_domains),
    topClients,
    timeUnits: stats.time_units ?? "hours",
  };
}

export interface QueryLogEntry {
  time: string;
  domain: string;
  type: string;
  client: string;
  clientName?: string;
  reason: string;
  blocked: boolean;
  elapsedMs: number;
  rule?: string;
}

export async function loadQueryLog(limit = 40, onlyBlocked = false): Promise<QueryLogEntry[]> {
  const qs = `limit=${limit}${onlyBlocked ? "&response_status=blocked" : ""}`;
  const r = await ag<{
    data: {
      time: string;
      question: { name: string; type: string };
      client: string;
      client_info?: { name?: string };
      reason: string;
      elapsedMs: string | number;
      rule?: string;
    }[];
  }>(`/control/querylog?${qs}`);
  return r.data.map((e) => ({
    time: e.time,
    domain: e.question.name,
    type: e.question.type,
    client: e.client,
    clientName: e.client_info?.name || undefined,
    reason: e.reason,
    blocked: e.reason.startsWith("Filtered") && e.reason !== "FilteredSafeSearch",
    elapsedMs: Number(e.elapsedMs),
    rule: e.rule || undefined,
  }));
}

export interface FilterInfo {
  name: string;
  rules: number;
  enabled: boolean;
  lastUpdated?: string;
}

export async function loadFilters(): Promise<{ filters: FilterInfo[]; userRules: number; totalRules: number }> {
  const r = await ag<{
    filters?: { name: string; rules_count: number; enabled: boolean; last_updated?: string }[];
    user_rules?: string[];
  }>("/control/filtering/status");
  const filters = (r.filters ?? []).map((f) => ({
    name: f.name,
    rules: f.rules_count,
    enabled: f.enabled,
    lastUpdated: f.last_updated?.slice(0, 10),
  }));
  return {
    filters,
    userRules: (r.user_rules ?? []).filter((x) => x.trim() && !x.startsWith("#")).length,
    totalRules: filters.filter((f) => f.enabled).reduce((s, f) => s + f.rules, 0),
  };
}

export async function setProtection(enabled: boolean, snoozeMinutes?: number): Promise<void> {
  await ag("/control/protection", {
    method: "POST",
    body: JSON.stringify({ enabled, ...(snoozeMinutes ? { duration: snoozeMinutes * 60 * 1000 } : {}) }),
  });
}

export function fmtCount(n: number): string {
  return n.toLocaleString("en-US");
}
