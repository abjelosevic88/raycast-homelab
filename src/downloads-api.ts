import { getPreferenceValues } from "@raycast/api";

interface Preferences {
  qbitUrl?: string;
  qbitUsername?: string;
  qbitPassword?: string;
  sabnzbdUrl?: string;
  sabnzbdApiKey?: string;
}

export const DL_URLS = {
  qbit: "https://qbit.bjelke.org",
  sab: "https://sabnzbd.bjelke.org",
};

const TIMEOUT_MS = 8000;

function base(pref: string | undefined, fallback: string): string {
  if (!pref || pref.includes(".ts.net")) return fallback;
  return pref.replace(/\/+$/, "");
}

export function fmtSpeed(bps: number): string {
  if (bps >= 1e6) return `${(bps / 1e6).toFixed(1)} MB/s`;
  if (bps >= 1e3) return `${Math.round(bps / 1e3)} KB/s`;
  return bps > 0 ? `${bps} B/s` : "0";
}

export function fmtSize(bytes: number): string {
  if (bytes >= 1e9) return `${(bytes / 1e9).toFixed(1)} GB`;
  if (bytes >= 1e6) return `${Math.round(bytes / 1e6)} MB`;
  return `${Math.round(bytes / 1e3)} KB`;
}

export function fmtEta(seconds: number): string {
  if (seconds <= 0 || seconds >= 8640000) return "∞";
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  if (h > 0) return `${h}h ${m}m`;
  const s = seconds % 60;
  return m > 0 ? `${m}m ${s}s` : `${s}s`;
}

// ---------- qBittorrent (cookie auth, v5 API) ----------

let qbitCookie: { value: string; host: string; at: number } | null = null;

function qbitPrefs() {
  const p = getPreferenceValues<Preferences>();
  return {
    url: base(p.qbitUrl, DL_URLS.qbit),
    username: p.qbitUsername || "admin",
    password: p.qbitPassword ?? "",
  };
}

async function qbitLogin(): Promise<string> {
  const { url, username, password } = qbitPrefs();
  if (qbitCookie && qbitCookie.host === url && Date.now() - qbitCookie.at < 30 * 60 * 1000) {
    return qbitCookie.value;
  }
  const res = await fetch(`${url}/api/v2/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ username, password }).toString(),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  const body = await res.text();
  // qbit ≤4.x: 200 + "Ok." with SID cookie; qbit 5.x: 204 with QBT_SID_<port> cookie.
  // Wrong credentials return 200 + "Fails." on both.
  if (!res.ok || body.trim() === "Fails.") throw new Error(`qBittorrent login failed (${res.status} ${body.trim()})`);
  const setCookie = res.headers.getSetCookie?.() ?? [res.headers.get("set-cookie") ?? ""];
  const sid = setCookie.join(", ").match(/((?:QBT_)?SID[^=;,\s]*)=([^;]+)/);
  if (!sid) throw new Error("qBittorrent login: no session cookie returned");
  qbitCookie = { value: `${sid[1]}=${sid[2]}`, host: url, at: Date.now() };
  return qbitCookie.value;
}

async function qbitGet<T>(path: string): Promise<T> {
  const { url } = qbitPrefs();
  const cookie = await qbitLogin();
  const res = await fetch(`${url}${path}`, { headers: { Cookie: cookie }, signal: AbortSignal.timeout(TIMEOUT_MS) });
  if (res.status === 403) {
    qbitCookie = null; // stale session — retry once with a fresh login
    const fresh = await qbitLogin();
    const retry = await fetch(`${url}${path}`, { headers: { Cookie: fresh }, signal: AbortSignal.timeout(TIMEOUT_MS) });
    if (!retry.ok) throw new Error(`qBittorrent ${path} → HTTP ${retry.status}`);
    return (await retry.json()) as T;
  }
  if (!res.ok) throw new Error(`qBittorrent ${path} → HTTP ${res.status}`);
  return (await res.json()) as T;
}

// qBittorrent 5.x renamed pause/resume → stop/start
export async function qbitToggle(hash: string, action: "stop" | "start"): Promise<void> {
  const { url } = qbitPrefs();
  const cookie = await qbitLogin();
  const res = await fetch(`${url}/api/v2/torrents/${action}`, {
    method: "POST",
    headers: { Cookie: cookie, "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ hashes: hash }).toString(),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`qBittorrent ${action} → HTTP ${res.status}`);
}

interface QbitTorrent {
  hash: string;
  name: string;
  progress: number;
  size: number;
  dlspeed: number;
  upspeed: number;
  eta: number;
  state: string;
  completion_on: number;
}
interface QbitTransfer {
  dl_info_speed: number;
  up_info_speed: number;
}

// ---------- SABnzbd ----------

function sabPrefs() {
  const p = getPreferenceValues<Preferences>();
  return { url: base(p.sabnzbdUrl, DL_URLS.sab), key: p.sabnzbdApiKey ?? "" };
}

async function sabGet<T>(params: Record<string, string>): Promise<T> {
  const { url, key } = sabPrefs();
  const qs = new URLSearchParams({ ...params, output: "json", apikey: key }).toString();
  const res = await fetch(`${url}/api?${qs}`, { signal: AbortSignal.timeout(TIMEOUT_MS) });
  if (!res.ok) throw new Error(`SABnzbd → HTTP ${res.status}`);
  const data = (await res.json()) as T & { error?: string };
  if (data.error) throw new Error(`SABnzbd: ${data.error}`);
  return data;
}

export async function sabToggle(nzoId: string, action: "pause" | "resume"): Promise<void> {
  await sabGet({ mode: "queue", name: action, value: nzoId });
}

interface SabQueue {
  queue: {
    paused: boolean;
    kbpersec: string;
    slots: {
      nzo_id: string;
      filename: string;
      size: string;
      sizeleft: string;
      percentage: string;
      timeleft: string;
      status: string;
    }[];
  };
}
interface SabHistory {
  history: {
    slots: { nzo_id: string; name: string; status: string; size: string; fail_message: string }[];
  };
}

// ---------- combined ----------

export interface DownloadItem {
  id: string;
  name: string;
  progress: number; // 0..1
  detail: string; // "4.2 GB left of 8.6 GB" etc.
  speed?: string;
  eta?: string;
  state: string;
  paused: boolean;
}

export interface RecentItem {
  id: string;
  name: string;
  ok: boolean;
  detail: string;
}

export interface DownloadsData {
  qbit?: { items: DownloadItem[]; dlSpeed: number; upSpeed: number; recent: RecentItem[] };
  sab?: { items: DownloadItem[]; speedBps: number; paused: boolean; recent: RecentItem[] };
  errors: string[];
  fetchedAt: number;
}

export async function loadDownloads(): Promise<DownloadsData> {
  const data: DownloadsData = { errors: [], fetchedAt: Date.now() };

  const tasks: Promise<void>[] = [
    Promise.all([
      qbitGet<QbitTorrent[]>("/api/v2/torrents/info?filter=downloading"),
      qbitGet<QbitTransfer>("/api/v2/transfer/info"),
      qbitGet<QbitTorrent[]>("/api/v2/torrents/info?filter=completed&sort=completion_on&reverse=true&limit=5"),
    ]).then(([torrents, transfer, completed]) => {
      data.qbit = {
        dlSpeed: transfer.dl_info_speed,
        upSpeed: transfer.up_info_speed,
        items: torrents.map((t) => ({
          id: t.hash,
          name: t.name,
          progress: t.progress,
          detail: `${fmtSize(t.size * (1 - t.progress))} left of ${fmtSize(t.size)}`,
          speed: t.dlspeed > 0 ? fmtSpeed(t.dlspeed) : undefined,
          eta: fmtEta(t.eta),
          state: t.state,
          paused: t.state.includes("paused") || t.state.includes("stopped"),
        })),
        recent: completed.map((t) => ({
          id: t.hash,
          name: t.name,
          ok: true,
          detail: fmtSize(t.size),
        })),
      };
    }),
    Promise.all([sabGet<SabQueue>({ mode: "queue" }), sabGet<SabHistory>({ mode: "history", start: "0", limit: "5" })]).then(
      ([q, h]) => {
        data.sab = {
          speedBps: parseFloat(q.queue.kbpersec) * 1000,
          paused: q.queue.paused,
          items: q.queue.slots.map((s) => ({
            id: s.nzo_id,
            name: s.filename,
            progress: parseFloat(s.percentage) / 100,
            detail: `${s.sizeleft} left of ${s.size}`,
            eta: s.timeleft,
            state: s.status.toLowerCase(),
            paused: s.status === "Paused",
          })),
          recent: h.history.slots.map((s) => ({
            id: s.nzo_id,
            name: s.name,
            ok: s.status === "Completed",
            detail: s.status === "Completed" ? s.size : s.fail_message || s.status,
          })),
        };
      },
    ),
  ];

  for (const r of await Promise.allSettled(tasks)) {
    if (r.status === "rejected") data.errors.push(String(r.reason?.message ?? r.reason));
  }
  return data;
}
