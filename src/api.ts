import { optionalUrl, requireUrl, setting, urlGroup } from "./config";

// Resolved from preferences / env file at access time; "" when unset.
export const URLS = urlGroup({
  glances: "glancesUrl",
  temps: "tempsUrl",
  truenas: "truenasUrl",
  homepage: "homepageUrl",
});

/** Extra filesystem mount point to show beside "/" (preference `storageMount`). */
export function storageMount(): string {
  return setting("storageMount").replace(/\/+$/, "") || "";
}

export interface CpuStats {
  percent: number;
  name: string;
  load1: number;
  cores: number;
}

export interface MemStats {
  total: number;
  free: number; // "available" — what free -h calls available, matches Homepage
  percent: number;
}

export interface FsStats {
  mountPoint: string;
  total: number;
  free: number;
  percent: number;
}

export interface TempReading {
  name: string;
  temp: number;
  warn: number;
}

export interface Temps {
  server: { cpu: TempReading | null; disks: TempReading[] };
  nas: { disks: TempReading[] };
}

export interface PoolStats {
  name: string;
  total: number;
  free: number;
  healthy: boolean;
}

export interface HomelabStats {
  cpu?: CpuStats;
  mem?: MemStats;
  fs: FsStats[];
  uptime?: string;
  temps?: Temps;
  pool?: PoolStats;
  errors: string[];
  fetchedAt: number;
}

const TIMEOUT_MS = 8000;

async function getJson<T>(
  url: string,
  headers?: Record<string, string>,
): Promise<T> {
  const res = await fetch(url, {
    headers,
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`${url} → HTTP ${res.status}`);
  return (await res.json()) as T;
}

// "20 days, 5:35:18" → "20d 5h"
export function compactUptime(raw: string): string {
  const m = raw.match(/(?:(\d+)\s+days?,\s*)?(\d+):(\d+):\d+/);
  if (!m) return raw;
  const days = Number(m[1] ?? 0);
  const hours = Number(m[2]);
  const mins = Number(m[3]);
  if (days > 0) return `${days}d ${hours}h`;
  if (hours > 0) return `${hours}h ${mins}m`;
  return `${mins}m`;
}

// RAM shown in binary units, like the Homepage widget (30.6 GiB)
export function fmtGiB(bytes: number): string {
  return `${(bytes / 2 ** 30).toFixed(1)} GiB`;
}

// Disks shown in decimal units, like the Homepage widget (500 GB, 1.01 TB)
export function fmtDisk(bytes: number): string {
  if (bytes >= 1e12) return `${(bytes / 1e12).toFixed(2)} TB`;
  if (bytes >= 1e9) return `${Math.round(bytes / 1e9)} GB`;
  return `${Math.round(bytes / 1e6)} MB`;
}

interface GlancesQuicklook {
  cpu: number;
  cpu_name: string;
}
interface GlancesLoad {
  min1: number;
  cpucore: number;
}
interface GlancesMem {
  total: number;
  available: number;
  percent: number;
}
interface GlancesFs {
  mnt_point: string;
  size: number;
  free: number;
  percent: number;
}
interface TempsJson {
  server?: { cpu?: TempReading & { name?: string }; disks?: TempReading[] };
  nas?: { disks?: TempReading[] };
}
interface TrueNasPool {
  name: string;
  size: number;
  free: number;
  healthy: boolean;
}

export interface ProcessInfo {
  pid: number;
  name: string;
  cmd: string;
  cpu: number; // percent
  memRss: number; // bytes
  memPct: number;
}

export interface TopProcesses {
  topCpu: ProcessInfo[];
  topMem: ProcessInfo[];
}

interface GlancesProcess {
  pid: number;
  name: string;
  cmdline?: string[] | string;
  cpu_percent?: number | string;
  memory_percent?: number;
  memory_info?: { rss?: number };
}

// separate from loadStats: the processlist payload is ~1 MB, only the Stats view wants it
export async function loadTopProcesses(limit = 5): Promise<TopProcesses> {
  const g = requireUrl("glancesUrl", "Glances");
  const raw = await getJson<GlancesProcess[]>(`${g}/api/4/processlist`);
  const procs: ProcessInfo[] = raw.map((p) => ({
    pid: p.pid,
    name: p.name,
    cmd: Array.isArray(p.cmdline) ? p.cmdline.join(" ") : (p.cmdline ?? ""),
    cpu: typeof p.cpu_percent === "number" ? p.cpu_percent : 0,
    memRss: p.memory_info?.rss ?? 0,
    memPct: p.memory_percent ?? 0,
  }));
  return {
    topCpu: [...procs].sort((a, b) => b.cpu - a.cpu).slice(0, limit),
    topMem: [...procs].sort((a, b) => b.memRss - a.memRss).slice(0, limit),
  };
}

export async function loadStats(): Promise<HomelabStats> {
  const g = optionalUrl("glancesUrl");
  const tempsUrl = optionalUrl("tempsUrl");
  const extraMount = storageMount();

  const stats: HomelabStats = { fs: [], errors: [], fetchedAt: Date.now() };

  const tasks: Promise<void>[] = [];

  if (g) {
    tasks.push(
      Promise.all([
        getJson<GlancesQuicklook>(`${g}/api/4/quicklook`),
        getJson<GlancesLoad>(`${g}/api/4/load`),
      ]).then(([q, l]) => {
        stats.cpu = {
          percent: q.cpu,
          name: q.cpu_name,
          load1: l.min1,
          cores: l.cpucore,
        };
      }),
      getJson<GlancesMem>(`${g}/api/4/mem`).then((m) => {
        stats.mem = { total: m.total, free: m.available, percent: m.percent };
      }),
      getJson<GlancesFs[]>(`${g}/api/4/fs`).then((list) => {
        stats.fs = list
          .filter(
            (f) =>
              f.mnt_point === "/" || (extraMount && f.mnt_point === extraMount),
          )
          .sort((a, b) => a.mnt_point.localeCompare(b.mnt_point))
          .map((f) => ({
            mountPoint: f.mnt_point,
            total: f.size,
            free: f.free,
            percent: f.percent,
          }));
      }),
      getJson<string>(`${g}/api/4/uptime`).then((u) => {
        stats.uptime = compactUptime(u);
      }),
    );
  }

  if (tempsUrl) {
    tasks.push(
      getJson<TempsJson>(tempsUrl).then((t) => {
        stats.temps = {
          server: {
            cpu: t.server?.cpu
              ? { ...t.server.cpu, name: t.server.cpu.name ?? "CPU" }
              : null,
            disks: t.server?.disks ?? [],
          },
          nas: { disks: t.nas?.disks ?? [] },
        };
      }),
    );
  }

  const n = optionalUrl("truenasUrl");
  const truenasKey = setting("truenasApiKey");
  if (n && truenasKey) {
    tasks.push(
      getJson<TrueNasPool[]>(`${n}/api/v2.0/pool`, {
        Authorization: `Bearer ${truenasKey}`,
      }).then((pools) => {
        const p = pools[0];
        if (p)
          stats.pool = {
            name: p.name,
            total: p.size,
            free: p.free,
            healthy: p.healthy,
          };
      }),
    );
  }

  const results = await Promise.allSettled(tasks);
  for (const r of results) {
    if (r.status === "rejected")
      stats.errors.push(String(r.reason?.message ?? r.reason));
  }
  return stats;
}
