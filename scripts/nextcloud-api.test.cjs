const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const { readFileSync } = require("node:fs");
const path = require("node:path");
const { tmpdir } = require("node:os");
const { test } = require("node:test");
const ts = require("typescript");
const source = ts.transpileModule(
  readFileSync(path.join(__dirname, "../src/nextcloud-api.ts"), "utf8"),
  {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2022,
    },
  },
).outputText;
const file = {
  id: "42",
  path: "/Documents/Invoice & ć.txt",
  name: "Invoice & ć.txt",
  directory: false,
  size: 5,
  mime: "text/plain",
  modified: "",
  excerpts: [],
};
const json = (data, status = 200) =>
  new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json" },
  });
const ocs = (data) =>
  json({ ocs: { meta: { status: "ok", statuscode: 200 }, data } });
const xml = (entries) =>
  `<d:multistatus xmlns:d="DAV:" xmlns:oc="http://owncloud.org/ns">${entries}</d:multistatus>`;
const entry = (href, id, directory = false) =>
  `<d:response><d:href>${href}</d:href><d:propstat><d:prop><oc:fileid>${id}</oc:fileid><d:getcontentlength>5</d:getcontentlength><d:getcontenttype>text/plain</d:getcontenttype><d:resourcetype>${directory ? "<d:collection/>" : ""}</d:resourcetype></d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat><d:propstat><d:prop><oc:fileid>999</oc:fileid></d:prop><d:status>HTTP/1.1 404 Not Found</d:status></d:propstat></d:response>`;
async function fixture(t, handler) {
  const root = await fs.mkdtemp(path.join(tmpdir(), "nextcloud-api-test-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const settings = {
    nextcloudUrl: "https://cloud.example.test/subpath",
    nextcloudUsername: "user",
    nextcloudAppPassword: "test-secret",
  };
  const calls = [];
  const config = {
    ConfigError: Error,
    has: (...names) => names.every((n) => settings[n]),
    setting: (n) => settings[n] || "",
    requireUrl: (n) => settings[n],
  };
  const fakeRequire = (n) =>
    n === "./config"
      ? config
      : n === "os"
        ? { homedir: () => root }
        : require(n);
  const api = {};
  new Function("require", "exports", "fetch", source)(
    fakeRequire,
    api,
    async (url, options) => {
      calls.push({ url: new URL(url), options });
      return handler(new URL(url), options, calls.length);
    },
  );
  return { api, root, calls, settings };
}
test("WebDAV scopes, XML escaping and filename patterns preserve the configured subpath", async (t) => {
  const { api, calls } = await fixture(
    t,
    () =>
      new Response(
        xml(
          entry(
            "/subpath/remote.php/dav/files/user/Documents/Invoice%20%26%20%C4%87.txt",
            42,
          ),
        ),
        { status: 207 },
      ),
  );
  const page = await api.searchFiles("A & <B>_100%", {
    ...api.defaultSearch,
    mode: "dav",
    extension: ".TXT",
  });
  assert.equal(page.files[0].path, file.path);
  assert.match(calls[0].options.body, /<d:href>\/files\/user\/<\/d:href>/);
  assert.match(calls[0].options.body, /A &amp; &lt;B&gt;\\_100\\%/);
  assert.match(calls[0].options.body, /<d:not><d:is-collection\/><\/d:not>/);
  assert.ok(calls[0].options.body.includes("%.txt"));
  assert.equal(calls[0].url.pathname, "/subpath/remote.php/dav/");
  assert.equal(calls[0].options.redirect, "manual");
  assert.equal(calls[0].options.headers["OCS-APIRequest"], "true");
});
test("DAV parser rejects XML entities, foreign origins and traversal; ignores failed propstats", async (t) => {
  const { api } = await fixture(t, () => {});
  const body = xml(
    entry("/subpath/remote.php/dav/files/user/folder/", 42, true) +
      entry("https://evil.test/subpath/remote.php/dav/files/user/private", 44),
  );
  const result = api.parseDav(body);
  assert.equal(result.length, 1);
  assert.equal(result[0].id, "42");
  assert.equal(result[0].directory, true);
  assert.throws(
    () => api.parseDav('<!DOCTYPE x [<!ENTITY x "hello">]>' + xml("")),
    /invalid/,
  );
  assert.throws(() => api.parseDav("<html>login</html>"), /instead/);
  assert.throws(
    () =>
      api.parseDav(
        xml(entry("/subpath/remote.php/dav/files/user/%2e%2e%2fsecret", 42)),
      ),
    /Invalid/,
  );
});
test("folder browsing omits its own entry and identifies folders", async (t) => {
  const { api, calls } = await fixture(
    t,
    () =>
      new Response(
        xml(
          entry("/subpath/remote.php/dav/files/user/Docs/", 1, true) +
            entry("/subpath/remote.php/dav/files/user/Docs/file.txt", 2) +
            entry("/subpath/remote.php/dav/files/user/Docs/Sub/", 3, true),
        ),
        { status: 207 },
      ),
  );
  const r = await api.browseFiles("/Docs");
  assert.deepEqual(
    r.files.map((f) => f.id),
    ["3", "2"],
  );
  assert.equal(calls[0].options.headers.Depth, "1");
});
test("full text uses authenticated Nextcloud remote API, field filters and server pagination", async (t) => {
  const doc = (id, source) => ({
    id,
    info: {
      path: `/doc${id}.pdf`,
      file: `doc${id}.pdf`,
      type: "file",
      size: 20,
      mime: "application/pdf",
      mtime: 0,
    },
    excerpts: [{ source, excerpt: "<em>invoice</em>" }],
  });
  const { api, calls } = await fixture(t, () =>
    json({
      status: 1,
      result: [
        {
          provider: { id: "files" },
          documents: [doc("1", "content"), doc("2", "parts.ocr")],
          meta: { total: 151, timedOut: false },
        },
      ],
    }),
  );
  const r = await api.searchFiles(
    '"invoice number" +paid -draft',
    { ...api.defaultSearch, extension: "pdf", ocrOnly: true },
    2,
  );
  assert.deepEqual(
    r.files.map((f) => f.id),
    ["2"],
  );
  assert.equal(r.hasMore, true);
  const request = JSON.parse(calls[0].url.searchParams.get("request"));
  assert.deepEqual(request, {
    providers: ["files"],
    search: '"invoice number" +paid -draft',
    page: 2,
    size: 50,
    options: { files_extension: "pdf" },
  });
  assert.equal(
    calls[0].url.pathname,
    "/subpath/index.php/apps/fulltextsearch/v1/remote",
  );
  await api.searchFiles("invoice", { ...api.defaultSearch, mode: "content" });
  assert.deepEqual(
    JSON.parse(calls[1].url.searchParams.get("request")).options.in,
    ["content"],
  );
  await api.searchFiles("invoice", { ...api.defaultSearch, mode: "filename" });
  assert.deepEqual(
    JSON.parse(calls[2].url.searchParams.get("request")).options.in,
    ["filename"],
  );
  await assert.rejects(
    api.searchFiles("invoice", { ...api.defaultSearch, extension: "pdf|.*" }),
    /extension/,
  );
});
test("OCR filtering can leave an empty page without losing next-page navigation", async (t) => {
  const { api } = await fixture(t, () =>
    json({
      status: 1,
      result: [
        {
          provider: { id: "files" },
          documents: [],
          meta: { total: 100, timedOut: false },
        },
      ],
    }),
  );
  assert.deepEqual(
    await api.searchFiles("invoice", { ...api.defaultSearch, ocrOnly: true }),
    { files: [], hasMore: true },
  );
});
test("auth, redirects, OCS errors and index timeouts are explicit and do not expose secrets", async (t) => {
  for (const status of [401, 403, 302, 500]) {
    const { api } = await fixture(
      t,
      () => new Response("private response", { status }),
    );
    await assert.rejects(
      api.searchFiles("text", api.defaultSearch),
      (e) =>
        !e.message.includes("private") && !e.message.includes("test-secret"),
    );
  }
  const a = await fixture(t, () =>
    json({ ocs: { meta: { status: "failure", statuscode: 403 }, data: [] } }),
  );
  await assert.rejects(a.api.listShares(file), /OCS 403/);
  const b = await fixture(t, () =>
    json({
      status: 1,
      result: [
        {
          provider: { id: "files" },
          documents: [],
          meta: { total: 0, timedOut: true },
        },
      ],
    }),
  );
  await assert.rejects(
    b.api.searchFiles("x", b.api.defaultSearch),
    /timed out/,
  );
  const c = await fixture(t, () => {
    throw new Error("private network url");
  });
  const controller = new AbortController();
  controller.abort(new Error("cancelled"));
  await assert.rejects(
    c.api.searchFiles("x", c.api.defaultSearch, 1, controller.signal),
    /cancelled/,
  );
});
test("downloads stream private bytes, encode paths, allow empty files and never overwrite", async (t) => {
  const { api, root, calls } = await fixture(
    t,
    () =>
      new Response("hello", {
        headers: {
          "Content-Length": "5",
          "Content-Disposition": 'attachment; filename="../../evil"',
        },
      }),
  );
  const a = await api.downloadFile(file);
  const b = await api.downloadFile(file);
  assert.notEqual(a, b);
  assert.equal(path.dirname(a), path.join(root, "Downloads"));
  assert.equal(await fs.readFile(a, "utf8"), "hello");
  assert.equal((await fs.stat(a)).mode & 0o777, 0o600);
  assert.equal(
    calls[0].url.pathname,
    "/subpath/remote.php/dav/files/user/Documents/Invoice%20%26%20%C4%87.txt",
  );
  await assert.rejects(
    api.downloadFile({ ...file, path: "/../secret" }),
    /Invalid/,
  );
  const empty = await fixture(
    t,
    () => new Response("", { headers: { "Content-Length": "0" } }),
  );
  assert.equal((await fs.stat(await empty.api.downloadFile(file))).size, 0);
});
test("interrupted and truncated downloads remove partial files", async (t) => {
  for (const response of [
    () => new Response("short", { headers: { "Content-Length": "500" } }),
    () =>
      new Response(
        new ReadableStream({
          start(c) {
            c.error(new Error("transfer interrupted"));
          },
        }),
      ),
  ]) {
    const { api, root } = await fixture(t, response);
    await assert.rejects(api.downloadFile(file));
    assert.deepEqual(await fs.readdir(path.join(root, "Downloads")), []);
  }
});
test("share creation is read only, expiring, password protected, and not retried implicitly", async (t) => {
  const { api, calls } = await fixture(t, () =>
    ocs({
      id: "9",
      url: "https://cloud.example.test/s/share",
      permissions: 1,
      expiration: "2099-12-31",
    }),
  );
  await api.createShare(file, "2099-12-31", "secret & + ü");
  const body = new URLSearchParams(calls[0].options.body);
  assert.equal(body.get("path"), file.path);
  assert.equal(body.get("shareType"), "3");
  assert.equal(body.get("permissions"), "1");
  assert.equal(body.get("expireDate"), "2099-12-31");
  assert.equal(body.get("password"), "secret & + ü");
  assert.equal(calls.length, 1);
  assert.ok(!calls[0].url.href.includes("secret"));
  assert.equal(calls[0].options.method, "POST");
  for (const expiry of ["2000-01-01", "2099-02-31", "bad"])
    await assert.rejects(api.createShare(file, expiry, ""), /future expiry/);
  assert.equal(calls.length, 1);
});
test("share lists show only public links and revocation targets a validated share ID", async (t) => {
  const { api, calls } = await fixture(t, (_, options) =>
    options.method === "DELETE"
      ? ocs([])
      : ocs([
          { id: "1", share_type: 0, url: "private" },
          { id: "2", share_type: 3, url: "https://cloud.example.test/s/token" },
        ]),
  );
  assert.deepEqual(
    (await api.listShares(file)).map((s) => s.id),
    ["2"],
  );
  await api.deleteShare("2");
  assert.equal(calls[1].options.method, "DELETE");
  assert.equal(
    calls[1].url.pathname,
    "/subpath/ocs/v2.php/apps/files_sharing/api/v1/shares/2",
  );
  await assert.rejects(api.deleteShare("../1"), /Invalid/);
});

test("OCR classification covers PDF parts and image content without mislabeling document text", async (t) => {
  const { api } = await fixture(t, () => {});
  assert.equal(
    api.isOcrExcerpt({ mime: "application/pdf" }, { source: "parts.ocr" }),
    true,
  );
  assert.equal(
    api.isOcrExcerpt({ mime: "image/png" }, { source: "content" }),
    true,
  );
  assert.equal(
    api.isOcrExcerpt({ mime: "application/pdf" }, { source: "content" }),
    false,
  );
  assert.equal(
    api.isOcrExcerpt({ mime: "image/png" }, { source: "title" }),
    false,
  );
});
