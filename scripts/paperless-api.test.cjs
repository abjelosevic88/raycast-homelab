const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const { readFileSync } = require("node:fs");
const { tmpdir } = require("node:os");
const path = require("node:path");
const { test } = require("node:test");
const ts = require("typescript");

const source = ts.transpileModule(
  readFileSync(path.join(__dirname, "../src/paperless-api.ts"), "utf8"),
  {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2022,
    },
  },
).outputText;

const document = {
  id: 12,
  title: "Invoice",
  content: "Full OCR text",
  created: "2026-09-01",
  added: "2026-09-02T10:00:00Z",
  modified: "2026-09-02T10:00:00Z",
  correspondent: 1,
  document_type: 2,
  tags: [3],
  original_file_name: "scan.png",
  archived_file_name: "scan.pdf",
  archive_serial_number: 7,
  mime_type: "image/png",
};

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

async function fixture(t, handler) {
  const root = await fs.mkdtemp(path.join(tmpdir(), "paperless-api-test-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const settings = {
    paperlessUrl: "https://paperless.example.test/subpath",
    paperlessToken: "test-token",
  };
  const calls = [];
  const fakeFetch = async (url, options) => {
    calls.push({ url: new URL(url), options });
    return handler(new URL(url), options, calls.length);
  };
  const config = {
    ConfigError: class extends Error {},
    has: (...names) => names.every((name) => settings[name]),
    setting: (name) => settings[name] || "",
    requireUrl: (name) => {
      if (!settings[name]) throw new Error("URL is not set");
      return settings[name].replace(/\/+$/, "");
    },
  };
  const fakeRequire = (name) => {
    if (name === "@raycast/api")
      return { environment: { supportPath: path.join(root, "support") } };
    if (name === "./config") return config;
    if (name === "os") return { homedir: () => root };
    return require(name);
  };
  const exports = {};
  new Function("require", "exports", "fetch", source)(
    fakeRequire,
    exports,
    fakeFetch,
  );
  return { api: exports, root, calls, settings };
}

test("OCR search encodes query, preserves server relevance/pagination and authenticates only in headers", async (t) => {
  const page = {
    count: 73,
    next: "https://ignored.example/page2",
    previous: null,
    results: [document],
  };
  const { api, calls } = await fixture(t, () => json(page));
  assert.deepEqual(
    await api.searchDocuments('  invoice & title:"a/b"  ', 2),
    page,
  );
  const { url, options } = calls[0];
  assert.equal(url.pathname, "/subpath/api/documents/");
  assert.equal(url.searchParams.get("query"), 'invoice & title:"a/b"');
  assert.equal(url.searchParams.get("page"), "2");
  assert.equal(url.searchParams.get("page_size"), "50");
  assert.equal(url.searchParams.get("truncate_content"), "true");
  assert.equal(url.searchParams.has("ordering"), false);
  assert.equal(url.href.includes("test-token"), false);
  assert.equal(options.headers.Authorization, "Token test-token");
  assert.equal(options.redirect, "manual");
  assert.ok(options.signal instanceof AbortSignal);
});

test("blank queries show recent additions; document details request untruncated OCR", async (t) => {
  const { api, calls } = await fixture(t, (url) =>
    json(
      url.pathname.endsWith("/12/")
        ? document
        : { count: 0, next: null, previous: null, results: [] },
    ),
  );
  await api.searchDocuments(" \n ");
  assert.equal(calls[0].url.searchParams.has("query"), false);
  assert.equal(calls[0].url.searchParams.get("ordering"), "-added");
  assert.deepEqual(await api.getDocument(12), document);
  assert.equal(calls[1].url.pathname, "/subpath/api/documents/12/");
  assert.equal(calls[1].url.search, "");
  assert.equal(
    api.documentWebUrl(12),
    "https://paperless.example.test/subpath/documents/12/details",
  );
});

test("missing credentials and unsafe base URLs fail before a request", async (t) => {
  const { api, settings, calls } = await fixture(t, () => {
    throw new Error("unexpected fetch");
  });
  settings.paperlessToken = "";
  assert.equal(api.hasPaperlessCredentials(), false);
  await assert.rejects(api.searchDocuments(""), /token is not set/);
  settings.paperlessToken = "test-token";
  for (const url of [
    "file:///etc",
    "https://user:secret@example.test",
    "https://example.test?token=secret",
  ]) {
    settings.paperlessUrl = url;
    await assert.rejects(api.searchDocuments(""), /HTTP\(S\) base URL/);
  }
  assert.equal(calls.length, 0);
});

test("authentication, permissions, redirects and unavailable server errors are explicit and redact bodies", async (t) => {
  for (const [status, expected] of [
    [401, /authentication failed/],
    [403, /access denied/],
    [302, /redirected/],
    [400, /search syntax/],
    [404, /not found/],
    [503, /HTTP 503/],
  ]) {
    const { api } = await fixture(
      t,
      () => new Response("private upstream body", { status }),
    );
    await assert.rejects(
      api.searchDocuments(""),
      (error) =>
        expected.test(error.message) && !error.message.includes("private"),
    );
  }
  const { api } = await fixture(t, () => {
    throw new Error("private network detail");
  });
  await assert.rejects(api.searchDocuments(""), /Paperless is unreachable/);
});

test("caller abort remains distinguishable from a request timeout", async (t) => {
  const { api } = await fixture(t, (url, options) => {
    if (options.signal.aborted) throw options.signal.reason;
    throw new DOMException("internal timeout", "TimeoutError");
  });
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(api.searchDocuments("", 1, controller.signal), {
    name: "AbortError",
  });
  await assert.rejects(api.getDocument(12), /request timed out/);
});

test("metadata follows all pages on configured host without trusting next URLs", async (t) => {
  const { api, calls } = await fixture(t, (url) => {
    if (url.pathname.endsWith("/correspondents/")) {
      const page = url.searchParams.get("page");
      return json({
        count: 2,
        next: page === "1" ? "https://untrusted.test/?credential=steal" : null,
        previous: null,
        results: [{ id: Number(page), name: `Sender ${page}` }],
      });
    }
    if (url.pathname.endsWith("/tags/"))
      return json({
        count: 1,
        next: null,
        previous: null,
        results: [{ id: 3, name: "Bills", color: "#aabbcc" }],
      });
    return json({
      count: 1,
      next: null,
      previous: null,
      results: [{ id: 2, name: "Invoice" }],
    });
  });
  assert.deepEqual(await api.getPaperlessMetadata(), {
    correspondents: { 1: "Sender 1", 2: "Sender 2" },
    documentTypes: { 2: "Invoice" },
    tags: { 3: { name: "Bills", color: "#aabbcc" } },
  });
  assert.equal(calls.length, 4);
  assert.ok(
    calls.every(({ url }) => url.origin === "https://paperless.example.test"),
  );
});

test("downloads stay inside Downloads, preserve extensions and never overwrite an existing file", async (t) => {
  const { api, calls, root } = await fixture(
    t,
    () =>
      new Response("file bytes", {
        headers: {
          "Content-Type": "image/png",
          "Content-Disposition": 'attachment; filename="../../stolen.pdf"',
        },
      }),
  );
  const hostileName = {
    ...document,
    title: "../../folder/Invoice: ".repeat(20),
    original_file_name: "../../picture.PNG",
  };
  const first = await api.downloadDocument(hostileName);
  await fs.writeFile(first, "existing contents");
  const second = await api.downloadDocument(hostileName);
  assert.equal(path.dirname(first), path.join(root, "Downloads"));
  assert.equal(path.dirname(second), path.join(root, "Downloads"));
  assert.equal(path.extname(first), ".png");
  assert.notEqual(first, second);
  assert.equal(await fs.readFile(first, "utf8"), "existing contents");
  assert.equal(await fs.readFile(second, "utf8"), "file bytes");
  assert.equal((await fs.stat(second)).mode & 0o777, 0o600);
  assert.ok(
    calls.every(({ url }) => url.searchParams.get("original") === "true"),
  );
  const archive = await api.downloadDocument(document, "archive");
  assert.equal(path.extname(archive), ".pdf");
  assert.equal(calls.at(-1).url.searchParams.get("original"), "false");
  await assert.rejects(
    api.downloadDocument({ ...document, archived_file_name: null }, "archive"),
    /no archive PDF/,
  );
});

test("preview cache uses private files and separates servers, users and revisions", async (t) => {
  const { api, calls, settings } = await fixture(
    t,
    () =>
      new Response("%PDF-test", {
        headers: { "Content-Type": "application/pdf" },
      }),
  );
  const first = await api.previewDocument(document);
  assert.equal(path.extname(first), ".pdf");
  assert.equal((await fs.stat(first)).mode & 0o777, 0o600);
  assert.equal(await api.previewDocument(document), first);
  assert.equal(calls.length, 1);
  const revised = await api.previewDocument({
    ...document,
    modified: "2026-09-03T10:00:00Z",
  });
  assert.notEqual(revised, first);
  settings.paperlessUrl = "https://second.example.test";
  const secondServer = await api.previewDocument(document);
  assert.notEqual(secondServer, first);
  settings.paperlessToken = "second-user-token";
  assert.notEqual(await api.previewDocument(document), secondServer);
  assert.ok(
    calls.every(({ url }) => url.pathname.endsWith("/preview/") && !url.search),
  );
});

test("failed, empty or oversized transfers remove partial downloads", async (t) => {
  const responses = [
    () => new Response("login", { headers: { "Content-Type": "text/html" } }),
    () => new Response("", { headers: { "Content-Type": "application/pdf" } }),
    () =>
      new Response("oversize", {
        headers: {
          "Content-Length": String(101 * 1024 * 1024),
          "Content-Type": "application/pdf",
        },
      }),
    () =>
      new Response(
        new ReadableStream({
          start(controller) {
            controller.error(new Error("private transfer failure"));
          },
        }),
        { headers: { "Content-Type": "application/pdf" } },
      ),
  ];
  for (const response of responses) {
    const { api, root } = await fixture(t, response);
    await assert.rejects(api.downloadDocument(document));
    assert.deepEqual(await fs.readdir(path.join(root, "Downloads")), []);
  }
});
