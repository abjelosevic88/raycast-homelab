import { getPreferenceValues } from "@raycast/api";

interface Preferences {
  bazarrApiKey?: string;
  subsyncUrl?: string;
}

export const BAZARR_URL = "https://bazarr.bjelke.org";
const SUBSYNC_URL = "http://abjelosevic-home-server.tail0c02cf.ts.net:8150";
const TIMEOUT_MS = 10000;

export interface SubsyncStatus {
  status: string; // idle | running…
  now: string;
  queued: number;
  missing: number;
  items: { name: string; detail: string }[];
}

export async function loadSubsyncStatus(): Promise<SubsyncStatus> {
  const p = getPreferenceValues<Preferences>();
  const url = (p.subsyncUrl || SUBSYNC_URL).replace(/\/+$/, "");
  const res = await fetch(`${url}/`, { signal: AbortSignal.timeout(TIMEOUT_MS) });
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
