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

export interface AdguardStats {
  protectionEnabled: boolean;
  queries: number;
  blocked: number;
  blockedPct: number;
  avgMs: number;
}

export async function loadAdguard(): Promise<AdguardStats> {
  const [status, stats] = await Promise.all([
    ag<{ protection_enabled: boolean }>("/control/status"),
    ag<{ num_dns_queries: number; num_blocked_filtering: number; avg_processing_time: number }>("/control/stats"),
  ]);
  const queries = stats.num_dns_queries ?? 0;
  const blocked = stats.num_blocked_filtering ?? 0;
  return {
    protectionEnabled: status.protection_enabled,
    queries,
    blocked,
    blockedPct: queries > 0 ? (blocked / queries) * 100 : 0,
    avgMs: (stats.avg_processing_time ?? 0) * 1000,
  };
}

export async function setProtection(enabled: boolean, snoozeMinutes?: number): Promise<void> {
  await ag("/control/protection", {
    method: "POST",
    body: JSON.stringify({ enabled, ...(snoozeMinutes ? { duration: snoozeMinutes * 60 * 1000 } : {}) }),
  });
}
