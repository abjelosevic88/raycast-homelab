const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");
const { readFileSync } = require("node:fs");
const path = require("node:path");
const { test } = require("node:test");
const ts = require("typescript");

const source = ts.transpileModule(
  readFileSync(path.join(__dirname, "../src/services-api.ts"), "utf8"),
  {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2022,
    },
  },
).outputText;

const service = {
  scope: "user",
  unit: "example.service",
  description: "Example",
  loadState: "loaded",
  activeState: "inactive",
  subState: "dead",
  unitFileState: "static",
  type: "oneshot",
  result: "success",
  exitCode: 0,
  startedAt: "2026-09-05T08:00:00Z",
  finishedAt: "2026-09-05T08:01:00Z",
  restartCount: 0,
  triggeredBy: ["example.timer"],
  conditionResult: null,
  assertResult: null,
};
const timer = {
  scope: "user",
  unit: "example.timer",
  description: "Example schedule",
  loadState: "loaded",
  activeState: "active",
  subState: "waiting",
  unitFileState: "enabled",
  service: service.unit,
  lastTriggerAt: service.startedAt,
  nextRunAt: "2026-09-06T08:00:00Z",
  schedule: ["OnCalendar=daily"],
  persistent: true,
  accuracySeconds: 60,
  serviceStatus: service,
};
const snapshot = {
  version: 1,
  host: "example.test",
  collectedAt: "2026-09-05T09:00:00Z",
  services: [service],
  timers: [timer],
  errors: [],
};

function fixture(handler = () => ({ stdout: JSON.stringify(snapshot) })) {
  const settings = {
    servicesSshHost: "user@host",
    servicesSshPort: "",
    servicesSshIdentityFile: "",
  };
  const calls = [];
  const readPaths = [];
  const execFile = (file, args, options, callback) => {
    const call = { file, args, options, input: null };
    calls.push(call);
    const stdin = new EventEmitter();
    stdin.end = (input) => {
      call.input = input;
      const result = handler(call);
      if (result.pipeError) stdin.emit("error", new Error("EPIPE"));
      queueMicrotask(() =>
        callback(
          result.error || null,
          result.stdout || "",
          result.stderr || "",
        ),
      );
    };
    return { stdin };
  };
  const exports = {};
  const fakeRequire = (name) => {
    if (name === "@raycast/api")
      return { environment: { assetsPath: "/extension/assets" } };
    if (name === "./config")
      return {
        setting: (key) => settings[key] || "",
        ConfigError: class extends Error {},
      };
    if (name === "node:child_process") return { execFile };
    if (name === "node:os") return { homedir: () => "/local/home" };
    if (name === "node:fs/promises")
      return {
        readFile: async (file) => {
          readPaths.push(file);
          assert.ok(
            [
              "/extension/assets/services-jobs.py",
              "/extension/assets/backup-storage.py",
            ].includes(file),
          );
          return "# bundled collector\n";
        },
      };
    return require(name);
  };
  new Function("require", "exports", source)(fakeRequire, exports);
  return { api: exports, settings, calls, readPaths };
}

test("SSH streams the bundled collector using bounded noninteractive read-only commands", async () => {
  const { api, calls, settings, readPaths } = fixture();
  settings.servicesSshPort = "2222";
  settings.servicesSshIdentityFile = "~/.ssh/key with spaces";
  assert.deepEqual(await api.loadServices(), snapshot);
  const call = calls[0];
  assert.equal(call.file, "ssh");
  assert.deepEqual(call.args.slice(-3), [
    "--",
    "user@host",
    "'python3' '-' 'snapshot'",
  ]);
  for (const option of [
    "BatchMode=yes",
    "StrictHostKeyChecking=yes",
    "ForwardAgent=no",
    "ClearAllForwardings=yes",
    "PermitLocalCommand=no",
  ])
    assert.ok(call.args.includes(option));
  assert.equal(call.args[call.args.indexOf("-p") + 1], "2222");
  assert.equal(
    call.args[call.args.indexOf("-i") + 1],
    "/local/home/.ssh/key with spaces",
  );
  assert.equal(call.options.timeout, 30_000);
  assert.equal(call.options.maxBuffer, 4 * 1024 * 1024);
  assert.equal(call.options.shell, undefined);
  assert.equal(call.input, "# bundled collector\n");
  assert.deepEqual(readPaths, ["/extension/assets/services-jobs.py"]);
});

test("backup inventory and folder browsing stream only the fixed storage collector with a 55-second cap", async () => {
  const { api, calls, readPaths } = fixture();
  assert.deepEqual(await api.collectBackupStorage(), snapshot);
  const id = "Cloud account's $(literal); `name`";
  const folder = "Photos 2026/Family's $(literal); `archive`";
  assert.deepEqual(
    await api.collectBackupStorageBreakdown(id, folder),
    snapshot,
  );
  assert.deepEqual(readPaths, [
    "/extension/assets/backup-storage.py",
    "/extension/assets/backup-storage.py",
  ]);
  assert.equal(calls[0].args.at(-1), "'python3' '-'");
  assert.equal(
    calls[1].args.at(-1),
    "'python3' '-' 'breakdown' 'Cloud account'\\''s $(literal); `name`' 'Photos 2026/Family'\\''s $(literal); `archive`'",
  );
  for (const call of calls) {
    assert.equal(call.file, "ssh");
    assert.deepEqual(call.args.slice(-3, -1), ["--", "user@host"]);
    assert.equal(call.options.timeout, 55_000);
    assert.equal(call.options.killSignal, "SIGKILL");
    assert.equal(call.options.maxBuffer, 4 * 1024 * 1024);
    assert.equal(call.options.shell, undefined);
    assert.equal(call.options.env.SSH_ASKPASS_REQUIRE, "never");
    assert.equal(call.input, "# bundled collector\n");
    for (const option of [
      "BatchMode=yes",
      "StrictHostKeyChecking=yes",
      "ClearAllForwardings=yes",
      "PermitLocalCommand=no",
      "ForwardAgent=no",
      "ForwardX11=no",
      "RequestTTY=no",
    ])
      assert.ok(call.args.includes(option));
  }
});

test("backup browsing rejects unsafe SSH destinations before reading or starting the collector", async () => {
  const { api, calls, settings, readPaths } = fixture();
  for (const host of [
    "",
    "-oProxyCommand=bad",
    "host;id",
    "$(id)",
    "user@host\nother",
    "user@-o",
  ]) {
    settings.servicesSshHost = host;
    await assert.rejects(api.collectBackupStorage(), /SSH Host/);
    await assert.rejects(
      api.collectBackupStorageBreakdown("cloud-personal", "photos"),
      /SSH Host/,
    );
  }
  assert.equal(calls.length, 0);
  assert.equal(readPaths.length, 0);
});

test("bad hosts, ports, key paths, scopes and unit names are rejected before starting SSH", async () => {
  const { api, settings, calls } = fixture();
  for (const host of [
    "",
    "-oProxyCommand=bad",
    "user@host;touch pwn",
    "$(id)",
    "user@host\nother",
    "ssh://host",
    "user name@host",
    "user@-o",
  ]) {
    settings.servicesSshHost = host;
    await assert.rejects(api.loadServices(), /SSH Host/);
  }
  settings.servicesSshHost = "host";
  for (const port of ["0", "65536", "22 -o Bad", "abc"]) {
    settings.servicesSshPort = port;
    await assert.rejects(api.loadServices(), /SSH Port/);
  }
  settings.servicesSshPort = "";
  for (const key of ["relative/key", "/key\nfile"]) {
    settings.servicesSshIdentityFile = key;
    await assert.rejects(api.loadServices(), /Identity File/);
  }
  settings.servicesSshIdentityFile = "";
  for (const unit of [
    "--all",
    "example.service;id",
    "*.service",
    "a\n.service",
    "bad/path.service",
    "x.socket",
  ])
    await assert.rejects(api.loadUnitLogs("user", unit), /Invalid/);
  await assert.rejects(api.loadUnitLogs("root", "example.service"), /Invalid/);
  assert.equal(calls.length, 0);
});

test("host aliases and IPv6 work and cache identity changes with connection settings", async () => {
  const { api, settings, calls } = fixture();
  const first = api.servicesConnectionKey();
  settings.servicesSshHost = "homelab";
  await api.loadServices();
  assert.notEqual(api.servicesConnectionKey(), first);
  const second = api.servicesConnectionKey();
  settings.servicesSshIdentityFile = "~/.ssh/other";
  assert.notEqual(api.servicesConnectionKey(), second);
  settings.servicesSshHost = "user@[fd00::1]";
  await api.loadServices();
  assert.equal(calls.at(-1).args.at(-2), "user@fd00::1");
  settings.servicesSshHost = "";
  assert.equal(api.hasServicesHost(), false);
});

test("SSH failures give actionable messages without leaking stderr, even on EPIPE", async () => {
  for (const [code, stderr, expected, killed] of [
    ["ENOENT", "private detail", /OpenSSH is not installed/],
    [
      255,
      "Host key verification failed private detail",
      /host verification failed/,
    ],
    [
      255,
      "Permission denied (publickey) private detail",
      /authentication failed/,
    ],
    [255, "Could not resolve hostname private detail", /unreachable/],
    [127, "python3: command not found private detail", /Python 3 is required/],
    [null, "private detail", /timed out/, true],
    [1, "private detail", /Could not read/],
  ]) {
    const error = Object.assign(new Error("private error"), { code, killed });
    const { api } = fixture(() => ({ error, stderr, pipeError: true }));
    await assert.rejects(
      api.loadServices(),
      (e) => expected.test(e.message) && !e.message.includes("private"),
    );
  }
});

test("snapshot validation rejects malformed data and exposes partial scope failures", async () => {
  for (const value of [
    "banner\n{}",
    JSON.stringify({ ...snapshot, version: 2 }),
    JSON.stringify({ ...snapshot, services: [{}] }),
    JSON.stringify({
      ...snapshot,
      timers: [{ ...timer, nextRunAt: "invalid" }],
    }),
  ]) {
    const { api } = fixture(() => ({ stdout: value }));
    await assert.rejects(
      api.loadServices(),
      /invalid JSON|unsupported snapshot/,
    );
  }
  const partial = {
    ...snapshot,
    errors: [{ scope: "system", error: "System manager unavailable" }],
  };
  const { api } = fixture(() => ({ stdout: JSON.stringify(partial) }));
  assert.deepEqual(await api.loadServices(), partial);
  const { api: failed } = fixture(() => ({
    stdout: JSON.stringify({
      ...snapshot,
      services: [],
      timers: [],
      errors: [
        { scope: "user", error: "Unavailable" },
        { scope: "system", error: "Unavailable" },
      ],
    }),
  }));
  await assert.rejects(failed.loadServices(), /either systemd scope/);
});

test("journal lookup quotes escaped unit names and retains permission warnings", async () => {
  const unit = "example\\x2dtest@one.service";
  const logs = {
    scope: "user",
    unit,
    collectedAt: snapshot.collectedAt,
    text: "",
    warning: "Journal access denied",
  };
  const { api, calls } = fixture(() => ({ stdout: JSON.stringify(logs) }));
  assert.deepEqual(await api.loadUnitLogs("user", unit), logs);
  assert.equal(
    calls[0].args.at(-1),
    "'python3' '-' 'logs' 'user' 'example\\x2dtest@one.service'",
  );
  const { api: mismatch } = fixture(() => ({
    stdout: JSON.stringify({ ...logs, scope: "system" }),
  }));
  await assert.rejects(
    mismatch.loadUnitLogs("user", unit),
    /unsupported journal/,
  );
});

test("successful inactive oneshots are healthy; unrun jobs and disabled daemons are neutral", () => {
  const { api } = fixture();
  assert.equal(api.serviceHealth(service).label, "Succeeded");
  assert.equal(api.serviceHealth(service).attention, false);
  assert.equal(
    api.serviceHealth({ ...service, startedAt: null, finishedAt: null }).label,
    "Not run",
  );
  assert.equal(
    api.serviceHealth({ ...service, type: "simple", unitFileState: "disabled" })
      .label,
    "Inactive",
  );
  assert.equal(
    api.serviceHealth({ ...service, type: "simple", unitFileState: "enabled" })
      .label,
    "Stopped",
  );
  // systemd's Result honours SuccessExitStatus; nonzero status alone is not failure.
  assert.equal(api.serviceHealth({ ...service, exitCode: 10 }).level, "ok");
  assert.equal(
    api.serviceHealth({
      ...service,
      activeState: "active",
      subState: "running",
      type: "simple",
    }).label,
    "Running",
  );
});

test("failed jobs, restart loops and unavailable units need attention", () => {
  const { api } = fixture();
  for (const change of [
    { activeState: "failed" },
    { result: "exit-code", exitCode: 1 },
    { activeState: "activating", subState: "auto-restart" },
    { loadState: "not-found" },
  ])
    assert.equal(api.serviceHealth({ ...service, ...change }).attention, true);
  assert.equal(
    api.timerHealth({
      ...timer,
      serviceStatus: { ...service, result: "exit-code", exitCode: 1 },
    }).label,
    "Failed",
  );
});

test("systemd condition skips are neutral, including a newer skip after an old successful run", () => {
  const { api } = fixture();
  assert.equal(
    api.serviceHealth({ ...service, result: "exec-condition" }).label,
    "Skipped",
  );
  assert.equal(
    api.serviceHealth({ ...service, conditionResult: false }).label,
    "Skipped",
  );
  assert.equal(
    api.serviceHealth({ ...service, assertResult: false }).level,
    "error",
  );
  assert.equal(
    api.serviceHealth({ ...service, conditionResult: true, assertResult: true })
      .label,
    "Succeeded",
  );
});

test("timer health respects next deadlines, accuracy grace, running jobs, inactivity and unknown history", () => {
  const { api } = fixture();
  const deadline = Date.parse(timer.nextRunAt);
  assert.equal(api.timerHealth(timer, deadline - 1).label, "Scheduled");
  assert.equal(api.timerHealth(timer, deadline + 30_000).label, "Scheduled");
  assert.equal(api.timerHealth(timer, deadline + 61_000).label, "Overdue");
  assert.equal(
    api.timerHealth({ ...timer, accuracySeconds: 300 }, deadline + 200_000)
      .label,
    "Scheduled",
  );
  assert.equal(
    api.timerHealth(
      {
        ...timer,
        serviceStatus: {
          ...service,
          activeState: "activating",
          subState: "start",
        },
      },
      deadline + 99_000,
    ).label,
    "Running",
  );
  assert.equal(
    api.timerHealth({ ...timer, activeState: "inactive" }, deadline).label,
    "Stopped",
  );
  assert.equal(
    api.timerHealth(
      { ...timer, activeState: "inactive", unitFileState: "disabled" },
      deadline,
    ).attention,
    false,
  );
  assert.equal(
    api.timerHealth(
      { ...timer, nextRunAt: null, subState: "elapsed" },
      deadline,
    ).label,
    "Elapsed",
  );
  assert.equal(
    api.timerHealth({ ...timer, nextRunAt: null }, deadline).label,
    "No schedule",
  );
  assert.equal(
    api.timerHealth({ ...timer, lastTriggerAt: null }, deadline).label,
    "Scheduled",
  );
  assert.equal(
    api.timerHealth({ ...timer, serviceStatus: null }, deadline).level,
    "info",
  );
});
