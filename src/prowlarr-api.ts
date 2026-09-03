import { getPreferenceValues } from "@raycast/api";

interface Preferences {
  prowlarrApiKey?: string;
}

export const PROWLARR_URL = "https://prowlarr.bjelke.org";
const TIMEOUT_MS = 40000; // indexer fan-out can be slow

export function hasProwlarrKey(): boolean {
  return Boolean(getPreferenceValues<Preferences>().prowlarrApiKey);
}

async function prowlarr<T>(path: string, init?: RequestInit): Promise<T> {
  const key = getPreferenceValues<Preferences>().prowlarrApiKey ?? "";
  const res = await fetch(`${PROWLARR_URL}/api/v1${path}`, {
    ...init,
    headers: { "X-Api-Key": key, "Content-Type": "application/json", ...(init?.headers ?? {}) },
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`Prowlarr ${path.split("?")[0]} → HTTP ${res.status}`);
  return (await res.json()) as T;
}

export const CATEGORIES: { id: string; title: string; ids: number[] }[] = [
  { id: "all", title: "All", ids: [] },
  { id: "movies", title: "Movies", ids: [2000] },
  { id: "tv", title: "TV", ids: [5000] },
  { id: "music", title: "Music", ids: [3000] },
  { id: "books", title: "Books", ids: [7000] },
];

export interface Release {
  guid: string;
  indexerId: number;
  indexer: string;
  title: string;
  size: number;
  seeders?: number;
  leechers?: number;
  grabs?: number;
  age: number; // days
  protocol: "torrent" | "usenet";
  infoUrl?: string;
  categories: string[];
}

export async function searchReleases(query: string, categoryId: string): Promise<Release[]> {
  const cat = CATEGORIES.find((c) => c.id === categoryId);
  const qs = new URLSearchParams({ query, type: "search", limit: "100" });
  for (const c of cat?.ids ?? []) qs.append("categories", String(c));
  const raw = await prowlarr<
    {
      guid: string;
      indexerId: number;
      indexer: string;
      title: string;
      size: number;
      seeders?: number;
      leechers?: number;
      grabs?: number;
      age?: number;
      protocol: "torrent" | "usenet";
      infoUrl?: string;
      categories?: { name?: string }[];
    }[]
  >(`/search?${qs}`);
  return raw
    .map((r) => ({
      guid: r.guid,
      indexerId: r.indexerId,
      indexer: r.indexer,
      title: r.title,
      size: r.size,
      seeders: r.seeders,
      leechers: r.leechers,
      grabs: r.grabs,
      age: r.age ?? 0,
      protocol: r.protocol,
      infoUrl: r.infoUrl,
      categories: (r.categories ?? []).map((c) => c.name ?? "").filter(Boolean),
    }))
    .sort((a, b) => (b.seeders ?? 0) - (a.seeders ?? 0));
}

// Prowlarr sends the release to the download client configured for that indexer/category
export async function grabRelease(r: Release): Promise<void> {
  await prowlarr("/search", { method: "POST", body: JSON.stringify({ guid: r.guid, indexerId: r.indexerId }) });
}

export function fmtBytes(b: number): string {
  if (b >= 1e9) return `${(b / 1e9).toFixed(2)} GB`;
  if (b >= 1e6) return `${Math.round(b / 1e6)} MB`;
  return `${Math.round(b / 1e3)} KB`;
}
