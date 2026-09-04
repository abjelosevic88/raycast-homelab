import {
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
import { HEALTH_URLS, loadBackups } from "./health-api";
import { KUMA_URL } from "./kuma-api";

function openIf(url: string) {
  if (url) open(url);
}

function openDownloads() {
  launchCommand({ name: "downloads", type: LaunchType.UserInitiated });
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
  const backups = useCachedPromise(
    async () => {
      try {
        return await loadBackups();
      } catch {
        return undefined;
      }
    },
    [],
    { keepPreviousData: true },
  );
  const downMonitors = kuma.data?.monitors.filter((m) => m.status === 0) ?? [];
  const failedBackups = backups.data?.filter((b) => !b.ok) ?? [];
  const alerts = downMonitors.length + failedBackups.length;

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
  // ↓ marker while downloading, ⚠︎N when monitors are down or a backup failed
  const title =
    baseTitle !== undefined
      ? `${baseTitle}${dlSpeed > 1e5 ? " ↓" : ""}${alerts > 0 ? ` ⚠︎${alerts}` : ""}`
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
          {failedBackups.map((b) => (
            <MenuBarExtra.Item
              key={`bk-${b.planId}`}
              icon={Icon.Warning}
              title={`Backup failed: ${b.planId}`}
              onAction={() => openIf(HEALTH_URLS.backrest)}
            />
          ))}
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
          }}
        />
      </MenuBarExtra.Section>
    </MenuBarExtra>
  );
}
