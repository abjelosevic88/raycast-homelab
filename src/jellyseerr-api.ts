import {
  describeSetting,
  has,
  optionalUrl,
  requireUrl,
  setting,
} from "./config";

export const JELLYSEERR_URL = optionalUrl("jellyseerrUrl");
const TIMEOUT_MS = 10000;

export function hasJellyseerr(): boolean {
  return has("jellyseerrUrl", "jellyseerrApiKey");
}

/** Render-safe: url is "" when unset. Views gate on `key && url`. */
export function jellyseerrPrefs() {
  return {
    url: optionalUrl("jellyseerrUrl"),
    key: setting("jellyseerrApiKey"),
  };
}

function jellyseerrBase(): string {
  return requireUrl("jellyseerrUrl", "Jellyseerr");
}

// Jellyseerr media status codes
export const STATUS: Record<
  number,
  { label: string; color: "green" | "orange" | "blue" | "yellow" }
> = {
  2: { label: "requested", color: "orange" },
  3: { label: "processing", color: "blue" },
  4: { label: "partially available", color: "yellow" },
  5: { label: "available", color: "green" },
};

export interface SearchResult {
  id: number;
  mediaType: "movie" | "tv" | "person";
  title?: string;
  name?: string;
  releaseDate?: string;
  firstAirDate?: string;
  posterPath?: string;
  overview?: string;
  mediaInfo?: { status: number };
}

async function jsFetch<T>(path: string, init?: RequestInit): Promise<T> {
  const url = jellyseerrBase();
  const { key } = jellyseerrPrefs();
  const res = await fetch(`${url}${path}`, {
    ...init,
    headers: {
      "X-Api-Key": key,
      "Content-Type": "application/json",
      ...(init?.headers ?? {}),
    },
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (!res.ok) {
    let msg = `HTTP ${res.status}`;
    try {
      const body = (await res.json()) as { message?: string };
      if (body.message) msg = body.message;
    } catch {
      // keep the status-code message
    }
    if (res.status === 401 || res.status === 403)
      msg += ` — ${describeSetting("jellyseerrApiKey")}`;
    throw new Error(msg);
  }
  return (await res.json()) as T;
}

export interface Page<T> {
  results: T[];
  hasMore: boolean;
}

export async function searchMedia(
  query: string,
  page = 1,
): Promise<Page<SearchResult>> {
  const data = await jsFetch<{
    results: SearchResult[];
    totalPages: number;
    page: number;
  }>(`/api/v1/search?query=${encodeURIComponent(query)}&page=${page}`);
  return {
    results: data.results.filter((r) => r.mediaType !== "person"),
    hasMore: data.page < data.totalPages,
  };
}

export type DiscoverCategory =
  | "trending"
  | "popular-movies"
  | "popular-tv"
  | "upcoming-movies"
  | "upcoming-tv";

export const DISCOVER_CATEGORIES: { id: DiscoverCategory; title: string }[] = [
  { id: "trending", title: "Trending" },
  { id: "popular-movies", title: "Popular Movies" },
  { id: "popular-tv", title: "Popular Series" },
  { id: "upcoming-movies", title: "Upcoming Movies" },
  { id: "upcoming-tv", title: "Upcoming Series" },
];

const DISCOVER_PATHS: Record<
  DiscoverCategory,
  { path: string; type?: "movie" | "tv" }
> = {
  trending: { path: "/api/v1/discover/trending" },
  "popular-movies": { path: "/api/v1/discover/movies", type: "movie" },
  "popular-tv": { path: "/api/v1/discover/tv", type: "tv" },
  "upcoming-movies": {
    path: "/api/v1/discover/movies/upcoming",
    type: "movie",
  },
  "upcoming-tv": { path: "/api/v1/discover/tv/upcoming", type: "tv" },
};

export async function discoverMedia(
  category: DiscoverCategory,
  page = 1,
): Promise<Page<SearchResult>> {
  const { path, type } = DISCOVER_PATHS[category];
  const data = await jsFetch<{
    results: SearchResult[];
    totalPages: number;
    page: number;
  }>(`${path}?page=${page}`);
  return {
    results: data.results
      .filter((r) => r.mediaType !== "person")
      .map((r) => ({ ...r, mediaType: r.mediaType ?? type ?? "movie" })),
    hasMore: data.page < data.totalPages,
  };
}

export interface SeasonInfo {
  seasonNumber: number;
  episodeCount: number;
}

export interface MediaDetails {
  id: number;
  mediaType: "movie" | "tv";
  title: string;
  overview: string;
  posterPath?: string;
  year?: string;
  runtime?: number; // minutes (movie) or per-episode (tv)
  rating?: number;
  genres: string[];
  cast: string[];
  network?: string;
  seasons: SeasonInfo[];
  status?: number;
}

interface RawDetails {
  id: number;
  title?: string;
  name?: string;
  overview?: string;
  posterPath?: string;
  releaseDate?: string;
  firstAirDate?: string;
  runtime?: number;
  episodeRunTime?: number[];
  voteAverage?: number;
  genres?: { name: string }[];
  credits?: { cast?: { name: string }[] };
  networks?: { name: string }[];
  productionCompanies?: { name: string }[];
  seasons?: { seasonNumber: number; episodeCount: number }[];
  mediaInfo?: { status: number };
}

const detailsCache = new Map<string, Promise<MediaDetails>>();

export function getDetailsCached(
  mediaType: "movie" | "tv",
  id: number,
): Promise<MediaDetails> {
  const k = `${mediaType}:${id}`;
  let p = detailsCache.get(k);
  if (!p) {
    p = getDetails(mediaType, id);
    p.catch(() => detailsCache.delete(k));
    detailsCache.set(k, p);
  }
  return p;
}

export async function getDetails(
  mediaType: "movie" | "tv",
  id: number,
): Promise<MediaDetails> {
  const d = await jsFetch<RawDetails>(`/api/v1/${mediaType}/${id}`);
  return {
    id: d.id,
    mediaType,
    title: d.title ?? d.name ?? "Untitled",
    overview: d.overview ?? "",
    posterPath: d.posterPath,
    year: (d.releaseDate ?? d.firstAirDate)?.slice(0, 4),
    runtime: d.runtime ?? d.episodeRunTime?.[0],
    rating: d.voteAverage,
    genres: (d.genres ?? []).map((g) => g.name),
    cast: (d.credits?.cast ?? []).slice(0, 6).map((c) => c.name),
    network: d.networks?.[0]?.name ?? d.productionCompanies?.[0]?.name,
    seasons: (d.seasons ?? []).filter((s) => s.seasonNumber > 0),
    status: d.mediaInfo?.status,
  };
}

export interface ServiceProfiles {
  serverId: number;
  activeProfileId: number;
  profiles: { id: number; name: string }[];
}

const profileCache: Partial<
  Record<"movie" | "tv", { data: ServiceProfiles; at: number }>
> = {};

export async function getProfiles(
  mediaType: "movie" | "tv",
): Promise<ServiceProfiles> {
  const cached = profileCache[mediaType];
  if (cached && Date.now() - cached.at < 5 * 60 * 1000) return cached.data;
  const svc = mediaType === "movie" ? "radarr" : "sonarr";
  const servers = await jsFetch<
    { id: number; isDefault: boolean; activeProfileId: number }[]
  >(`/api/v1/service/${svc}`);
  const server = servers.find((s) => s.isDefault) ?? servers[0];
  if (!server) throw new Error(`No ${svc} server configured in Jellyseerr`);
  const detail = await jsFetch<{ profiles: { id: number; name: string }[] }>(
    `/api/v1/service/${svc}/${server.id}`,
  );
  const data = {
    serverId: server.id,
    activeProfileId: server.activeProfileId,
    profiles: detail.profiles,
  };
  profileCache[mediaType] = { data, at: Date.now() };
  return data;
}

export async function requestMedia(
  result: { mediaType: string; id: number },
  profileId?: number,
  seasons?: number[],
): Promise<void> {
  const body: {
    mediaType: string;
    mediaId: number;
    seasons?: number[];
    profileId?: number;
    serverId?: number;
  } = {
    mediaType: result.mediaType,
    mediaId: result.id,
  };
  if (profileId !== undefined) {
    body.profileId = profileId;
    body.serverId = (
      await getProfiles(result.mediaType as "movie" | "tv")
    ).serverId;
  }
  if (result.mediaType === "tv") {
    if (seasons) {
      body.seasons = seasons;
    } else {
      // request every real season; Jellyseerr wants explicit season numbers
      const tv = await jsFetch<{ seasons: { seasonNumber: number }[] }>(
        `/api/v1/tv/${result.id}`,
      );
      body.seasons = tv.seasons.map((s) => s.seasonNumber).filter((n) => n > 0);
    }
  }
  await jsFetch("/api/v1/request", {
    method: "POST",
    body: JSON.stringify(body),
  });
}

// ---------- request management ----------

export const REQUEST_STATUS: Record<
  number,
  { label: string; color: "green" | "orange" | "blue" | "red" }
> = {
  1: { label: "pending", color: "orange" },
  2: { label: "approved", color: "blue" },
  3: { label: "declined", color: "red" },
  4: { label: "failed", color: "red" },
  5: { label: "completed", color: "green" },
};

export type RequestFilter =
  "all" | "pending" | "approved" | "processing" | "available" | "failed";

export interface MediaRequestItem {
  id: number;
  status: number;
  mediaType: "movie" | "tv";
  tmdbId: number;
  mediaStatus?: number;
  seasons: number[];
  requestedBy: string;
  createdAt: string;
  title: string;
  posterPath?: string;
  year?: string;
}

interface RawRequest {
  id: number;
  status: number;
  createdAt: string;
  media: { mediaType: "movie" | "tv"; tmdbId: number; status?: number };
  requestedBy?: { displayName?: string };
  seasons?: { seasonNumber: number }[];
}

const REQUEST_PAGE_SIZE = 40;

export async function listRequests(
  filter: RequestFilter,
  page = 0,
): Promise<Page<MediaRequestItem>> {
  const data = await jsFetch<{
    results: RawRequest[];
    pageInfo: { pages: number; page: number };
  }>(
    `/api/v1/request?take=${REQUEST_PAGE_SIZE}&skip=${page * REQUEST_PAGE_SIZE}&sort=added&filter=${filter}`,
  );
  const results = await Promise.all(
    data.results.map(async (r) => {
      let title = `${r.media.mediaType} #${r.media.tmdbId}`;
      let posterPath: string | undefined;
      let year: string | undefined;
      try {
        const d = await getDetailsCached(r.media.mediaType, r.media.tmdbId);
        title = d.title;
        posterPath = d.posterPath;
        year = d.year;
      } catch {
        // keep the tmdb-id fallback title
      }
      return {
        id: r.id,
        status: r.status,
        mediaType: r.media.mediaType,
        tmdbId: r.media.tmdbId,
        mediaStatus: r.media.status,
        seasons: (r.seasons ?? []).map((s) => s.seasonNumber),
        requestedBy: r.requestedBy?.displayName ?? "unknown",
        createdAt: r.createdAt?.slice(0, 10) ?? "",
        title,
        posterPath,
        year,
      };
    }),
  );
  return { results, hasMore: data.pageInfo.page < data.pageInfo.pages };
}

export async function actOnRequest(
  requestId: number,
  action: "approve" | "decline" | "retry",
): Promise<void> {
  await jsFetch(`/api/v1/request/${requestId}/${action}`, { method: "POST" });
}

export async function deleteRequest(requestId: number): Promise<void> {
  const url = jellyseerrBase();
  const { key } = jellyseerrPrefs();
  const res = await fetch(`${url}/api/v1/request/${requestId}`, {
    method: "DELETE",
    headers: { "X-Api-Key": key },
    signal: AbortSignal.timeout(10000),
  });
  if (!res.ok)
    throw new Error(
      `HTTP ${res.status}${res.status === 401 || res.status === 403 ? ` — ${describeSetting("jellyseerrApiKey")}` : ""}`,
    );
}
