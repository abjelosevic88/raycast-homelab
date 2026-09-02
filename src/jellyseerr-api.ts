import { getPreferenceValues } from "@raycast/api";

interface Preferences {
  jellyseerrUrl?: string;
  jellyseerrApiKey?: string;
}

export const JELLYSEERR_URL = "https://requests.bjelke.org";
const TIMEOUT_MS = 10000;

export function jellyseerrPrefs() {
  const p = getPreferenceValues<Preferences>();
  const url =
    !p.jellyseerrUrl || p.jellyseerrUrl.includes(".ts.net") ? JELLYSEERR_URL : p.jellyseerrUrl.replace(/\/+$/, "");
  return { url, key: p.jellyseerrApiKey ?? "" };
}

// Jellyseerr media status codes
export const STATUS: Record<number, { label: string; color: "green" | "orange" | "blue" | "yellow" }> = {
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
  const { url, key } = jellyseerrPrefs();
  const res = await fetch(`${url}${path}`, {
    ...init,
    headers: { "X-Api-Key": key, "Content-Type": "application/json", ...(init?.headers ?? {}) },
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
    throw new Error(msg);
  }
  return (await res.json()) as T;
}

export async function searchMedia(query: string): Promise<SearchResult[]> {
  const data = await jsFetch<{ results: SearchResult[] }>(
    `/api/v1/search?query=${encodeURIComponent(query)}&page=1`,
  );
  return data.results.filter((r) => r.mediaType !== "person");
}

export interface ServiceProfiles {
  serverId: number;
  activeProfileId: number;
  profiles: { id: number; name: string }[];
}

const profileCache: Partial<Record<"movie" | "tv", { data: ServiceProfiles; at: number }>> = {};

export async function getProfiles(mediaType: "movie" | "tv"): Promise<ServiceProfiles> {
  const cached = profileCache[mediaType];
  if (cached && Date.now() - cached.at < 5 * 60 * 1000) return cached.data;
  const svc = mediaType === "movie" ? "radarr" : "sonarr";
  const servers = await jsFetch<{ id: number; isDefault: boolean; activeProfileId: number }[]>(
    `/api/v1/service/${svc}`,
  );
  const server = servers.find((s) => s.isDefault) ?? servers[0];
  if (!server) throw new Error(`No ${svc} server configured in Jellyseerr`);
  const detail = await jsFetch<{ profiles: { id: number; name: string }[] }>(`/api/v1/service/${svc}/${server.id}`);
  const data = { serverId: server.id, activeProfileId: server.activeProfileId, profiles: detail.profiles };
  profileCache[mediaType] = { data, at: Date.now() };
  return data;
}

export async function requestMedia(result: SearchResult, profileId?: number): Promise<void> {
  const body: { mediaType: string; mediaId: number; seasons?: number[]; profileId?: number; serverId?: number } = {
    mediaType: result.mediaType,
    mediaId: result.id,
  };
  if (profileId !== undefined) {
    body.profileId = profileId;
    body.serverId = (await getProfiles(result.mediaType as "movie" | "tv")).serverId;
  }
  if (result.mediaType === "tv") {
    // request every real season; Jellyseerr wants explicit season numbers
    const tv = await jsFetch<{ seasons: { seasonNumber: number }[] }>(`/api/v1/tv/${result.id}`);
    body.seasons = tv.seasons.map((s) => s.seasonNumber).filter((n) => n > 0);
  }
  await jsFetch("/api/v1/request", { method: "POST", body: JSON.stringify(body) });
}
