import { getPreferenceValues } from "@raycast/api";
import { createHash, randomBytes } from "crypto";

interface Preferences {
  navidromeUrl?: string;
  navidromeUser?: string;
  navidromePassword?: string;
}

export const NAVIDROME_URL = "https://music.bjelke.org";
const TIMEOUT_MS = 10000;

function prefs() {
  const p = getPreferenceValues<Preferences>();
  return {
    url: !p.navidromeUrl || p.navidromeUrl.includes(".ts.net") ? NAVIDROME_URL : p.navidromeUrl.replace(/\/+$/, ""),
    user: p.navidromeUser ?? "",
    password: p.navidromePassword ?? "",
  };
}

export function hasNavidromeCreds(): boolean {
  const { user, password } = prefs();
  return Boolean(user && password);
}

// Subsonic token auth: t = md5(password + salt)
const salt = randomBytes(6).toString("hex");

function authQuery(): URLSearchParams {
  const { user, password } = prefs();
  const token = createHash("md5").update(password + salt).digest("hex");
  return new URLSearchParams({ u: user, t: token, s: salt, v: "1.16.1", c: "raycast-homelab", f: "json" });
}

interface SubsonicEnvelope<T> {
  "subsonic-response": { status: "ok" | "failed"; error?: { message: string } } & T;
}

async function subsonic<T>(endpoint: string, params: Record<string, string> = {}): Promise<T> {
  const { url } = prefs();
  const qs = authQuery();
  for (const [k, v] of Object.entries(params)) qs.set(k, v);
  const res = await fetch(`${url}/rest/${endpoint}?${qs}`, { signal: AbortSignal.timeout(TIMEOUT_MS) });
  if (!res.ok) throw new Error(`Navidrome ${endpoint} → HTTP ${res.status}`);
  const body = (await res.json()) as SubsonicEnvelope<T>;
  const r = body["subsonic-response"];
  if (r.status !== "ok") throw new Error(r.error?.message ?? "Subsonic error");
  return r as T;
}

export function coverUrl(coverArtId: string, size = 300): string {
  const { url } = prefs();
  const qs = authQuery();
  qs.set("id", coverArtId);
  qs.set("size", String(size));
  return `${url}/rest/getCoverArt?${qs}`;
}

export function albumWebUrl(albumId: string): string {
  return `${prefs().url}/app/#/album/${albumId}/show`;
}

export interface Album {
  id: string;
  name: string;
  artist: string;
  year?: number;
  songCount: number;
  duration: number; // seconds
  coverArt?: string;
  genre?: string;
}

export interface Song {
  id: string;
  title: string;
  track?: number;
  discNumber?: number;
  duration?: number;
  artist?: string;
  suffix?: string;
  bitRate?: number;
}

interface RawAlbum {
  id: string;
  name: string;
  artist: string;
  year?: number;
  songCount: number;
  duration: number;
  coverArt?: string;
  genre?: string;
}

function mapAlbum(a: RawAlbum): Album {
  return { ...a };
}

export type AlbumSort = "newest" | "recent" | "frequent" | "random" | "alphabeticalByName";

export const ALBUM_SORTS: { id: AlbumSort; title: string }[] = [
  { id: "newest", title: "Recently Added" },
  { id: "recent", title: "Recently Played" },
  { id: "frequent", title: "Most Played" },
  { id: "random", title: "Random" },
  { id: "alphabeticalByName", title: "A–Z" },
];

const PAGE_SIZE = 40;

export async function listAlbums(sort: AlbumSort, page: number): Promise<{ albums: Album[]; hasMore: boolean }> {
  const r = await subsonic<{ albumList2?: { album?: RawAlbum[] } }>("getAlbumList2", {
    type: sort,
    size: String(PAGE_SIZE),
    offset: String(page * PAGE_SIZE),
  });
  const albums = (r.albumList2?.album ?? []).map(mapAlbum);
  // "random" returns a fresh shuffle per call — paging it would loop forever
  return { albums, hasMore: sort !== "random" && albums.length === PAGE_SIZE };
}

export async function searchAlbums(query: string): Promise<Album[]> {
  const r = await subsonic<{ searchResult3?: { album?: RawAlbum[] } }>("search3", {
    query,
    albumCount: "40",
    songCount: "0",
    artistCount: "0",
  });
  return (r.searchResult3?.album ?? []).map(mapAlbum);
}

export async function getAlbumSongs(albumId: string): Promise<{ album: Album; songs: Song[] }> {
  const r = await subsonic<{ album?: RawAlbum & { song?: Song[] } }>("getAlbum", { id: albumId });
  if (!r.album) throw new Error("Album not found");
  const { song, ...rest } = r.album;
  return { album: mapAlbum(rest), songs: song ?? [] };
}

export function fmtDuration(seconds?: number): string {
  if (!seconds) return "";
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);
  if (m >= 60) return `${Math.floor(m / 60)}h ${m % 60}m`;
  return `${m}:${String(s).padStart(2, "0")}`;
}
