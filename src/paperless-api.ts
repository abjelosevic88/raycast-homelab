import { environment } from "@raycast/api";
import { createHash, randomUUID } from "crypto";
import { lstat, mkdir, open, rename, unlink } from "fs/promises";
import type { FileHandle } from "fs/promises";
import { homedir } from "os";
import { extname, join } from "path";

import { ConfigError, has, requireUrl, setting } from "./config";

const TIMEOUT_MS = 20000;
const DOWNLOAD_TIMEOUT_MS = 120000;
const MAX_FILE_BYTES = 100 * 1024 * 1024;

export interface PaperlessDocument {
  id: number;
  title: string;
  /** Listing content is truncated; getDocument returns the full extracted text. */
  content: string;
  created: string;
  added: string;
  modified: string;
  correspondent: number | null;
  document_type: number | null;
  tags: number[];
  original_file_name: string | null;
  archived_file_name: string | null;
  archive_serial_number: number | null;
  page_count?: number | null;
  mime_type?: string;
  __search_hit__?: { highlights: string; score: number; rank: number };
}

export interface PaperlessPage<T = PaperlessDocument> {
  count: number;
  next: string | null;
  previous: string | null;
  results: T[];
}

export interface PaperlessMetadata {
  correspondents: Record<number, string>;
  documentTypes: Record<number, string>;
  tags: Record<number, { name: string; color?: string }>;
}

export function hasPaperlessCredentials(): boolean {
  return has("paperlessUrl", "paperlessToken");
}

function baseUrl(): string {
  const value = requireUrl("paperlessUrl", "Paperless");
  try {
    const parsed = new URL(value);
    if (
      !["https:", "http:"].includes(parsed.protocol) ||
      parsed.username ||
      parsed.password ||
      parsed.search ||
      parsed.hash
    ) {
      throw new Error();
    }
  } catch {
    throw new ConfigError(
      "Paperless URL must be an HTTP(S) base URL without credentials, a query or a fragment",
    );
  }
  return value;
}

function token(): string {
  const value = setting("paperlessToken");
  if (!value) {
    throw new ConfigError(
      "Paperless API token is not set — configure paperlessToken or PAPERLESS_TOKEN in the env file",
    );
  }
  return value;
}

function documentId(id: number): number {
  if (!Number.isSafeInteger(id) || id < 1)
    throw new Error("Invalid Paperless document ID");
  return id;
}

function transferError(error: unknown, signal?: AbortSignal): never {
  // Preserve user cancellation so usePromise can discard obsolete searches.
  if (signal?.aborted) throw signal.reason;
  if (
    error instanceof Error &&
    ["TimeoutError", "AbortError"].includes(error.name)
  ) {
    throw new Error(
      "Paperless request timed out — check the server connection and try again",
    );
  }
  throw new Error(
    "Paperless is unreachable — check its URL and your network connection",
  );
}

async function request(
  path: string,
  signal?: AbortSignal,
  timeout = TIMEOUT_MS,
): Promise<Response> {
  const url = `${baseUrl()}/api/${path}`;
  const authorization = `Token ${token()}`;
  let response: Response;
  try {
    const deadline = AbortSignal.timeout(timeout);
    response = await fetch(url, {
      headers: { Authorization: authorization },
      signal: signal ? AbortSignal.any([signal, deadline]) : deadline,
      // An SSO/login redirect is not an API response. Keep credentials at the configured host.
      redirect: "manual",
    });
  } catch (error) {
    transferError(error, signal);
  }
  if (response.status === 401)
    throw new Error("Paperless authentication failed — check the API token");
  if (response.status === 403)
    throw new Error(
      "Paperless access denied — check the token user's view permissions and any access proxy",
    );
  if (response.status >= 300 && response.status < 400) {
    throw new Error(
      "Paperless redirected to another page — use the direct API base URL and check any sign-in proxy",
    );
  }
  if (response.status === 400)
    throw new Error(
      "Paperless rejected the request — check your search syntax",
    );
  if (response.status === 404)
    throw new Error("Paperless document or API endpoint was not found");
  if (!response.ok)
    throw new Error(`Paperless request failed (HTTP ${response.status})`);
  return response;
}

async function json<T>(path: string, signal?: AbortSignal): Promise<T> {
  const response = await request(path, signal);
  if (!response.headers.get("content-type")?.includes("application/json")) {
    throw new Error(
      "Paperless returned a page instead of JSON — check the URL and any sign-in proxy",
    );
  }
  try {
    return (await response.json()) as T;
  } catch (error) {
    if (error instanceof SyntaxError)
      throw new Error("Paperless returned an invalid JSON response");
    transferError(error, signal);
  }
}

/** Blank queries show recent uploads; full text queries retain server relevance order. */
export async function searchDocuments(
  query: string,
  page = 1,
  signal?: AbortSignal,
): Promise<PaperlessPage> {
  if (!Number.isSafeInteger(page) || page < 1)
    throw new Error("Invalid Paperless page number");
  const params = new URLSearchParams({
    page: String(page),
    page_size: "50",
    truncate_content: "true",
  });
  if (query.trim()) params.set("query", query.trim());
  else params.set("ordering", "-added");
  return json<PaperlessPage>(`documents/?${params}`, signal);
}

export function getDocument(
  id: number,
  signal?: AbortSignal,
): Promise<PaperlessDocument> {
  return json<PaperlessDocument>(`documents/${documentId(id)}/`, signal);
}

interface NamedObject {
  id: number;
  name: string;
  color?: string;
}

async function namedObjects(
  endpoint: string,
  signal?: AbortSignal,
): Promise<NamedObject[]> {
  const result: NamedObject[] = [];
  for (let page = 1; page <= 100; page += 1) {
    // Build each page on the configured origin instead of following server-provided next URLs.
    const data = await json<PaperlessPage<NamedObject>>(
      `${endpoint}/?page_size=100&page=${page}`,
      signal,
    );
    result.push(...data.results);
    if (!data.next) return result;
  }
  throw new Error(
    "Paperless metadata exceeds 10,000 items — open Paperless to view all labels",
  );
}

/** Load once per command, separately from search so missing label permissions do not block documents. */
export async function getPaperlessMetadata(
  signal?: AbortSignal,
): Promise<PaperlessMetadata> {
  const [correspondents, documentTypes, tags] = await Promise.all([
    namedObjects("correspondents", signal),
    namedObjects("document_types", signal),
    namedObjects("tags", signal),
  ]);
  return {
    correspondents: Object.fromEntries(
      correspondents.map((item) => [item.id, item.name]),
    ),
    documentTypes: Object.fromEntries(
      documentTypes.map((item) => [item.id, item.name]),
    ),
    tags: Object.fromEntries(
      tags.map((item) => [item.id, { name: item.name, color: item.color }]),
    ),
  };
}

export function documentWebUrl(id: number): string {
  return `${baseUrl()}/documents/${documentId(id)}/details`;
}

function extension(document: PaperlessDocument, archive: boolean): string {
  if (archive) return ".pdf";
  const suffix = extname(document.original_file_name || "").toLowerCase();
  if (/^\.[a-z0-9]{1,10}$/.test(suffix)) return suffix;
  const mimeExtensions: Record<string, string> = {
    "application/pdf": ".pdf",
    "image/jpeg": ".jpg",
    "image/png": ".png",
    "image/tiff": ".tiff",
    "text/plain": ".txt",
    "message/rfc822": ".eml",
  };
  return mimeExtensions[document.mime_type || ""] || ".bin";
}

function safeTitle(document: PaperlessDocument): string {
  let title = document.title
    .replace(/[^\p{L}\p{N} ._-]/gu, "-")
    .replace(/^\.+/, "")
    .trim();
  while (Buffer.byteLength(title) > 140)
    title = Array.from(title).slice(0, -1).join("");
  return title || "Document";
}

async function writeResponse(
  response: Response,
  file: FileHandle,
): Promise<void> {
  if (!response.body) throw new Error("Paperless returned an empty file");
  const mime = response.headers.get("content-type")?.split(";")[0].trim();
  if (mime === "text/html" || mime === "application/json") {
    await response.body.cancel();
    throw new Error(
      "Paperless returned a page instead of a document — check any sign-in proxy",
    );
  }
  if (Number(response.headers.get("content-length")) > MAX_FILE_BYTES) {
    await response.body.cancel();
    throw new Error(
      "Document exceeds the 100 MB download limit — download it from Paperless",
    );
  }
  const reader = response.body.getReader();
  let size = 0;
  try {
    while (true) {
      let chunk: ReadableStreamReadResult<Uint8Array>;
      try {
        chunk = await reader.read();
      } catch (error) {
        transferError(error);
      }
      if (chunk.done) break;
      size += chunk.value.length;
      if (size > MAX_FILE_BYTES)
        throw new Error(
          "Document exceeds the 100 MB download limit — download it from Paperless",
        );
      await file.writeFile(chunk.value);
    }
    if (!size) throw new Error("Paperless returned an empty file");
  } finally {
    await reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
}

/** Download the authenticated file for native preview. Archive PDF is preferred by Paperless. */
export async function previewDocument(
  document: PaperlessDocument,
): Promise<string> {
  const id = documentId(document.id);
  const scope = createHash("sha256")
    .update(`${baseUrl()}\0${token()}`)
    .digest("hex")
    .slice(0, 16);
  const revision = createHash("sha256")
    .update(document.modified || "")
    .digest("hex")
    .slice(0, 12);
  const directory = join(environment.supportPath, "paperless-previews", scope);
  const target = join(
    directory,
    `${id}-${revision}${extension(document, Boolean(document.archived_file_name))}`,
  );
  const existing = await lstat(target).catch(() => undefined);
  if (existing?.isFile() && existing.size > 0) return target;
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const response = await request(
    `documents/${id}/preview/`,
    undefined,
    DOWNLOAD_TIMEOUT_MS,
  );
  const temporary = `${target}.${randomUUID()}.part`;
  const file = await open(temporary, "wx", 0o600);
  try {
    await writeResponse(response, file);
    await file.close();
    await rename(temporary, target);
    return target;
  } catch (error) {
    await file.close().catch(() => undefined);
    await unlink(temporary).catch(() => undefined);
    throw error;
  }
}

/** Save without replacing any existing file, including files with the same title. */
export async function downloadDocument(
  document: PaperlessDocument,
  variant: "original" | "archive" = "original",
): Promise<string> {
  const id = documentId(document.id);
  const archive = variant === "archive";
  if (archive && !document.archived_file_name)
    throw new Error("This document has no archive PDF");
  const directory = join(homedir(), "Downloads");
  await mkdir(directory, { recursive: true });
  const stem = `${safeTitle(document)} - ${id}${archive ? " - archive" : ""}`;
  const suffix = extension(document, archive);
  const response = await request(
    `documents/${id}/download/?original=${!archive}`,
    undefined,
    DOWNLOAD_TIMEOUT_MS,
  );
  for (let attempt = 0; attempt < 1000; attempt += 1) {
    const target = join(
      directory,
      `${stem}${attempt ? ` (${attempt})` : ""}${suffix}`,
    );
    let file: FileHandle;
    try {
      file = await open(target, "wx", 0o600);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EEXIST") continue;
      await response.body?.cancel();
      throw error;
    }
    try {
      await writeResponse(response, file);
      await file.close();
      return target;
    } catch (error) {
      await file.close().catch(() => undefined);
      await unlink(target).catch(() => undefined);
      throw error;
    }
  }
  await response.body?.cancel();
  throw new Error(
    "Too many downloads with this filename — rename existing copies and try again",
  );
}
