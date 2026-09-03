import { getPreferenceValues } from "@raycast/api";

interface Preferences {
  absUrl?: string;
  absToken?: string;
}

export const ABS_URL = "https://audiobooks.bjelke.org";
const TIMEOUT_MS = 10000;
const PAGE_SIZE = 42;

function prefs() {
  const p = getPreferenceValues<Preferences>();
  return {
    url: !p.absUrl || p.absUrl.includes(".ts.net") ? ABS_URL : p.absUrl.replace(/\/+$/, ""),
    token: p.absToken ?? "",
  };
}

export function hasAbsToken(): boolean {
  return Boolean(prefs().token);
}

async function api<T>(path: string): Promise<T> {
  const { url, token } = prefs();
  const res = await fetch(`${url}${path}`, {
    headers: { Authorization: `Bearer ${token}` },
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`Audiobookshelf ${path} → HTTP ${res.status}`);
  return (await res.json()) as T;
}

export interface AbsLibrary {
  id: string;
  name: string;
  mediaType: "book" | "podcast";
}

export interface AbsItem {
  id: string;
  title: string;
  author: string;
  progress?: number; // 0..1
}

interface RawItem {
  id: string;
  media?: { metadata?: { title?: string; authorName?: string; author?: string } };
}

function mapItem(r: RawItem): AbsItem {
  const md = r.media?.metadata ?? {};
  return { id: r.id, title: md.title ?? "Untitled", author: md.authorName ?? md.author ?? "" };
}

export async function listLibraries(): Promise<AbsLibrary[]> {
  const r = await api<{ libraries: AbsLibrary[] }>("/api/libraries");
  return r.libraries;
}

export async function listItems(libraryId: string, page: number): Promise<{ items: AbsItem[]; hasMore: boolean }> {
  const r = await api<{ results: RawItem[]; total: number }>(
    `/api/libraries/${libraryId}/items?limit=${PAGE_SIZE}&page=${page}&sort=addedAt&desc=1`,
  );
  const items = r.results.map(mapItem);
  return { items, hasMore: (page + 1) * PAGE_SIZE < r.total };
}

export async function searchLibrary(libraryId: string, q: string): Promise<AbsItem[]> {
  const r = await api<{
    book?: { libraryItem: RawItem }[];
    podcast?: { libraryItem: RawItem }[];
  }>(`/api/libraries/${libraryId}/search?q=${encodeURIComponent(q)}&limit=30`);
  return [...(r.book ?? []), ...(r.podcast ?? [])].map((x) => mapItem(x.libraryItem));
}

export async function continueListening(): Promise<AbsItem[]> {
  const [inProgress, me] = await Promise.all([
    api<{ libraryItems: RawItem[] }>("/api/me/items-in-progress?limit=20"),
    api<{ mediaProgress?: { libraryItemId: string; progress: number; isFinished: boolean }[] }>("/api/me"),
  ]);
  const progressById = new Map<string, number>();
  for (const mp of me.mediaProgress ?? []) {
    if (!mp.isFinished) progressById.set(mp.libraryItemId, Math.max(progressById.get(mp.libraryItemId) ?? 0, mp.progress));
  }
  const seen = new Set<string>();
  const out: AbsItem[] = [];
  for (const raw of inProgress.libraryItems) {
    if (seen.has(raw.id)) continue;
    seen.add(raw.id);
    out.push({ ...mapItem(raw), progress: progressById.get(raw.id) });
  }
  return out;
}

export function absCoverUrl(itemId: string, width = 300): string {
  const { url, token } = prefs();
  return `${url}/api/items/${itemId}/cover?token=${encodeURIComponent(token)}&width=${width}`;
}

export function absItemWebUrl(itemId: string): string {
  return `${prefs().url}/item/${itemId}`;
}
