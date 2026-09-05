import {
  Color,
  Icon,
  launchCommand,
  LaunchType,
  MenuBarExtra,
  open,
} from "@raycast/api";
import { useCachedPromise } from "@raycast/utils";
import { silentError } from "./fetch-error";
import { fmtDisk, fmtGiB, loadStats, URLS } from "./api";
import { fmtSpeed, loadDownloads } from "./downloads-api";
import { loadKuma } from "./kuma-api";
import { optionalUrl } from "./config";
import {
  backupConnectionKey,
  backupSummary,
  loadBackupHealth,
} from "./backups-api";
import { KUMA_URL } from "./kuma-api";

function openIf(url: string) {
  if (url) open(url);
}

function openDownloads() {
  launchCommand({ name: "downloads", type: LaunchType.UserInitiated });
}

function openBackups() {
  launchCommand({ name: "backups", type: LaunchType.UserInitiated });
}

export default function MenuBar() {
  const { data, isLoading, revalidate } = useCachedPromise(loadStats, [], {
    keepPreviousData: true,
    onError: silentError("Server stats"),
  });
  const { data: dl, revalidate: revalidateDl } = useCachedPromise(
    loadDownloads,
    [],
    { keepPreviousData: true, onError: silentError("Downloads") },
  );
  const kuma = useCachedPromise(
    async () => {
      try {
        return await loadKuma();
      } catch {
        return undefined;
      }
    },
    [],
    { keepPreviousData: true },
  );
  const backrestUrl = optionalUrl("backrestUrl");
  const backups = useCachedPromise(
    async (connectionKey: string) => {
      void connectionKey; // Partition cached snapshots by Backrest connection.
      return loadBackupHealth();
    },
    [backupConnectionKey()],
    {
      execute: Boolean(backrestUrl),
      keepPreviousData: false,
      onError: silentError("Backup health"),
    },
  );
  const downMonitors = kuma.data?.monitors.filter((m) => m.status === 0) ?? [];
  const backupIssues = backrestUrl
    ? [
        ...(backups.data?.plans ?? [])
          .filter((plan) => plan.health.attention)
          .map((plan) => ({
            id: `plan-${plan.id}`,
            label: `${plan.id}: ${plan.health.label}`,
            level: plan.health.level,
          })),
        ...(backups.data?.repositories ?? [])
          .filter((repo) => repo.health.attention)
          .map((repo) => ({
            id: `repo-${repo.id}`,
            label: `${repo.id}: ${repo.health.label}`,
            level: repo.health.level,
          })),
        ...(backups.data?.warnings ?? []).map((warning, i) => ({
          id: `warning-${i}`,
          label: warning,
          level: "warning",
        })),
      ]
    : [];
  const backupStale = Boolean(
    backups.data &&
    (backups.error ||
      backups.isLoading ||
      Date.now() - backups.data.fetchedAt > 120_000),
  );
  const alerts =
    downMonitors.length +
    backupIssues.length +
    (backrestUrl && backups.error ? 1 : 0);

  const dlSpeed = (dl?.qbit?.dlSpeed ?? 0) + (dl?.sab?.speedBps ?? 0);
  const upSpeed = dl?.qbit?.upSpeed ?? 0;
  const activeItems = [
    ...(dl?.qbit?.downloading ?? []).map((i) => ({ ...i, source: "qbit" })),
    ...(dl?.sab?.items ?? []).map((i) => ({ ...i, source: "sab" })),
  ].filter((i) => !i.paused);
  const hasActivity = activeItems.length > 0 || dlSpeed > 1e4 || upSpeed > 1e4;

  const cpuTemp = data?.temps?.server.cpu?.temp;
  const baseTitle =
    data?.cpu !== undefined
      ? `${Math.round(data.cpu.percent)}%${cpuTemp !== undefined ? ` ${cpuTemp}°` : ""}`
      : undefined;
  // ↓ marker while downloading, ⚠︎N for monitor or backup health issues.
  const title =
    baseTitle !== undefined
      ? `${baseTitle}${dlSpeed > 1e5 ? " ↓" : ""}${alerts > 0 ? ` ⚠︎${alerts}` : ""}`
      : alerts > 0
        ? `⚠︎${alerts}`
        : undefined;

  return (
    <MenuBarExtra
      icon={Icon.HardDrive}
      title={title}
      isLoading={isLoading}
      tooltip="Homelab"
    >
      <MenuBarExtra.Section title="Server">
        {data?.cpu && (
          <MenuBarExtra.Item
            icon={Icon.Gauge}
            title={`CPU ${Math.round(data.cpu.percent)}% · load ${data.cpu.load1.toFixed(1)}`}
            onAction={() => openIf(URLS.glances)}
          />
        )}
        {data?.mem && (
          <MenuBarExtra.Item
            icon={Icon.MemoryChip}
            title={`Memory ${fmtGiB(data.mem.free)} free / ${fmtGiB(data.mem.total)}`}
            onAction={() => openIf(URLS.glances)}
          />
        )}
        {data?.fs.map((f) => (
          <MenuBarExtra.Item
            key={f.mountPoint}
            icon={Icon.HardDrive}
            title={`${f.mountPoint} ${fmtDisk(f.free)} free / ${fmtDisk(f.total)}`}
            onAction={() => openIf(URLS.glances)}
          />
        ))}
        {data?.temps?.server && (
          <MenuBarExtra.Item
            icon={Icon.Temperature}
            title={[
              data.temps.server.cpu
                ? `CPU ${data.temps.server.cpu.temp}°`
                : null,
              ...data.temps.server.disks.map((d) => `${d.name} ${d.temp}°`),
            ]
              .filter(Boolean)
              .join(" · ")}
            onAction={() => openIf(URLS.homepage)}
          />
        )}
        {data?.uptime && (
          <MenuBarExtra.Item icon={Icon.Clock} title={`Up ${data.uptime}`} />
        )}
      </MenuBarExtra.Section>
      <MenuBarExtra.Section title="NAS">
        {data?.pool && (
          <MenuBarExtra.Item
            icon={Icon.Coin}
            title={`${data.pool.name} ${fmtDisk(data.pool.free)} free / ${fmtDisk(data.pool.total)}${data.pool.healthy ? "" : " — DEGRADED"}`}
            onAction={() => openIf(URLS.truenas)}
          />
        )}
        {data?.temps && data.temps.nas.disks.length > 0 && (
          <MenuBarExtra.Item
            icon={Icon.Temperature}
            title={data.temps.nas.disks
              .map((d) => `${d.name} ${d.temp}°`)
              .join(" · ")}
            onAction={() => openIf(URLS.truenas)}
          />
        )}
      </MenuBarExtra.Section>
      {alerts > 0 && (
        <MenuBarExtra.Section title="Alerts">
          {downMonitors.map((m) => (
            <MenuBarExtra.Item
              key={`dn-${m.name}`}
              icon={Icon.XMarkCircle}
              title={`DOWN: ${m.name}`}
              onAction={() => openIf(KUMA_URL)}
            />
          ))}
          {backrestUrl && backups.error && (
            <MenuBarExtra.Item
              icon={{ source: Icon.Warning, tintColor: Color.Red }}
              title={`Backup health unavailable${backups.data ? " — cached data" : ""}: ${backups.error.message}`}
              onAction={openBackups}
            />
          )}
          {backupIssues.map((issue) => (
            <MenuBarExtra.Item
              key={`bk-${issue.id}`}
              icon={{
                source: Icon.Warning,
                tintColor: issue.level === "error" ? Color.Red : Color.Orange,
              }}
              title={`Backup${backupStale ? " (cached)" : ""}: ${issue.label}`}
              onAction={openBackups}
            />
          ))}
        </MenuBarExtra.Section>
      )}
      {backrestUrl && (
        <MenuBarExtra.Section title="Backups">
          <MenuBarExtra.Item
            icon={Icon.HardDrive}
            title={
              backups.data
                ? `${backupStale ? "Cached · " : ""}${backupSummary(backups.data)}`
                : backups.error
                  ? "Backup health unavailable"
                  : "Loading backup health…"
            }
            onAction={openBackups}
          />
          <MenuBarExtra.Item
            title="Backup Health and Storage…"
            icon={Icon.HardDrive}
            onAction={openBackups}
          />
        </MenuBarExtra.Section>
      )}
      {hasActivity && (
        <MenuBarExtra.Section title="Downloads">
          <MenuBarExtra.Item
            icon={Icon.LineChart}
            title={`↓ ${fmtSpeed(dlSpeed)} · ↑ ${fmtSpeed(upSpeed)}`}
            onAction={openDownloads}
          />
          {activeItems.slice(0, 5).map((i) => (
            <MenuBarExtra.Item
              key={i.id}
              icon={Icon.Download}
              title={`${Math.round(i.progress * 100)}% · ${i.name.length > 45 ? i.name.slice(0, 45) + "…" : i.name}${i.eta && i.eta !== "∞" ? ` · ${i.eta}` : ""}`}
              onAction={openDownloads}
            />
          ))}
          {dl?.qbit && dl.qbit.seedCount > 0 && upSpeed > 0 && (
            <MenuBarExtra.Item
              icon={Icon.ArrowUpCircle}
              title={`Seeding ${dl.qbit.seedCount} · ↑ ${fmtSpeed(upSpeed)}`}
              onAction={openDownloads}
            />
          )}
        </MenuBarExtra.Section>
      )}
      {data && data.errors.length > 0 && (
        <MenuBarExtra.Section title="Errors">
          {data.errors.map((e, i) => (
            <MenuBarExtra.Item
              key={i}
              icon={Icon.Warning}
              title={e.slice(0, 60)}
            />
          ))}
        </MenuBarExtra.Section>
      )}
      <MenuBarExtra.Section>
        <MenuBarExtra.Item
          icon={Icon.ArrowClockwise}
          title={
            data
              ? `Updated ${new Date(data.fetchedAt).toLocaleTimeString()} — Refresh`
              : "Refresh"
          }
          onAction={() => {
            revalidate();
            revalidateDl();
            kuma.revalidate();
            if (backrestUrl) backups.revalidate();
          }}
        />
      </MenuBarExtra.Section>
    </MenuBarExtra>
  );
}
