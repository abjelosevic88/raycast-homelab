import { getPreferenceValues } from "@raycast/api";

interface Preferences {
  bazarrApiKey?: string;
  subsyncUrl?: string;
}

export const BAZARR_URL = "https://bazarr.bjelke.org";
export const SUBSYNC_URL = "https://subtitles.bjelke.org";
const TIMEOUT_MS = 10000;

function subsyncBase(): string {
  const p = getPreferenceValues<Preferences>();
  return (p.subsyncUrl || SUBSYNC_URL).replace(/\/+$/, "");
}

// ---------- manual ±ms nudges (the /nudge page of sync-status-server) ----------

export interface SubtitleFile {
  path: string;
  name: string;
  rel: string; // relative to ~/media, e.g. "movies/28 Years Later (2025)/….sr.srt"
  lang: string;
  pinned: boolean;
  nudgedMs: number;
}

export async function listSubtitleFiles(opts: { q?: string; pinned?: boolean; limit?: number } = {}): Promise<SubtitleFile[]> {
  const qs = new URLSearchParams();
  if (opts.q) qs.set("q", opts.q);
  if (opts.pinned) qs.set("pinned", "1");
  if (opts.limit) qs.set("limit", String(opts.limit));
  const res = await fetch(`${subsyncBase()}/nudge/files${qs.size ? `?${qs}` : ""}`, { signal: AbortSignal.timeout(20000) });
  if (!res.ok) throw new Error(`nudge/files → HTTP ${res.status}`);
  const raw = (await res.json()) as { path: string; name: string; rel: string; lang: string; pinned: boolean; nudged_ms: number }[];
  return raw.map((f) => ({ path: f.path, name: f.name, rel: f.rel, lang: f.lang, pinned: f.pinned, nudgedMs: f.nudged_ms }));
}

async function nudgePost<T>(route: "apply" | "undo" | "unpin", body: Record<string, unknown>): Promise<T> {
  const res = await fetch(`${subsyncBase()}/nudge/${route}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(30000),
  });
  const data = (await res.json()) as T & { ok?: boolean; error?: string };
  if (!res.ok || data.ok === false) throw new Error(data.error ?? `nudge/${route} → HTTP ${res.status}`);
  return data;
}

export function nudgeApply(path: string, ms: number) {
  return nudgePost<{ cues: number; ms: number; pinned: boolean }>("apply", { path, ms });
}
export function nudgeUndo(path: string) {
  return nudgePost<{ restored_ms: number }>("undo", { path });
}
export function nudgeUnpin(path: string) {
  return nudgePost<{ ok: boolean }>("unpin", { path });
}

export interface SubsyncStatus {
  status: string; // idle | running…
  now: string;
  queued: number;
  missing: number;
  items: { name: string; detail: string }[];
}

export async function loadSubsyncStatus(): Promise<SubsyncStatus> {
  const res = await fetch(`${subsyncBase()}/`, { signal: AbortSignal.timeout(TIMEOUT_MS) });
  if (!res.ok) throw new Error(`subsync status → HTTP ${res.status}`);
  return (await res.json()) as SubsyncStatus;
}

export function hasBazarrKey(): boolean {
  return Boolean(getPreferenceValues<Preferences>().bazarrApiKey);
}

async function bazarr<T>(path: string): Promise<T> {
  const p = getPreferenceValues<Preferences>();
  const res = await fetch(`${BAZARR_URL}${path}`, {
    headers: { "X-API-KEY": p.bazarrApiKey ?? "" },
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`Bazarr ${path.split("?")[0]} → HTTP ${res.status}`);
  return (await res.json()) as T;
}

export interface WantedItem {
  id: string;
  kind: "episode" | "movie";
  title: string;
  detail: string;
  languages: string[];
}

export async function loadWanted(): Promise<{ episodes: WantedItem[]; movies: WantedItem[]; totals: { episodes: number; movies: number } }> {
  const [eps, movs] = await Promise.all([
    bazarr<{
      total: number;
      data: { sonarrEpisodeId: number; seriesTitle: string; episode_number: string; episodeTitle?: string; missing_subtitles?: { code2: string }[] }[];
    }>("/api/episodes/wanted?length=100"),
    bazarr<{
      total: number;
      data: { radarrId: number; title: string; missing_subtitles?: { code2: string }[] }[];
    }>("/api/movies/wanted?length=100"),
  ]);
  return {
    episodes: eps.data.map((e) => ({
      id: `ep-${e.sonarrEpisodeId}`,
      kind: "episode",
      title: e.seriesTitle,
      detail: `${e.episode_number}${e.episodeTitle ? ` · ${e.episodeTitle}` : ""}`,
      languages: (e.missing_subtitles ?? []).map((m) => m.code2),
    })),
    movies: movs.data.map((m) => ({
      id: `mv-${m.radarrId}`,
      kind: "movie",
      title: m.title,
      detail: "movie",
      languages: (m.missing_subtitles ?? []).map((x) => x.code2),
    })),
    totals: { episodes: eps.total, movies: movs.total },
  };
}
