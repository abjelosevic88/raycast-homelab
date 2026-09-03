import { getPreferenceValues } from "@raycast/api";

interface Preferences {
  radarrApiKey?: string;
  sonarrApiKey?: string;
  lidarrApiKey?: string;
  chaptarrApiKey?: string;
}

export const ARR_URLS = {
  radarr: "https://radarr.bjelke.org",
  sonarr: "https://sonarr.bjelke.org",
  lidarr: "https://lidarr.bjelke.org",
  chaptarr: "https://chaptarr.bjelke.org",
};

const TIMEOUT_MS = 10000;

type ArrApp = "radarr" | "sonarr" | "lidarr" | "chaptarr";

function keyFor(app: ArrApp): string {
  const p = getPreferenceValues<Preferences>();
  return { radarr: p.radarrApiKey, sonarr: p.sonarrApiKey, lidarr: p.lidarrApiKey, chaptarr: p.chaptarrApiKey }[app] ?? "";
}

export function configuredArrs(): ArrApp[] {
  return (["radarr", "sonarr", "lidarr", "chaptarr"] as ArrApp[]).filter((a) => keyFor(a));
}

async function arr<T>(app: ArrApp, path: string): Promise<T> {
  const version = app === "lidarr" || app === "chaptarr" ? "v1" : "v3";
  const res = await fetch(`${ARR_URLS[app]}/api/${version}${path}`, {
    headers: { "X-Api-Key": keyFor(app) },
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`${app} ${path} → HTTP ${res.status}`);
  return (await res.json()) as T;
}

export interface CalendarEntry {
  id: string;
  app: ArrApp;
  title: string;
  subtitle: string;
  date: string; // YYYY-MM-DD
  has: boolean; // already downloaded
  poster?: string;
}

interface ArrImage {
  coverType?: string;
  remoteUrl?: string;
}

function posterOf(images?: ArrImage[]): string | undefined {
  return images?.find((i) => i.coverType === "poster" && i.remoteUrl)?.remoteUrl;
}

export interface StuckItem {
  id: string;
  app: ArrApp;
  title: string;
  status: string;
  error: string;
}

export interface ArrData {
  calendar: CalendarEntry[];
  stuck: StuckItem[];
  errors: string[];
}

function iso(d: Date): string {
  return d.toISOString().slice(0, 10);
}

interface RadarrMovie {
  id: number;
  title: string;
  year?: number;
  hasFile?: boolean;
  digitalRelease?: string;
  physicalRelease?: string;
  inCinemas?: string;
  images?: ArrImage[];
}
interface SonarrEpisode {
  id: number;
  seasonNumber: number;
  episodeNumber: number;
  title?: string;
  airDateUtc?: string;
  hasFile?: boolean;
  series?: { title?: string; images?: ArrImage[] };
}
interface LidarrAlbum {
  id: number;
  title: string;
  releaseDate?: string;
  artist?: { artistName?: string; images?: ArrImage[] };
  images?: ArrImage[];
  statistics?: { percentOfTracks?: number };
}
interface QueueRecord {
  id: number;
  title?: string;
  status?: string;
  trackedDownloadStatus?: string;
  trackedDownloadState?: string;
  errorMessage?: string;
  statusMessages?: { title?: string; messages?: string[] }[];
}

export async function loadArrData(): Promise<ArrData> {
  const apps = configuredArrs();
  const data: ArrData = { calendar: [], stuck: [], errors: [] };
  const start = iso(new Date(Date.now() - 86400000));
  const end = iso(new Date(Date.now() + 14 * 86400000));

  const tasks: Promise<void>[] = [];

  if (apps.includes("radarr")) {
    tasks.push(
      arr<RadarrMovie[]>("radarr", `/calendar?start=${start}&end=${end}`).then((movies) => {
        for (const m of movies) {
          const date = (m.digitalRelease ?? m.physicalRelease ?? m.inCinemas ?? "").slice(0, 10);
          if (!date) continue;
          data.calendar.push({
            id: `radarr-${m.id}`,
            app: "radarr",
            title: m.title,
            subtitle: m.year ? String(m.year) : "movie",
            date,
            has: Boolean(m.hasFile),
            poster: posterOf(m.images),
          });
        }
      }),
    );
  }
  if (apps.includes("sonarr")) {
    tasks.push(
      arr<SonarrEpisode[]>("sonarr", `/calendar?start=${start}&end=${end}&includeSeries=true`).then((eps) => {
        for (const e of eps) {
          data.calendar.push({
            id: `sonarr-${e.id}`,
            app: "sonarr",
            title: e.series?.title ?? "Unknown series",
            subtitle: `S${String(e.seasonNumber).padStart(2, "0")}E${String(e.episodeNumber).padStart(2, "0")}${e.title ? ` · ${e.title}` : ""}`,
            date: (e.airDateUtc ?? "").slice(0, 10),
            has: Boolean(e.hasFile),
            poster: posterOf(e.series?.images),
          });
        }
      }),
    );
  }
  if (apps.includes("lidarr")) {
    tasks.push(
      arr<LidarrAlbum[]>("lidarr", `/calendar?start=${start}&end=${end}&includeArtist=true`).then((albums) => {
        for (const a of albums) {
          data.calendar.push({
            id: `lidarr-${a.id}`,
            app: "lidarr",
            title: `${a.artist?.artistName ? `${a.artist.artistName} — ` : ""}${a.title}`,
            subtitle: "album",
            date: (a.releaseDate ?? "").slice(0, 10),
            has: (a.statistics?.percentOfTracks ?? 0) >= 100,
            poster: posterOf(a.images) ?? posterOf(a.artist?.images),
          });
        }
      }),
    );
  }

  if (apps.includes("chaptarr")) {
    tasks.push(
      arr<{ id: number; title: string; releaseDate?: string; author?: { authorName?: string }; images?: ArrImage[]; statistics?: { percentOfBooks?: number; bookFileCount?: number } }[]>(
        "chaptarr",
        `/calendar?start=${start}&end=${end}&includeAuthor=true`,
      ).then((books) => {
        for (const b of books) {
          data.calendar.push({
            id: `chaptarr-${b.id}`,
            app: "chaptarr",
            title: `${b.author?.authorName ? `${b.author.authorName} — ` : ""}${b.title}`,
            subtitle: "book",
            date: (b.releaseDate ?? "").slice(0, 10),
            has: (b.statistics?.bookFileCount ?? 0) > 0,
            poster: posterOf(b.images),
          });
        }
      }),
    );
  }

  for (const app of apps) {
    tasks.push(
      arr<{ records: QueueRecord[] }>(app, `/queue?pageSize=50`).then((q) => {
        for (const r of q.records ?? []) {
          const warnings = (r.statusMessages ?? []).flatMap((s) => s.messages ?? []);
          const bad =
            r.errorMessage ||
            r.trackedDownloadStatus === "warning" ||
            r.trackedDownloadStatus === "error" ||
            warnings.length > 0;
          if (!bad) continue;
          data.stuck.push({
            id: `${app}-q-${r.id}`,
            app,
            title: r.title ?? "Unknown",
            status: r.trackedDownloadState ?? r.status ?? "stuck",
            error: r.errorMessage ?? warnings[0] ?? "needs attention",
          });
        }
      }),
    );
  }

  for (const r of await Promise.allSettled(tasks)) {
    if (r.status === "rejected") data.errors.push(String(r.reason?.message ?? r.reason));
  }
  data.calendar.sort((a, b) => a.date.localeCompare(b.date));
  return data;
}
