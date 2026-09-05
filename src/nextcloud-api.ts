import { XMLParser, XMLValidator } from "fast-xml-parser";
import { mkdir, open, unlink } from "fs/promises";
import { homedir } from "os";
import { basename, extname, join } from "path";
import { ConfigError, has, requireUrl, setting } from "./config";

export interface CloudFile {
  id: string;
  path: string;
  name: string;
  directory: boolean;
  size: number;
  mime: string;
  modified: string;
  excerpts: { source: string; excerpt: string }[];
}
/** Tesseract stores PDF OCR in parts.ocr, but image OCR in the main content field. */
export function isOcrExcerpt(
  file: Pick<CloudFile, "mime">,
  excerpt: CloudFile["excerpts"][number],
): boolean {
  return (
    excerpt.source === "parts.ocr" ||
    (file.mime.startsWith("image/") && excerpt.source === "content")
  );
}

export interface SearchOptions {
  mode: "dav" | "all" | "content" | "filename";
  extension: string;
  ocrOnly: boolean;
}
export const defaultSearch: SearchOptions = {
  mode: "all",
  extension: "",
  ocrOnly: false,
};
export interface FilePage {
  files: CloudFile[];
  hasMore: boolean;
  truncated?: boolean;
}
export interface CloudShare {
  id: string;
  url: string;
  expiration: string | null;
  share_type: number;
  permissions: number;
}

export function hasNextcloudCredentials() {
  return has("nextcloudUrl", "nextcloudUsername", "nextcloudAppPassword");
}
function baseUrl() {
  const value = requireUrl("nextcloudUrl", "Nextcloud");
  const url = new URL(value);
  if (
    !["http:", "https:"].includes(url.protocol) ||
    url.username ||
    url.password ||
    url.search ||
    url.hash
  )
    throw new ConfigError(
      "Nextcloud URL must be an HTTP(S) base URL without credentials, query or fragment",
    );
  return value;
}
function normalizedPath(path: string) {
  const parts = path.split("/").filter(Boolean);
  if (
    parts.some(
      (part) =>
        part === "." ||
        part === ".." ||
        Array.from(part).some((character) => character.charCodeAt(0) < 32),
    )
  )
    throw new Error("Invalid Nextcloud file path");
  return "/" + parts.join("/");
}
function encodedPath(path: string) {
  return normalizedPath(path).split("/").map(encodeURIComponent).join("/");
}
function davRoot() {
  return `/remote.php/dav/files/${encodeURIComponent(setting("nextcloudUsername"))}`;
}
export function fileWebUrl(file: CloudFile) {
  if (!/^\d+$/.test(file.id)) throw new Error("Invalid Nextcloud file ID");
  return `${baseUrl()}/index.php/f/${file.id}`;
}
async function request(
  path: string,
  init: RequestInit = {},
  signal?: AbortSignal,
  timeout = 30000,
) {
  const base = baseUrl();
  if (!hasNextcloudCredentials())
    throw new ConfigError(
      "Set Nextcloud URL, username and app password in extension preferences",
    );
  let response: Response;
  try {
    response = await fetch(base + path, {
      ...init,
      headers: {
        Authorization: `Basic ${Buffer.from(`${setting("nextcloudUsername")}:${setting("nextcloudAppPassword")}`).toString("base64")}`,
        "OCS-APIRequest": "true",
        ...init.headers,
      },
      redirect: "manual",
      signal: signal
        ? AbortSignal.any([signal, AbortSignal.timeout(timeout)])
        : AbortSignal.timeout(timeout),
    });
  } catch {
    if (signal?.aborted) throw signal.reason;
    throw new Error(
      "Nextcloud is unreachable or the request timed out — check the URL and network",
    );
  }
  if (!response.ok) {
    await response.body?.cancel();
    if (response.status === 401)
      throw new Error(
        "Nextcloud authentication failed — check your username and app password",
      );
    if (response.status === 403)
      throw new Error(
        "Nextcloud access denied — check file permissions and sharing policy",
      );
    if (response.status >= 300 && response.status < 400)
      throw new Error(
        "Nextcloud redirected the request — check its base URL and sign-in proxy",
      );
    if (path.includes("/fulltextsearch/"))
      throw new Error(
        `Full-text search unavailable (HTTP ${response.status}) — check the search apps and Elasticsearch, or select File Names (WebDAV)`,
      );
    throw new Error(`Nextcloud request failed (HTTP ${response.status})`);
  }
  return response;
}
async function json<T>(
  path: string,
  init: RequestInit = {},
  signal?: AbortSignal,
): Promise<T> {
  const response = await request(path, init, signal);
  if (!response.headers.get("content-type")?.includes("application/json"))
    throw new Error(
      "Nextcloud returned a page instead of JSON — check the URL and sign-in proxy",
    );
  return (await response.json()) as T;
}
async function ocs<T>(
  path: string,
  init: RequestInit = {},
  signal?: AbortSignal,
): Promise<T> {
  const data = await json<{
    ocs: { meta: { status: string; statuscode: number }; data: T };
  }>(
    `/ocs/v2.php${path}${path.includes("?") ? "&" : "?"}format=json`,
    init,
    signal,
  );
  if (!data.ocs || data.ocs.meta.status !== "ok")
    throw new Error(
      `Nextcloud rejected the operation (OCS ${data.ocs?.meta.statuscode ?? "invalid response"}) — check permissions and server policy`,
    );
  return data.ocs.data;
}
const xml = (s: string) =>
  s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
const properties =
  "<d:displayname/><d:getcontentlength/><d:getcontenttype/><d:getlastmodified/><d:resourcetype/><oc:fileid/>";
const parser = new XMLParser({
  removeNSPrefix: true,
  parseTagValue: false,
  ignoreAttributes: false,
  processEntities: true,
  isArray: (name) => ["response", "propstat"].includes(name),
});
interface DavResponse {
  href: string;
  propstat: { status: string; prop: Record<string, unknown> }[];
}
export function parseDav(body: string): CloudFile[] {
  if (/<!DOCTYPE|<!ENTITY/i.test(body) || XMLValidator.validate(body) !== true)
    throw new Error("Nextcloud returned invalid WebDAV XML");
  const data = parser.parse(body);
  if (!data.multistatus)
    throw new Error("Nextcloud returned a page instead of a WebDAV response");
  const root = new URL(baseUrl() + davRoot()).pathname + "/";
  return (data.multistatus.response || []).flatMap(
    (item: DavResponse): CloudFile[] => {
      const prop = Object.assign(
        {},
        ...item.propstat
          .filter((p) => /\s200\s/.test(p.status))
          .map((p) => p.prop),
      );
      const href = new URL(item.href, baseUrl());
      // Ignore foreign/malformed hrefs; never follow a server-supplied download URL.
      if (
        href.origin !== new URL(baseUrl()).origin ||
        !href.pathname.startsWith(root)
      )
        return [];
      const path = normalizedPath(
        decodeURIComponent(href.pathname.slice(root.length)),
      );
      const id = String(prop.fileid || "");
      if (!/^\d+$/.test(id)) return [];
      return [
        {
          id,
          path,
          name: basename(path),
          directory:
            typeof prop.resourcetype === "object" &&
            prop.resourcetype !== null &&
            "collection" in prop.resourcetype,
          size: Number(prop.getcontentlength || 0),
          mime: String(prop.getcontenttype || ""),
          modified: String(prop.getlastmodified || ""),
          excerpts: [],
        },
      ];
    },
  );
}
function extensionFilter(extension: string) {
  const value = extension.trim().replace(/^\./, "").toLowerCase();
  if (value && !/^[a-z0-9]{1,16}$/.test(value))
    throw new Error("Enter one file extension, such as pdf, png or docx");
  return value;
}
export async function browseFiles(
  folder: string,
  signal?: AbortSignal,
): Promise<FilePage> {
  const path = normalizedPath(folder);
  const response = await request(
    davRoot() + encodedPath(path),
    {
      method: "PROPFIND",
      headers: { Depth: "1", "Content-Type": "application/xml" },
      body: `<?xml version="1.0"?><d:propfind xmlns:d="DAV:" xmlns:oc="http://owncloud.org/ns"><d:prop>${properties}</d:prop></d:propfind>`,
    },
    signal,
  );
  return {
    files: parseDav(await response.text())
      .filter((file) => file.path !== path)
      .sort(
        (a, b) =>
          Number(b.directory) - Number(a.directory) ||
          a.name.localeCompare(b.name),
      ),
    hasMore: false,
  };
}
export async function searchFiles(
  query: string,
  options: SearchOptions,
  page = 1,
  signal?: AbortSignal,
): Promise<FilePage> {
  if (!Number.isInteger(page) || page < 1)
    throw new Error("Invalid search page");
  const extension = extensionFilter(options.extension);
  if (!query.trim() || options.mode === "dav") {
    // Search scope is relative to the DAV endpoint, including for subpath installs.
    const conditions = ["<d:not><d:is-collection/></d:not>"];
    if (query.trim())
      conditions.push(
        `<d:like><d:prop><d:displayname/></d:prop><d:literal>${xml("%" + query.trim().replace(/[\\%_]/g, "\\$&") + "%")}</d:literal></d:like>`,
      );
    if (extension)
      conditions.push(
        `<d:like><d:prop><d:displayname/></d:prop><d:literal>%.${xml(extension)}</d:literal></d:like>`,
      );
    const response = await request(
      "/remote.php/dav/",
      {
        method: "SEARCH",
        headers: { "Content-Type": "application/xml" },
        body: `<?xml version="1.0"?><d:searchrequest xmlns:d="DAV:" xmlns:oc="http://owncloud.org/ns"><d:basicsearch><d:select><d:prop>${properties}</d:prop></d:select><d:from><d:scope><d:href>${xml(`/files/${encodeURIComponent(setting("nextcloudUsername"))}/`)}</d:href><d:depth>infinity</d:depth></d:scope></d:from><d:where><d:and>${conditions.join("")}</d:and></d:where><d:orderby><d:order><d:prop><d:getlastmodified/></d:prop><d:descending/></d:order></d:orderby><d:limit><d:nresults>201</d:nresults></d:limit></d:basicsearch></d:searchrequest>`,
      },
      signal,
    );
    const files = parseDav(await response.text());
    return {
      files: files.slice(0, 200),
      hasMore: false,
      truncated: files.length > 200,
    };
  }
  const searchOptions: Record<string, unknown> = {};
  if (options.mode !== "all") searchOptions.in = [options.mode];
  if (extension) searchOptions.files_extension = extension;
  const params = new URLSearchParams({
    request: JSON.stringify({
      providers: ["files"],
      search: query.trim(),
      page,
      size: 50,
      options: searchOptions,
    }),
  });
  const data = await json<{
    status: number;
    result: {
      provider: { id: string };
      documents: {
        id: string;
        info: {
          path: string;
          file: string;
          type: string;
          size: number;
          mime: string;
          mtime: number;
        };
        excerpts: CloudFile["excerpts"];
      }[];
      meta: { total: number; timedOut: boolean };
    }[];
  }>(`/index.php/apps/fulltextsearch/v1/remote?${params}`, {}, signal);
  if (data.status !== 1 || !Array.isArray(data.result))
    throw new Error(
      "Nextcloud full-text search failed — check Elasticsearch and the file index",
    );
  const result = data.result.find((r) => r.provider.id === "files");
  if (!result)
    throw new Error(
      "Nextcloud file search provider is unavailable — enable Full Text Search - Files",
    );
  if (result.meta.timedOut)
    throw new Error(
      "Elasticsearch search timed out — narrow the query and retry",
    );
  const files = result.documents.map((doc): CloudFile => ({
    id: String(doc.id),
    path: normalizedPath(doc.info.path),
    name: doc.info.file || basename(doc.info.path),
    directory: doc.info.type === "dir",
    size: Number(doc.info.size || 0),
    mime: doc.info.mime || "",
    modified: doc.info.mtime
      ? new Date(doc.info.mtime * 1000).toISOString()
      : "",
    excerpts: doc.excerpts || [],
  }));
  return {
    files:
      options.ocrOnly && options.mode === "all"
        ? files.filter((file) =>
            file.excerpts.some((e) => isOcrExcerpt(file, e)),
          )
        : files,
    hasMore: page * 50 < result.meta.total,
  };
}

/** Stream to a private file without replacing existing downloads; remove incomplete transfers. */
export async function downloadFile(file: CloudFile): Promise<string> {
  if (file.directory)
    throw new Error("Open the folder and select a file to download");
  const directory = join(homedir(), "Downloads");
  await mkdir(directory, { recursive: true });
  let name = basename(normalizedPath(file.path))
    .replace(/[<>:"/\\|?*]/g, "-")
    .replace(/^\.+/, "");
  while (Buffer.byteLength(name) > 200)
    name = Array.from(name).slice(0, -1).join("");
  name ||= "Nextcloud file";
  const suffix = extname(name),
    stem = name.slice(0, name.length - suffix.length);
  const response = await request(
    davRoot() + encodedPath(file.path),
    { headers: { "Accept-Encoding": "identity" } },
    undefined,
    30 * 60 * 1000,
  );
  if (!response.body) throw new Error("Nextcloud returned no download body");
  if (
    response.headers.get("content-type")?.split(";")[0].trim() ===
      "text/html" &&
    file.mime !== "text/html"
  ) {
    await response.body.cancel();
    throw new Error(
      "Nextcloud returned an HTML page instead of the file — check the sign-in proxy",
    );
  }
  for (let n = 0; n < 1000; n++) {
    const target = join(directory, `${stem}${n ? ` (${n})` : ""}${suffix}`);
    let handle;
    try {
      handle = await open(target, "wx", 0o600);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EEXIST") continue;
      await response.body.cancel();
      throw error;
    }
    const reader = response.body.getReader();
    try {
      let size = 0;
      while (true) {
        const chunk = await reader.read();
        if (chunk.done) break;
        await handle.writeFile(chunk.value);
        size += chunk.value.length;
      }
      const length = response.headers.get("content-length");
      if (length !== null && size !== Number(length))
        throw new Error("Incomplete Nextcloud download — try again");
      await handle.close();
      return target;
    } catch (error) {
      await handle.close().catch(() => undefined);
      await unlink(target).catch(() => undefined);
      throw error;
    } finally {
      await reader.cancel().catch(() => undefined);
      reader.releaseLock();
    }
  }
  await response.body.cancel();
  throw new Error("Too many downloads with this filename");
}
export function validateExpiry(expiry: string) {
  const date = new Date(`${expiry}T00:00:00`);
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  if (
    !/^\d{4}-\d{2}-\d{2}$/.test(expiry) ||
    !Number.isFinite(date.getTime()) ||
    date.getFullYear() !== Number(expiry.slice(0, 4)) ||
    date.getMonth() + 1 !== Number(expiry.slice(5, 7)) ||
    date.getDate() !== Number(expiry.slice(8, 10)) ||
    date <= today
  )
    throw new Error("Choose a valid future expiry date (YYYY-MM-DD)");
}
export async function createShare(
  file: CloudFile,
  expiry: string,
  password: string,
): Promise<CloudShare> {
  validateExpiry(expiry);
  const body = new URLSearchParams({
    path: normalizedPath(file.path),
    shareType: "3",
    permissions: "1",
    expireDate: expiry,
  });
  if (password) body.set("password", password);
  return ocs<CloudShare>("/apps/files_sharing/api/v1/shares", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: body.toString(),
  });
}
export async function listShares(
  file: CloudFile,
  signal?: AbortSignal,
): Promise<CloudShare[]> {
  const params = new URLSearchParams({
    path: normalizedPath(file.path),
    reshares: "false",
    subfiles: "false",
  });
  return (
    await ocs<CloudShare[]>(
      `/apps/files_sharing/api/v1/shares?${params}`,
      {},
      signal,
    )
  ).filter((share) => Number(share.share_type) === 3 && share.url);
}
export async function deleteShare(id: string) {
  if (!/^\d+$/.test(id)) throw new Error("Invalid Nextcloud share ID");
  await ocs(`/apps/files_sharing/api/v1/shares/${id}`, { method: "DELETE" });
}
