import { environment, getPreferenceValues } from "@raycast/api";
import { XMLParser } from "fast-xml-parser";
import { existsSync, mkdirSync, writeFileSync } from "fs";
import { homedir } from "os";
import { join } from "path";

interface Preferences {
  calibreUrl?: string;
  calibreUser?: string;
  calibrePassword?: string;
}

export const CALIBRE_URL = "https://reader.bjelke.org";
const TIMEOUT_MS = 20000;

function prefs() {
  const p = getPreferenceValues<Preferences>();
  return {
    url: !p.calibreUrl || p.calibreUrl.includes(".ts.net") ? CALIBRE_URL : p.calibreUrl.replace(/\/+$/, ""),
    user: p.calibreUser || "admin",
    password: p.calibrePassword ?? "",
  };
}

export function hasCalibreCreds(): boolean {
  return Boolean(prefs().password);
}

function basicAuth(): string {
  const { user, password } = prefs();
  return `Basic ${Buffer.from(`${user}:${password}`).toString("base64")}`;
}

export interface BookFormat {
  format: string; // epub, mobi, azw3, pdf…
  href: string;
  size?: number;
}

export interface Book {
  id: number;
  title: string;
  authors: string[];
  year?: string;
  language?: string;
  formats: BookFormat[];
  coverPath?: string; // local cached file, usable as grid content
}

const parser = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: "@_" });

interface OpdsLink {
  "@_rel"?: string;
  "@_href"?: string;
  "@_type"?: string;
  "@_length"?: string;
}
interface OpdsEntry {
  title?: string;
  author?: { name?: string } | { name?: string }[];
  published?: string;
  "dcterms:language"?: string;
  link?: OpdsLink | OpdsLink[];
}

function asArray<T>(v: T | T[] | undefined): T[] {
  return v === undefined ? [] : Array.isArray(v) ? v : [v];
}

async function opds(path: string): Promise<Book[]> {
  const { url } = prefs();
  const res = await fetch(`${url}${path}`, {
    headers: { Authorization: basicAuth() },
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`Calibre-Web OPDS → HTTP ${res.status}`);
  const xml = parser.parse(await res.text()) as { feed?: { entry?: OpdsEntry | OpdsEntry[] } };
  const books: Book[] = [];
  for (const e of asArray(xml.feed?.entry)) {
    const links = asArray(e.link);
    const cover = links.find((l) => l["@_rel"]?.endsWith("/image"))?.["@_href"];
    const id = Number(cover?.match(/\/cover\/(\d+)/)?.[1]);
    if (!id) continue;
    books.push({
      id,
      title: String(e.title ?? "Untitled"),
      authors: asArray(e.author)
        .map((a) => a?.name)
        .filter((n): n is string => Boolean(n)),
      year: e.published?.slice(0, 4),
      language: e["dcterms:language"],
      formats: links
        .filter((l) => l["@_rel"] === "http://opds-spec.org/acquisition" && l["@_href"])
        .map((l) => ({
          format: l["@_href"]?.match(/\/download\/\d+\/([a-z0-9]+)\//i)?.[1]?.toLowerCase() ?? "file",
          href: l["@_href"] ?? "",
          size: l["@_length"] ? Number(l["@_length"]) : undefined,
        })),
    });
  }
  return books;
}

// covers need auth, so they're cached to disk and served as file paths
const coverDir = join(environment.supportPath, "covers");

async function ensureCover(book: Book): Promise<string | undefined> {
  const file = join(coverDir, `${book.id}.jpg`);
  if (existsSync(file)) return file;
  try {
    const { url } = prefs();
    const res = await fetch(`${url}/opds/cover/${book.id}`, {
      headers: { Authorization: basicAuth() },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (!res.ok) return undefined;
    mkdirSync(coverDir, { recursive: true });
    writeFileSync(file, Buffer.from(await res.arrayBuffer()));
    return file;
  } catch {
    return undefined;
  }
}

async function withCovers(books: Book[]): Promise<Book[]> {
  const queue = [...books];
  const workers = Array.from({ length: 6 }, async () => {
    for (let b = queue.shift(); b; b = queue.shift()) b.coverPath = await ensureCover(b);
  });
  await Promise.all(workers);
  return books;
}

export async function searchBooks(query: string): Promise<Book[]> {
  return withCovers(await opds(`/opds/search?query=${encodeURIComponent(query)}`));
}

export async function newBooks(): Promise<Book[]> {
  return withCovers((await opds("/opds/new")).slice(0, 40));
}

export function bookWebUrl(id: number): string {
  return `${prefs().url}/book/${id}`;
}

export async function downloadBook(book: Book, fmt: BookFormat): Promise<string> {
  const { url } = prefs();
  const res = await fetch(`${url}${fmt.href}`, {
    headers: { Authorization: basicAuth() },
    signal: AbortSignal.timeout(120000),
  });
  if (!res.ok) throw new Error(`download → HTTP ${res.status}`);
  const safe = `${book.authors[0] ? `${book.authors[0]} - ` : ""}${book.title}`.replace(/[/\\:*?"<>|]+/g, "-").slice(0, 120);
  const target = join(homedir(), "Downloads", `${safe}.${fmt.format}`);
  writeFileSync(target, Buffer.from(await res.arrayBuffer()));
  return target;
}

// ---------- Send to Kindle: needs the web session, not OPDS ----------

let session: { cookie: string; at: number } | null = null;

async function login(): Promise<string> {
  if (session && Date.now() - session.at < 20 * 60 * 1000) return session.cookie;
  const { url, user, password } = prefs();
  const page = await fetch(`${url}/login`, { signal: AbortSignal.timeout(TIMEOUT_MS), redirect: "manual" });
  const html = await page.text();
  const csrf = html.match(/name="csrf_token"[^>]*value="([^"]+)"/)?.[1] ?? "";
  const cookies0 = (page.headers.getSetCookie?.() ?? []).map((c) => c.split(";")[0]).join("; ");
  const res = await fetch(`${url}/login`, {
    method: "POST",
    redirect: "manual",
    headers: { "Content-Type": "application/x-www-form-urlencoded", Cookie: cookies0 },
    body: new URLSearchParams({ csrf_token: csrf, username: user, password, submit: "", next: "/" }).toString(),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  const cookies = (res.headers.getSetCookie?.() ?? []).map((c) => c.split(";")[0]);
  const merged = [...cookies0.split("; ").filter(Boolean), ...cookies];
  // keep the last value per cookie name
  const map = new Map<string, string>();
  for (const c of merged) {
    const [k] = c.split("=");
    map.set(k, c);
  }
  const cookie = [...map.values()].join("; ");
  if (res.status !== 302 || !cookie.includes("session=")) throw new Error("Calibre-Web login failed — check username/password");
  session = { cookie, at: Date.now() };
  return cookie;
}

export async function sendToKindle(book: Book, fmt: BookFormat): Promise<string> {
  const { url } = prefs();
  const cookie = await login();
  const res = await fetch(`${url}/send/${book.id}/${fmt.format}/0`, {
    headers: { Cookie: cookie },
    signal: AbortSignal.timeout(60000),
  });
  const html = await res.text();
  // flash messages: <div class="alert alert-success">…</div> or alert-danger
  const flash = html.match(/class="alert alert-(success|danger|warning|info)[^"]*"[^>]*>([\s\S]*?)<\/div>/);
  const text = flash?.[2]?.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
  if (!res.ok) throw new Error(`send → HTTP ${res.status}`);
  if (flash && flash[1] === "danger") throw new Error(text || "Calibre-Web reported an error");
  return text || `Queued ${fmt.format.toUpperCase()} for Kindle`;
}
