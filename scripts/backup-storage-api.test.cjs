const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const path = require("node:path");
const { test } = require("node:test");
const ts = require("typescript");

const source = ts.transpileModule(
  readFileSync(path.join(__dirname, "../src/backup-storage-api.ts"), "utf8"),
  {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2022,
    },
  },
).outputText;

const COLLECTED_AT = "2026-09-05T12:00:00Z";

function location(overrides = {}) {
  return {
    id: "cloud-personal",
    label: "Personal cloud",
    kind: "rclone",
    group: "replica",
    repoId: "documents",
    status: "ok",
    bytes: 100,
    objectCount: 4,
    ...overrides,
  };
}

function breakdown(overrides = {}) {
  return {
    collectedAt: COLLECTED_AT,
    location: location(),
    relativePath: "",
    entries: [
      { name: "small", relativePath: "small", kind: "file", bytes: 20 },
      { name: "large", relativePath: "large", kind: "directory", bytes: 60 },
    ],
    totalBytes: 100,
    otherBytes: 20,
    truncated: false,
    errors: [],
    ...overrides,
  };
}

function fixture({
  folder = breakdown(),
  locations = [location()],
  handler,
} = {}) {
  let connectionKey = "connection-a";
  const calls = [];
  const exports = {};
  const fakeRequire = (name) => {
    if (name === "./services-api") {
      return {
        hasServicesHost: () => true,
        servicesConnectionKey: () => connectionKey,
        collectBackupStorage: async () => {
          calls.push({ operation: "snapshot" });
          return { collectedAt: COLLECTED_AT, locations, errors: [] };
        },
        collectBackupStorageBreakdown: async (locationId, relativePath) => {
          const call = { operation: "breakdown", locationId, relativePath };
          calls.push(call);
          return handler ? handler(call) : folder;
        },
      };
    }
    return require(name);
  };
  new Function("require", "exports", source)(fakeRequire, exports);
  return {
    api: exports,
    calls,
    setConnectionKey: (value) => {
      connectionKey = value;
    },
  };
}

function load(api, id = "cloud-personal", relativePath = "") {
  return api.loadBackupStorageBreakdown("connection-a", id, relativePath);
}

test("destination sizes remain per instance and measured totals separate cloud, disk and staging", async () => {
  const locations = [
    location({ id: "cloud-personal", bytes: 100 }),
    location({ id: "cloud-family", bytes: 200 }),
    location({ id: "disk", kind: "local", group: "repository", bytes: 300 }),
    location({ id: "ssh-copy", kind: "ssh", bytes: 400 }),
    location({ id: "staging", kind: "local", group: "staging", bytes: 50 }),
    location({ id: "usb", kind: "local", status: "offline", bytes: undefined }),
    location({ id: "failed-cloud", status: "error", bytes: undefined }),
  ];
  const { api, calls } = fixture({ locations });
  const result = await api.loadBackupStorage("connection-a");
  assert.equal(result.cloudBytes, 300);
  assert.equal(result.diskBytes, 700);
  assert.equal(result.stagingBytes, 50);
  assert.equal(result.measuredLocations, 5);
  assert.equal(result.totalLocations, 7);
  assert.deepEqual(
    result.locations.map(({ id, bytes }) => [id, bytes]),
    locations.map(({ id, bytes }) => [id, bytes]),
  );
  assert.deepEqual(calls, [{ operation: "snapshot" }]);
});

test("opening a destination sends its exact ID and defaults to its root", async () => {
  const { api, calls } = fixture();
  const result = await api.loadBackupStorageBreakdown(
    "connection-a",
    "cloud-personal",
  );
  assert.deepEqual(calls, [
    { operation: "breakdown", locationId: "cloud-personal", relativePath: "" },
  ]);
  assert.equal(result.location.id, "cloud-personal");
  assert.equal(result.relativePath, "");
  assert.equal(result.totalBytes, 100);
  assert.equal(result.otherBytes, 20);
  assert.deepEqual(
    result.entries.map(({ name }) => name),
    ["large", "small"],
  );
});

test("nested folder navigation roundtrips exact relative paths and destination IDs", async () => {
  const id = "Cloud account's $(literal) ; backup";
  const relativePath = "Photos 2026/Family's $(literal); photos";
  const name = "Željko `archive`.jpg";
  const folder = breakdown({
    location: location({ id }),
    relativePath,
    entries: [
      {
        name,
        relativePath: `${relativePath}/${name}`,
        kind: "file",
        bytes: 80,
      },
    ],
  });
  const { api, calls } = fixture({ folder });
  const result = await load(api, id, relativePath);
  assert.deepEqual(calls, [
    { operation: "breakdown", locationId: id, relativePath },
  ]);
  assert.equal(result.relativePath, relativePath);
  assert.equal(result.entries[0].relativePath, `${relativePath}/${name}`);
});

test("different destinations remain separate and obsolete connection keys fail before transport", async () => {
  const { api, calls, setConnectionKey } = fixture({
    handler: ({ locationId, relativePath }) =>
      breakdown({ location: location({ id: locationId }), relativePath }),
  });
  assert.equal((await load(api, "first-cloud")).location.id, "first-cloud");
  assert.equal((await load(api, "second-cloud")).location.id, "second-cloud");
  setConnectionKey("connection-b");
  assert.equal(api.backupStorageConnectionKey(), "connection-b");
  await assert.rejects(load(api, "first-cloud"), /connection changed/i);
  await assert.rejects(
    api.loadBackupStorage("connection-a"),
    /connection changed/i,
  );
  assert.equal(calls.length, 2);
});

test("traversal, absolute, backslash and control-character paths are rejected before transport", async () => {
  const { api, calls } = fixture();
  for (const relativePath of [
    "/etc",
    "//server/share",
    "../secret",
    "a/../secret",
    ".",
    "a/./b",
    "a//b",
    "a/",
    "a\\b",
    "C:\\secret",
    "a\nprivate",
    "a\rprivate",
    "a\tprivate",
    "a\0private",
    "a\x7fprivate",
    "a".repeat(2049),
  ]) {
    await assert.rejects(
      load(api, "cloud-personal", relativePath),
      /Invalid backup destination or folder/,
      relativePath,
    );
  }
  for (const id of [
    "",
    "a\nprivate",
    "a\0private",
    "a\x7fprivate",
    "a".repeat(513),
    null,
    5,
  ]) {
    await assert.rejects(
      load(api, id),
      /Invalid backup destination or folder/,
      String(id),
    );
  }
  assert.equal(calls.length, 0);
});

test("a collector cannot substitute the selected destination, parent path or child path", async () => {
  for (const folder of [
    breakdown({ location: location({ id: "other-cloud" }) }),
    breakdown({ relativePath: "other-parent" }),
    breakdown({
      entries: [
        {
          name: "data",
          relativePath: "other/data",
          kind: "directory",
          bytes: 80,
        },
      ],
    }),
    breakdown({
      entries: [
        {
          name: "../data",
          relativePath: "../data",
          kind: "directory",
          bytes: 80,
        },
      ],
    }),
    breakdown({
      entries: [
        {
          name: "nested/data",
          relativePath: "nested/data",
          kind: "directory",
          bytes: 80,
        },
      ],
    }),
    breakdown({
      entries: [
        {
          name: "data\\secret",
          relativePath: "data\\secret",
          kind: "directory",
          bytes: 80,
        },
      ],
    }),
    breakdown({
      entries: [
        {
          name: "data\nprivate",
          relativePath: "data\nprivate",
          kind: "directory",
          bytes: 80,
        },
      ],
    }),
    breakdown({
      entries: [
        { name: "data", relativePath: "/data", kind: "directory", bytes: 80 },
      ],
    }),
    breakdown({
      entries: [{ name: ".", relativePath: ".", kind: "directory", bytes: 80 }],
    }),
    breakdown({
      entries: [
        { name: "data", relativePath: "data", kind: "device", bytes: 80 },
      ],
    }),
  ]) {
    const { api } = fixture({ folder });
    await assert.rejects(load(api), /invalid folder breakdown/i);
  }
});

test("duplicate entries and responses over the 200-entry limit cannot inflate folder contents", async () => {
  const item = {
    name: "data",
    relativePath: "data",
    kind: "directory",
    bytes: 0,
  };
  for (const entries of [
    [item, { ...item }],
    Array.from({ length: 201 }, (_, index) => ({
      ...item,
      name: `data-${index}`,
      relativePath: `data-${index}`,
    })),
  ]) {
    const { api } = fixture({
      folder: breakdown({ entries, totalBytes: 0, otherBytes: 0 }),
    });
    await assert.rejects(load(api), /invalid folder breakdown/i);
  }
  const entries = Array.from({ length: 200 }, (_, index) => ({
    ...item,
    name: `data-${index}`,
    relativePath: `data-${index}`,
  }));
  const { api } = fixture({
    folder: breakdown({
      entries,
      totalBytes: 0,
      otherBytes: 0,
      truncated: true,
    }),
  });
  assert.equal((await load(api)).entries.length, 200);
});

test("invalid byte and object counts cannot masquerade as usable measurements", async () => {
  for (const value of [
    NaN,
    Infinity,
    -1,
    0.5,
    Number.MAX_SAFE_INTEGER + 1,
    "80",
    null,
  ]) {
    for (const folder of [
      breakdown({ totalBytes: value }),
      breakdown({ otherBytes: value }),
      breakdown({ location: location({ bytes: value }) }),
      breakdown({ location: location({ objectCount: value }) }),
      breakdown({
        entries: [
          {
            name: "data",
            relativePath: "data",
            kind: "directory",
            bytes: value,
          },
        ],
      }),
      breakdown({
        entries: [
          {
            name: "data",
            relativePath: "data",
            kind: "directory",
            bytes: 80,
            objectCount: value,
          },
        ],
      }),
    ]) {
      const { api } = fixture({ folder });
      await assert.rejects(
        load(api),
        /invalid folder breakdown/i,
        String(value),
      );
    }
  }
});

test("displayed bytes, other bytes and total bytes must account consistently without overflow", async () => {
  for (const folder of [
    breakdown({ totalBytes: 70, otherBytes: undefined }),
    breakdown({ otherBytes: 19 }),
    breakdown({ otherBytes: 21 }),
    breakdown({ totalBytes: undefined, otherBytes: 20 }),
    breakdown({
      entries: [
        {
          name: "a",
          relativePath: "a",
          kind: "file",
          bytes: Number.MAX_SAFE_INTEGER,
        },
        { name: "b", relativePath: "b", kind: "file", bytes: 1 },
      ],
      totalBytes: undefined,
      otherBytes: undefined,
    }),
  ]) {
    const { api } = fixture({ folder });
    await assert.rejects(load(api), /sizes are inconsistent/i);
  }
});

test("partial and truncated folder results preserve unknown sizes, warnings and unlisted bytes", async () => {
  const { api } = fixture({
    folder: breakdown({
      entries: [
        { name: "unreadable", relativePath: "unreadable", kind: "directory" },
        {
          name: "empty",
          relativePath: "empty",
          kind: "file",
          bytes: 0,
          objectCount: 0,
        },
        { name: "large", relativePath: "large", kind: "directory", bytes: 60 },
      ],
      otherBytes: 40,
      truncated: true,
      errors: ["Some entries could not be measured."],
    }),
  });
  const result = await load(api);
  assert.deepEqual(
    result.entries.map(({ name }) => name),
    ["large", "empty", "unreadable"],
  );
  assert.equal(result.entries[2].bytes, undefined);
  assert.equal(result.entries[2].objectCount, undefined);
  assert.equal(result.entries[1].bytes, 0);
  assert.equal(result.otherBytes, 40);
  assert.equal(result.truncated, true);
  assert.deepEqual(result.errors, ["Some entries could not be measured."]);
});

test("an unmeasured folder total and offline or failed destinations remain unknown", async () => {
  const unmeasured = fixture({
    folder: breakdown({
      totalBytes: undefined,
      otherBytes: undefined,
      errors: ["Folder measurement timed out."],
    }),
  });
  assert.equal((await load(unmeasured.api)).totalBytes, undefined);
  for (const status of ["offline", "error"]) {
    const folder = breakdown({
      location: location({
        status,
        bytes: undefined,
        objectCount: undefined,
        error: "Destination unavailable.",
      }),
      entries: [],
      totalBytes: undefined,
      otherBytes: undefined,
    });
    const { api } = fixture({ folder });
    const result = await load(api);
    assert.equal(result.location.status, status);
    assert.equal(result.location.bytes, undefined);
    assert.equal(result.totalBytes, undefined);
    assert.equal(result.otherBytes, undefined);
    for (const invalid of [
      { ...folder, totalBytes: 0 },
      { ...folder, entries: breakdown().entries },
      { ...folder, location: { ...folder.location, bytes: 0 } },
    ]) {
      await assert.rejects(
        load(fixture({ folder: invalid }).api),
        /invalid folder breakdown|sizes are inconsistent/i,
      );
    }
  }
});

test("malformed dates, warnings and response structures fail explicitly", async () => {
  for (const folder of [
    null,
    [],
    {},
    breakdown({ collectedAt: "yesterday" }),
    breakdown({ truncated: "true" }),
    breakdown({ errors: "private error" }),
    breakdown({ errors: [{}] }),
    breakdown({ entries: {} }),
  ]) {
    await assert.rejects(
      load(fixture({ folder }).api),
      /invalid folder breakdown/i,
    );
  }
});

test("removed destinations and unavailable inventories give actionable redacted errors", async () => {
  for (const message of [
    "Backup storage configuration is unavailable on the server.",
    "Backup storage location is not configured on the server.",
  ]) {
    const { api } = fixture({ folder: { errors: [message] } });
    await assert.rejects(load(api), (error) => error.message === message);
  }
  const { api } = fixture({
    folder: { errors: ["private remote path and token"] },
  });
  await assert.rejects(
    load(api),
    (error) =>
      /inventory is unavailable/.test(error.message) &&
      !error.message.includes("private"),
  );
});

test("cached display data drops raw server paths, cloud configuration and extra collector fields", async () => {
  const secretFields = {
    path: "/private/server/path",
    config: "/private/rclone.conf",
    remote: "private-cloud-remote:root",
    token: "private-token",
  };
  const rawLocation = location(secretFields);
  const { api } = fixture({
    locations: [rawLocation],
    folder: breakdown({
      ...secretFields,
      location: rawLocation,
      entries: breakdown().entries.map((entry) => ({
        ...entry,
        ...secretFields,
      })),
    }),
  });
  for (const result of [
    await load(api),
    await api.loadBackupStorage("connection-a"),
  ]) {
    assert.equal(JSON.stringify(result).includes("private-"), false);
    assert.equal(JSON.stringify(result).includes("/private/"), false);
  }
  const result = await load(api);
  assert.equal(result.location.label, "Personal cloud");
  assert.equal(result.location.repoId, "documents");
  assert.equal(result.location.objectCount, 4);
  assert.equal(result.entries[0].bytes, 60);
});

test("inventory duplicates and aggregate byte overflow are rejected", async () => {
  for (const locations of [
    [location(), location()],
    [
      location({ id: "first", bytes: Number.MAX_SAFE_INTEGER }),
      location({ id: "second", bytes: 1 }),
    ],
  ]) {
    const { api } = fixture({ locations });
    await assert.rejects(
      api.loadBackupStorage("connection-a"),
      /invalid|inconsistent|overflow|size/i,
    );
  }
});
