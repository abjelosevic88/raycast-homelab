const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const path = require("node:path");
const { test } = require("node:test");
const ts = require("typescript");

const source = ts.transpileModule(
  readFileSync(path.join(__dirname, "../src/backups-api.ts"), "utf8"),
  {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2022,
    },
  },
).outputText;

const NOW = Date.parse("2026-09-05T12:00:00Z");
const HOUR = 3_600_000;
const daily = { cron: "0 4 * * *" };

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function plan(id = "daily", repo = "local", schedule = daily) {
  return { id, repo, schedule };
}

function repo(id = "local", checkSchedule = { cron: "0 5 * * 0" }) {
  return {
    id,
    guid: `${id}-guid`,
    checkPolicy: { schedule: checkSchedule, structureOnly: true },
  };
}

function operation(kind, ageHours, status = "STATUS_SUCCESS", extra = {}) {
  return {
    id: `${kind}-${ageHours}-${status}`,
    planId: "daily",
    unixTimeStartMs: String(NOW - ageHours * HOUR - 60_000),
    unixTimeEndMs: String(NOW - ageHours * HOUR),
    status,
    [kind]: {},
    ...extra,
  };
}

function backup(ageHours, status = "STATUS_SUCCESS", extra = {}) {
  return operation("operationBackup", ageHours, status, extra);
}

function stats(ageHours, totalSize, extra = {}) {
  return operation("operationStats", ageHours, "STATUS_SUCCESS", {
    operationStats: {
      stats: { totalSize: String(totalSize), snapshotCount: 7 },
    },
    ...extra,
  });
}

function fixture({
  config = { instance: "this-server", plans: [plan()], repos: [repo()] },
  operations = { "local-guid": [backup(1)] },
  summaries = [],
  handler = () => undefined,
} = {}) {
  const settings = {
    backrestUrl: "https://backrest.example.test/subpath",
    backrestUsername: "test-user",
    backrestPassword: "test-password",
    backrestGraceHours: "",
  };
  const calls = [];
  let now = NOW;
  class FixedDate extends Date {
    static now() {
      return now;
    }
  }
  const fakeFetch = async (rawUrl, options) => {
    const url = new URL(rawUrl);
    const call = {
      url,
      method: url.pathname.split("/").at(-1),
      body: JSON.parse(options.body),
      options,
    };
    calls.push(call);
    const custom = await handler(call, calls);
    if (custom !== undefined) return custom;
    if (call.method === "Login")
      return json({ token: "private-session-token" });
    if (call.method === "GetConfig") return json(config);
    if (call.method === "GetSummaryDashboard")
      return json({ planSummaries: summaries });
    if (call.method === "GetOperations") {
      return json({
        operations: operations[call.body.selector.repoGuid] || [],
      });
    }
    throw new Error(`Unexpected API method: ${call.method}`);
  };
  const configMock = {
    ConfigError: class extends Error {},
    setting: (key) => settings[key] || "",
    requireUrl: (key) => {
      if (!settings[key]) throw new Error("URL is not set");
      return settings[key].replace(/\/+$/, "");
    },
  };
  const exports = {};
  new Function("require", "exports", "fetch", "Date", source)(
    (name) => (name === "./config" ? configMock : require(name)),
    exports,
    fakeFetch,
    FixedDate,
  );
  return {
    api: exports,
    calls,
    settings,
    advance: (ms) => {
      now += ms;
    },
  };
}

test("complete per-repository history retains older successes beyond 100 unrelated operations", async () => {
  const noise = Array.from({ length: 150 }, (_, i) =>
    operation("operationPrune", i / 100),
  );
  const { api, calls } = fixture({
    config: {
      instance: "this-server",
      plans: [plan(), plan("weekly", "remote")],
      repos: [repo(), repo("remote")],
    },
    operations: {
      "local-guid": [...noise, backup(3)],
      "remote-guid": [backup(4, "STATUS_SUCCESS", { planId: "weekly" })],
    },
  });
  const snapshot = await api.loadBackupHealth();
  assert.equal(snapshot.fetchedAt, NOW);
  assert.deepEqual(
    snapshot.plans.map((p) => p.lastSuccessAt),
    [NOW - 3 * HOUR, NOW - 4 * HOUR],
  );
  assert.ok(snapshot.plans.every((p) => p.health.label === "Current"));
  assert.deepEqual(
    calls.filter((c) => c.method === "GetOperations").map((c) => c.body),
    [
      {
        selector: { repoGuid: "local-guid", instanceId: "this-server" },
        lastN: "0",
      },
      {
        selector: { repoGuid: "remote-guid", instanceId: "this-server" },
        lastN: "0",
      },
    ],
  );
});

test("every configured plan is shown, including never-run, manual, disabled and missing repositories", async () => {
  const { api } = fixture({
    config: {
      plans: [
        plan(),
        plan("never"),
        plan("manual", "local", {}),
        plan("disabled", "local", { ...daily, disabled: true }),
        plan("orphan", "missing"),
      ],
      repos: [repo()],
    },
  });
  const snapshot = await api.loadBackupHealth();
  assert.deepEqual(
    snapshot.plans.map((p) => [p.id, p.health.label, p.health.attention]),
    [
      ["daily", "Current", false],
      ["never", "Never run", true],
      ["manual", "Manual", false],
      ["disabled", "Manual", false],
      ["orphan", "Unavailable", true],
    ],
  );
  assert.equal(snapshot.plans[1].lastSuccessAt, undefined);
  assert.equal(snapshot.plans[2].nextRunAt, undefined);
  assert.equal(snapshot.repositories[0].health.label, "Never verified");
});

test("dry runs cannot supply success, failure or snapshot-size evidence", async () => {
  const { api } = fixture({
    operations: {
      "local-guid": [
        backup(0.2, "STATUS_ERROR", { operationBackup: { dryRun: true } }),
        backup(0.5, "STATUS_SUCCESS", {
          operationBackup: {
            dryRun: true,
            lastStatus: { summary: { totalBytesProcessed: "999999" } },
          },
        }),
        backup(28),
      ],
    },
  });
  const snapshot = await api.loadBackupHealth();
  assert.equal(snapshot.plans[0].health.label, "Overdue");
  assert.equal(snapshot.plans[0].lastSuccessAt, NOW - 28 * HOUR);
  assert.equal(snapshot.plans[0].latestSnapshotBytes, undefined);
  assert.equal(snapshot.totalStoredBytes, undefined);
});

test("latest failed or warning backup remains actionable despite older success and a running retry", async () => {
  for (const [status, label, level] of [
    ["STATUS_ERROR", "Failed · running", "error"],
    ["STATUS_WARNING", "Warnings · running", "warning"],
    ["STATUS_USER_CANCELLED", "Cancelled · running", "warning"],
  ]) {
    const { api } = fixture({
      operations: {
        "local-guid": [
          backup(3),
          backup(2, status),
          backup(0.1, "STATUS_INPROGRESS", { unixTimeEndMs: undefined }),
        ],
      },
    });
    const p = (await api.loadBackupHealth()).plans[0];
    assert.equal(p.health.label, label);
    assert.equal(p.health.level, level);
    assert.equal(p.health.attention, true);
    assert.equal(p.lastBackup.status, status);
    assert.equal(p.lastSuccessAt, NOW - 3 * HOUR);
  }
});

test("running and pending work does not hide overdue or never-successful backup state", async () => {
  for (const [history, label, attention] of [
    [[backup(1), backup(0, "STATUS_INPROGRESS")], "Running", false],
    [[backup(30), backup(0, "STATUS_INPROGRESS")], "Overdue · running", true],
    [[backup(0, "STATUS_INPROGRESS")], "First run in progress", true],
    [
      [backup(-1, "STATUS_PENDING", { unixTimeEndMs: undefined })],
      "Never run",
      true,
    ],
  ]) {
    const { api } = fixture({ operations: { "local-guid": history } });
    const p = (await api.loadBackupHealth()).plans[0];
    assert.equal(p.health.label, label);
    assert.equal(p.health.attention, attention);
  }
});

test("daily, weekly, irregular cron and frequency schedules use nominal maximum intervals plus grace", async () => {
  const cases = [
    [daily, 26, 2],
    [{ cron: "0 4 * * 0" }, 170, 2],
    [{ cron: "0 4 * * 1,5" }, 98, 2],
    [{ maxFrequencyHours: 6 }, 8, 2],
    [{ maxFrequencyDays: 3 }, 74, 2],
    [daily, 24, 0],
    [daily, 24.5, 0.5],
  ];
  for (const [schedule, deadlineHours, grace] of cases) {
    const { api, settings, advance } = fixture({
      config: { plans: [plan("daily", "local", schedule)], repos: [repo()] },
      operations: { "local-guid": [backup(deadlineHours)] },
    });
    settings.backrestGraceHours = String(grace);
    assert.equal(
      (await api.loadBackupHealth()).plans[0].health.label,
      "Current",
      JSON.stringify(schedule),
    );
    advance(1);
    assert.equal(
      (await api.loadBackupHealth()).plans[0].health.label,
      "Overdue",
      JSON.stringify(schedule),
    );
  }
});

test("unknown and six-field Backrest cron schedules are not silently reinterpreted as healthy", async () => {
  for (const cron of ["invalid cron", "0 4 * * * 2026"]) {
    const { api } = fixture({
      config: { plans: [plan("daily", "local", { cron })], repos: [repo()] },
    });
    const p = (await api.loadBackupHealth()).plans[0];
    assert.equal(p.health.label, "Freshness unknown");
    assert.equal(p.health.attention, true);
  }
});

test("next run comes from Backrest summary or pending history and is suppressed for manual plans", async () => {
  const pending = backup(-3, "STATUS_PENDING", { unixTimeEndMs: undefined });
  const { api } = fixture({
    config: {
      plans: [plan(), plan("fallback"), plan("manual", "local", {})],
      repos: [repo()],
    },
    operations: {
      "local-guid": [backup(1), pending, { ...pending, planId: "fallback" }],
    },
    summaries: [
      { id: "daily", nextBackupTimeMs: String(NOW + HOUR) },
      { id: "manual", nextBackupTimeMs: String(NOW + HOUR) },
    ],
  });
  assert.deepEqual(
    (await api.loadBackupHealth()).plans.map((p) => p.nextRunAt),
    [NOW + HOUR, Number(pending.unixTimeStartMs), undefined],
  );
});

test("repository integrity shows latest failure, prior successful check, check coverage and pending check", async () => {
  const pending = operation("operationCheck", -6, "STATUS_PENDING", {
    unixTimeEndMs: undefined,
  });
  const checkedRepo = repo();
  checkedRepo.checkPolicy = { schedule: daily, readDataSubsetPercent: 10 };
  const { api } = fixture({
    config: { plans: [plan()], repos: [checkedRepo] },
    operations: {
      "local-guid": [
        backup(1),
        operation("operationCheck", 24),
        operation("operationCheck", 2, "STATUS_ERROR"),
        pending,
      ],
    },
  });
  const r = (await api.loadBackupHealth()).repositories[0];
  assert.equal(r.health.label, "Failed");
  assert.equal(r.health.level, "error");
  assert.equal(r.lastCheck.status, "STATUS_ERROR");
  assert.equal(r.lastSuccessfulCheckAt, NOW - 24 * HOUR);
  assert.equal(r.nextCheckAt, Number(pending.unixTimeStartMs));
  assert.equal(r.checkMode, "10% of repository data (current policy)");
});

test("cached raw-data repository size is counted once across shared plans, never from logical snapshot bytes", async () => {
  const logical = {
    operationBackup: {
      lastStatus: { summary: { totalBytesProcessed: "900000000000" } },
    },
  };
  const { api } = fixture({
    config: {
      plans: [plan(), plan("photos"), plan("cloud", "remote")],
      repos: [repo(), repo("remote")],
    },
    operations: {
      "local-guid": [
        stats(10, 100),
        stats(2, 120),
        stats(1, 999, { status: "STATUS_ERROR" }),
        backup(1, "STATUS_SUCCESS", logical),
        backup(1, "STATUS_SUCCESS", { ...logical, planId: "photos" }),
      ],
      "remote-guid": [
        stats(3, 80),
        backup(1, "STATUS_SUCCESS", { ...logical, planId: "cloud" }),
      ],
    },
  });
  const snapshot = await api.loadBackupHealth();
  assert.equal(snapshot.totalStoredBytes, 200);
  assert.equal(snapshot.measuredRepositoryCount, 2);
  assert.deepEqual(
    snapshot.repositories.map((r) => r.storedBytes),
    [120, 80],
  );
  assert.equal(snapshot.repositories[0].statsAt, NOW - 2 * HOUR);
  assert.equal(snapshot.repositories[0].snapshotCount, 7);
  assert.ok(
    snapshot.plans.every((p) => p.latestSnapshotBytes === 900000000000),
  );
});

test("missing or invalid repository stats remain unknown and partial totals disclose coverage", async () => {
  const { api } = fixture({
    config: {
      plans: [plan()],
      repos: [repo(), repo("unknown"), repo("invalid")],
    },
    operations: {
      "local-guid": [stats(1, 0)],
      "unknown-guid": [
        backup(1, "STATUS_SUCCESS", {
          operationBackup: {
            lastStatus: { summary: { totalBytesProcessed: "12345" } },
          },
        }),
      ],
      "invalid-guid": [stats(1, -20), stats(2, "not a size")],
    },
  });
  const snapshot = await api.loadBackupHealth();
  assert.equal(snapshot.totalStoredBytes, 0);
  assert.equal(snapshot.measuredRepositoryCount, 1);
  assert.equal(snapshot.repositories[1].storedBytes, undefined);
  assert.equal(snapshot.repositories[2].storedBytes, undefined);
  assert.match(
    api.backupSummary(snapshot),
    /0 B cached repository data · partial/,
  );
  const unknown = await fixture().api.loadBackupHealth();
  assert.equal(unknown.totalStoredBytes, undefined);
  assert.equal(unknown.measuredRepositoryCount, 0);
  assert.match(
    api.backupSummary(unknown),
    /Unknown cached repository data · partial/,
  );
});

test("public snapshots exclude config secrets, raw logs, source paths and session credentials", async () => {
  const { api } = fixture({
    config: {
      instance: "private-instance-marker",
      auth: { users: [{ passwordBcrypt: "private-auth-hash" }] },
      plans: [
        {
          ...plan(),
          paths: ["/private/source-path"],
          hooks: [{ command: "private-hook-command" }],
        },
      ],
      repos: [
        {
          ...repo(),
          uri: "s3:private-bucket-name",
          password: "private-repo-password",
          env: ["private-environment-secret"],
        },
      ],
    },
    operations: {
      "local-guid": [
        backup(1, "STATUS_ERROR", {
          error: "private-operation-error",
          logs: "private-raw-logs",
        }),
      ],
    },
  });
  const serialized = JSON.stringify(await api.loadBackupHealth());
  for (const secret of [
    "private-",
    "test-password",
    "test-user",
    "local-guid",
  ]) {
    assert.equal(serialized.includes(secret), false, secret);
  }
});

test("requests only authenticate and read config, history and summary without following redirects", async () => {
  const { api, calls, settings } = fixture();
  settings.backrestUrl += "/";
  await api.loadBackupHealth();
  assert.deepEqual(
    new Set(calls.map((c) => c.method)),
    new Set(["Login", "GetConfig", "GetSummaryDashboard", "GetOperations"]),
  );
  for (const { url, method, options } of calls) {
    assert.equal(url.origin, "https://backrest.example.test");
    assert.match(url.pathname, /^\/subpath\/v1\.(Authentication|Backrest)\//);
    assert.equal(url.search, "");
    assert.equal(url.href.includes("test-password"), false);
    assert.equal(options.method, "POST");
    assert.equal(options.redirect, "manual");
    assert.ok(options.signal instanceof AbortSignal);
    assert.equal(
      options.headers.Authorization,
      method === "Login" ? undefined : "Bearer private-session-token",
    );
  }
});

test("connection identity is hashed and changes with URL, user, password and freshness policy", () => {
  const { api, settings } = fixture();
  const keys = [api.backupConnectionKey()];
  for (const [key, value] of Object.entries({
    backrestUrl: "https://other.example.test",
    backrestUsername: "new-user",
    backrestPassword: "new-secret",
    backrestGraceHours: "3",
  })) {
    settings[key] = value;
    keys.push(api.backupConnectionKey());
  }
  assert.equal(new Set(keys).size, 5);
  assert.ok(keys.every((key) => /^[a-f0-9]{64}$/.test(key)));
});

test("session cache is reused, expires and is invalidated by credentials changes", async () => {
  const { api, calls, settings, advance } = fixture();
  await api.loadBackupHealth();
  await api.loadBackupHealth();
  assert.equal(calls.filter((c) => c.method === "Login").length, 1);
  advance(26 * 60_000);
  await api.loadBackupHealth();
  assert.equal(calls.filter((c) => c.method === "Login").length, 2);
  settings.backrestPassword = "rotated-password";
  await api.loadBackupHealth();
  assert.equal(calls.filter((c) => c.method === "Login").length, 3);
  assert.equal(
    calls.filter((c) => c.method === "Login").at(-1).body.password,
    "rotated-password",
  );
});

test("an expired bearer session reauthenticates once and repeated 401 fails explicitly", async () => {
  for (const permanent of [false, true]) {
    let logins = 0;
    const { api, calls } = fixture({
      handler: (call) => {
        if (call.method === "Login")
          return json({ token: `token-${++logins}` });
        if (
          call.method === "GetConfig" &&
          (permanent || call.options.headers.Authorization === "Bearer token-1")
        )
          return json({ private: "upstream credentials" }, 401);
      },
    });
    if (permanent)
      await assert.rejects(api.loadBackupHealth(), /authentication failed/);
    else
      assert.equal(
        (await api.loadBackupHealth()).plans[0].health.label,
        "Current",
      );
    assert.equal(logins, 2);
    assert.equal(calls.filter((c) => c.method === "GetConfig").length, 2);
  }
});

test("missing credentials, unsafe URLs and invalid grace fail before any network call", async () => {
  const { api, calls, settings } = fixture();
  settings.backrestPassword = "";
  await assert.rejects(api.loadBackupHealth(), /password is not set/);
  settings.backrestPassword = "test-password";
  for (const url of [
    "not a url",
    "file:///etc",
    "https://user:secret@example.test",
    "https://example.test?token=secret",
    "https://example.test/#fragment",
  ]) {
    settings.backrestUrl = url;
    await assert.rejects(api.loadBackupHealth(), /HTTP\(S\) base URL/);
  }
  settings.backrestUrl = "https://backrest.example.test";
  for (const grace of ["-1", "169", "NaN", "Infinity", "oops"]) {
    settings.backrestGraceHours = grace;
    await assert.rejects(api.loadBackupHealth(), /between 0 and 168/);
  }
  assert.equal(calls.length, 0);
});

test("auth, permissions, redirects and server failures are explicit and redact response bodies", async () => {
  for (const [status, pattern] of [
    [401, /authentication failed/],
    [403, /access denied/],
    [302, /redirected/],
    [503, /HTTP 503/],
  ]) {
    const { api } = fixture({
      handler: () => new Response("private upstream response", { status }),
    });
    await assert.rejects(
      api.loadBackupHealth(),
      (error) =>
        pattern.test(error.message) && !error.message.includes("private"),
    );
  }
  const noToken = fixture({
    handler: (call) => (call.method === "Login" ? json({}) : undefined),
  });
  await assert.rejects(noToken.api.loadBackupHealth(), /no session token/);
});

test("network errors and timeouts produce useful redacted errors", async () => {
  for (const [error, expected] of [
    [new Error("private hostname and credentials"), /unreachable/],
    [new DOMException("private timeout detail", "TimeoutError"), /timed out/],
    [new DOMException("private abort detail", "AbortError"), /timed out/],
  ]) {
    const { api } = fixture({
      handler: () => {
        throw error;
      },
    });
    await assert.rejects(
      api.loadBackupHealth(),
      (result) =>
        expected.test(result.message) && !result.message.includes("private"),
    );
  }
});

test("malformed JSON, config lists and duplicate IDs cannot masquerade as successful health", async () => {
  for (const config of [
    { plans: "invalid", repos: [] },
    { plans: [plan(), plan()], repos: [repo()] },
    { plans: [plan()], repos: [repo(), repo()] },
    { plans: [{ repo: "local" }], repos: [repo()] },
  ]) {
    const { api } = fixture({ config });
    await assert.rejects(
      api.loadBackupHealth(),
      /unsupported list|duplicate IDs|without an ID/,
    );
  }
  const { api } = fixture({
    handler: (call) =>
      call.method === "GetConfig"
        ? new Response("<html>private sign-in page</html>")
        : undefined,
  });
  await assert.rejects(api.loadBackupHealth(), /invalid JSON/);
});

test("failed or malformed repository history is unavailable while other repositories still load", async () => {
  for (const badResponse of [
    () => json({}, 503),
    () => json({ operations: "invalid" }),
    () =>
      json({
        operations: [
          backup(1, "STATUS_SUCCESS", { unixTimeStartMs: "invalid" }),
        ],
      }),
  ]) {
    const { api } = fixture({
      config: {
        plans: [plan(), plan("remote", "remote")],
        repos: [repo(), repo("remote")],
      },
      operations: { "local-guid": [backup(1), stats(1, 120)] },
      handler: (call) =>
        call.method === "GetOperations" &&
        call.body.selector.repoGuid === "remote-guid"
          ? badResponse()
          : undefined,
    });
    const snapshot = await api.loadBackupHealth();
    assert.equal(snapshot.plans[0].health.label, "Current");
    assert.equal(snapshot.plans[1].health.label, "Unavailable");
    assert.equal(snapshot.repositories[1].health.label, "Unavailable");
    assert.equal(snapshot.repositories[1].storedBytes, undefined);
    assert.equal(snapshot.totalStoredBytes, 120);
    assert.equal(snapshot.measuredRepositoryCount, 1);
    assert.match(api.backupSummary(snapshot), /partial/);
  }
});

test("summary failure is visible and falls back to pending operations", async () => {
  const pending = backup(-1, "STATUS_PENDING", { unixTimeEndMs: undefined });
  const { api } = fixture({
    operations: { "local-guid": [backup(1), pending] },
    handler: (call) =>
      call.method === "GetSummaryDashboard" ? json({}, 503) : undefined,
  });
  const snapshot = await api.loadBackupHealth();
  assert.equal(snapshot.warnings.length, 1);
  assert.match(snapshot.warnings[0], /next-run summary is unavailable/);
  assert.equal(snapshot.plans[0].health.label, "Current");
  assert.equal(snapshot.plans[0].nextRunAt, Number(pending.unixTimeStartMs));
});

test("oversized and interrupted response streams fail with bounded, redacted errors", async () => {
  const large = fixture({
    handler: (call) =>
      call.method === "GetOperations"
        ? new Response(" ".repeat(16 * 1024 * 1024 + 1))
        : undefined,
  });
  const snapshot = await large.api.loadBackupHealth();
  assert.equal(snapshot.plans[0].health.label, "Unavailable");
  assert.match(snapshot.plans[0].health.detail, /16 MiB response limit/);
  const interrupted = fixture({
    handler: () =>
      new Response(
        new ReadableStream({
          start(controller) {
            controller.error(new Error("private stream details"));
          },
        }),
      ),
  });
  await assert.rejects(
    interrupted.api.loadBackupHealth(),
    (error) =>
      /interrupted or timed out/.test(error.message) &&
      !error.message.includes("private"),
  );
});

test("numeric protobuf statuses and nested operation payloads retain health and size information", async () => {
  const { api } = fixture({
    operations: {
      "local-guid": [
        backup(1, 3, {
          operationBackup: undefined,
          op: {
            operationBackup: {
              lastStatus: { summary: { totalBytesProcessed: "456" } },
            },
          },
        }),
        operation("operationStats", 2, 3, {
          operationStats: undefined,
          op: {
            operationStats: { stats: { totalSize: "123", snapshotCount: "4" } },
          },
        }),
      ],
    },
  });
  const snapshot = await api.loadBackupHealth();
  assert.equal(snapshot.plans[0].health.label, "Current");
  assert.equal(snapshot.plans[0].latestSnapshotBytes, 456);
  assert.equal(snapshot.repositories[0].storedBytes, 123);
  assert.equal(snapshot.repositories[0].snapshotCount, 4);
});
