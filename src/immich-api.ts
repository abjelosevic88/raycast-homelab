import { has, optionalUrl, requireUrl, setting } from "./config";

export const IMMICH_URL = optionalUrl("immichUrl");
const TIMEOUT_MS = 15000;
const PAGE_SIZE = 42;

function prefs() {
  return {
    url: requireUrl("immichUrl", "Immich"),
    key: setting("immichApiKey"),
  };
}

export function hasImmichKey(): boolean {
  return has("immichUrl", "immichApiKey");
}

async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const { url, key } = prefs();
  const res = await fetch(`${url}${path}`, {
    ...init,
    headers: {
      "x-api-key": key,
      "Content-Type": "application/json",
      ...(init?.headers ?? {}),
    },
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`Immich ${path} → HTTP ${res.status}`);
  return (await res.json()) as T;
}

export interface Photo {
  id: string;
  type: "IMAGE" | "VIDEO";
  fileCreatedAt: string;
  originalFileName: string;
  isFavorite: boolean;
}

interface SearchResponse {
  assets: { items: Photo[]; nextPage: string | number | null };
}

export type PhotoMode = "recent" | "favorites" | "videos" | "albums";

export const PHOTO_MODES: { id: PhotoMode; title: string }[] = [
  { id: "recent", title: "Recent" },
  { id: "favorites", title: "Favorites" },
  { id: "videos", title: "Videos" },
  { id: "albums", title: "Albums" },
];

export async function listPhotos(
  mode: PhotoMode,
  page: number,
): Promise<{ photos: Photo[]; hasMore: boolean }> {
  // "timeline" excludes hidden assets (e.g. the .MOV halves of Live Photos)
  const body: Record<string, unknown> = {
    size: PAGE_SIZE,
    page: page + 1,
    order: "desc",
    visibility: "timeline",
  };
  if (mode === "favorites") body.isFavorite = true;
  if (mode === "videos") body.type = "VIDEO";
  const r = await api<SearchResponse>("/api/search/metadata", {
    method: "POST",
    body: JSON.stringify(body),
  });
  return { photos: r.assets.items, hasMore: r.assets.nextPage != null };
}

// CLIP semantic search — "sunset at the beach", "dog in snow", …
export async function smartSearch(
  query: string,
  page: number,
): Promise<{ photos: Photo[]; hasMore: boolean }> {
  const r = await api<SearchResponse>("/api/search/smart", {
    method: "POST",
    body: JSON.stringify({ query, size: PAGE_SIZE, page: page + 1 }),
  });
  return { photos: r.assets.items, hasMore: r.assets.nextPage != null };
}

export interface ImmichAlbum {
  id: string;
  albumName: string;
  assetCount: number;
  albumThumbnailAssetId?: string;
}

export async function listAlbums(): Promise<ImmichAlbum[]> {
  return await api<ImmichAlbum[]>("/api/albums");
}

export async function albumAssets(albumId: string): Promise<Photo[]> {
  const r = await api<{ assets: Photo[] }>(`/api/albums/${albumId}`);
  return r.assets;
}

export interface Memory {
  id: string;
  year: number;
  assets: Photo[];
}

// "On this day" memories whose show window covers today
export async function loadTodayMemories(): Promise<Memory[]> {
  const raw =
    await api<
      {
        id: string;
        type: string;
        showAt: string;
        hideAt: string;
        data?: { year?: number };
        assets: Photo[];
      }[]
    >("/api/memories");
  const now = Date.now();
  return raw
    .filter(
      (m) =>
        m.type === "on_this_day" &&
        new Date(m.showAt).getTime() <= now &&
        now <= new Date(m.hideAt).getTime(),
    )
    .map((m) => ({ id: m.id, year: m.data?.year ?? 0, assets: m.assets }))
    .sort((a, b) => b.year - a.year);
}

export async function setFavorite(
  assetId: string,
  isFavorite: boolean,
): Promise<void> {
  await api(`/api/assets/${assetId}`, {
    method: "PUT",
    body: JSON.stringify({ isFavorite }),
  });
}

// Immich accepts ?apiKey= on media routes, so grid tiles can load directly
export function thumbUrl(
  assetId: string,
  size: "thumbnail" | "preview" = "thumbnail",
): string {
  const { url, key } = prefs();
  return `${url}/api/assets/${assetId}/thumbnail?size=${size}&apiKey=${encodeURIComponent(key)}`;
}

export function photoWebUrl(assetId: string): string {
  return `${prefs().url}/photos/${assetId}`;
}

export function albumWebUrl(albumId: string): string {
  return `${prefs().url}/albums/${albumId}`;
}
