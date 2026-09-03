import { getPreferenceValues } from "@raycast/api";

interface Preferences {
  jellyfinApiKey?: string;
  jellyfinUserId?: string;
}

export const JELLYFIN_URL = "https://jellyfin.bjelke.org";
const TIMEOUT_MS = 10000;

function prefs() {
  const p = getPreferenceValues<Preferences>();
  return { key: p.jellyfinApiKey ?? "", userId: p.jellyfinUserId ?? "" };
}

export function hasJellyfinKey(): boolean {
  return Boolean(prefs().key);
}

async function jf<T>(path: string, init?: RequestInit): Promise<T> {
  const { key } = prefs();
  const res = await fetch(`${JELLYFIN_URL}${path}`, {
    ...init,
    headers: { Authorization: `MediaBrowser Token=${key}`, ...(init?.headers ?? {}) },
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`Jellyfin ${path.split("?")[0]} → HTTP ${res.status}`);
  if (res.status === 204) return undefined as T;
  return (await res.json()) as T;
}

let cachedUserId: string | null = null;

// prefer the configured user; otherwise the first administrator
async function userId(): Promise<string> {
  const { userId: configured } = prefs();
  if (configured) return configured;
  if (cachedUserId) return cachedUserId;
  const users = await jf<{ Id: string; Policy?: { IsAdministrator?: boolean } }[]>("/Users");
  const admin = users.find((u) => u.Policy?.IsAdministrator) ?? users[0];
  if (!admin) throw new Error("Jellyfin: no users found");
  cachedUserId = admin.Id;
  return admin.Id;
}

export interface JfItem {
  id: string;
  type: "Episode" | "Movie" | string;
  name: string;
  seriesName?: string;
  seriesId?: string;
  season?: number;
  episode?: number;
  year?: number;
  progress: number; // 0..1
  runtimeMin?: number;
}

interface RawItem {
  Id: string;
  Type: string;
  Name: string;
  SeriesName?: string;
  SeriesId?: string;
  ParentIndexNumber?: number;
  IndexNumber?: number;
  ProductionYear?: number;
  RunTimeTicks?: number;
  UserData?: { PlayedPercentage?: number };
}

function mapItem(i: RawItem): JfItem {
  return {
    id: i.Id,
    type: i.Type,
    name: i.Name,
    seriesName: i.SeriesName,
    seriesId: i.SeriesId,
    season: i.ParentIndexNumber,
    episode: i.IndexNumber,
    year: i.ProductionYear,
    progress: (i.UserData?.PlayedPercentage ?? 0) / 100,
    runtimeMin: i.RunTimeTicks ? Math.round(i.RunTimeTicks / 600000000) : undefined,
  };
}

export interface JfSession {
  user: string;
  device: string;
  client: string;
  item?: JfItem;
  paused: boolean;
  positionMin?: number;
}

export async function loadSessions(): Promise<JfSession[]> {
  const raw = await jf<
    {
      UserName?: string;
      DeviceName?: string;
      Client?: string;
      NowPlayingItem?: RawItem;
      PlayState?: { IsPaused?: boolean; PositionTicks?: number };
    }[]
  >("/Sessions?activeWithinSeconds=300");
  return raw
    .filter((s) => s.NowPlayingItem)
    .map((s) => ({
      user: s.UserName ?? "?",
      device: s.DeviceName ?? "?",
      client: s.Client ?? "",
      item: s.NowPlayingItem ? mapItem(s.NowPlayingItem) : undefined,
      paused: Boolean(s.PlayState?.IsPaused),
      positionMin: s.PlayState?.PositionTicks ? Math.round(s.PlayState.PositionTicks / 600000000) : undefined,
    }));
}

export async function loadResume(limit = 24): Promise<JfItem[]> {
  const uid = await userId();
  const r = await jf<{ Items: RawItem[] }>(
    `/UserItems/Resume?userId=${uid}&limit=${limit}&mediaTypes=Video&fields=ProductionYear`,
  );
  return r.Items.map(mapItem);
}

export async function loadNextUp(limit = 24): Promise<JfItem[]> {
  const uid = await userId();
  const r = await jf<{ Items: RawItem[] }>(`/Shows/NextUp?userId=${uid}&limit=${limit}&fields=ProductionYear`);
  return r.Items.map(mapItem);
}

export async function markPlayed(itemId: string): Promise<void> {
  const uid = await userId();
  await jf(`/UserPlayedItems/${itemId}?userId=${uid}`, { method: "POST" });
}

// Jellyfin accepts api_key as a query param on image routes
export function posterUrl(item: JfItem, width = 400): string {
  const { key } = prefs();
  const id = item.seriesId ?? item.id;
  return `${JELLYFIN_URL}/Items/${id}/Images/Primary?maxWidth=${width}&api_key=${encodeURIComponent(key)}`;
}

export function itemWebUrl(itemId: string): string {
  return `${JELLYFIN_URL}/web/#/details?id=${itemId}`;
}

export function itemLabel(i: JfItem): string {
  if (i.type === "Episode" && i.seriesName) {
    const se = i.season !== undefined && i.episode !== undefined ? ` S${String(i.season).padStart(2, "0")}E${String(i.episode).padStart(2, "0")}` : "";
    return `${i.seriesName}${se}`;
  }
  return `${i.name}${i.year ? ` (${i.year})` : ""}`;
}
