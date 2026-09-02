import { Icon, MenuBarExtra, open } from "@raycast/api";
import { useCachedPromise } from "@raycast/utils";
import { fmtDisk, fmtGiB, loadStats } from "./api";

export default function MenuBar() {
  const { data, isLoading, revalidate } = useCachedPromise(loadStats, [], { keepPreviousData: true });

  const cpuTemp = data?.temps?.server.cpu?.temp;
  const title =
    data?.cpu !== undefined
      ? `${Math.round(data.cpu.percent)}%${cpuTemp !== undefined ? ` ${cpuTemp}°` : ""}`
      : undefined;

  return (
    <MenuBarExtra icon={Icon.HardDrive} title={title} isLoading={isLoading} tooltip="Homelab">
      <MenuBarExtra.Section title="Server">
        {data?.cpu && (
          <MenuBarExtra.Item
            icon={Icon.Gauge}
            title={`CPU ${Math.round(data.cpu.percent)}% · load ${data.cpu.load1.toFixed(1)}`}
            onAction={() => open("https://glances.bjelke.org")}
          />
        )}
        {data?.mem && (
          <MenuBarExtra.Item
            icon={Icon.MemoryChip}
            title={`Memory ${fmtGiB(data.mem.free)} free / ${fmtGiB(data.mem.total)}`}
            onAction={() => open("https://glances.bjelke.org")}
          />
        )}
        {data?.fs.map((f) => (
          <MenuBarExtra.Item
            key={f.mountPoint}
            icon={Icon.HardDrive}
            title={`${f.mountPoint} ${fmtDisk(f.free)} free / ${fmtDisk(f.total)}`}
            onAction={() => open("https://glances.bjelke.org")}
          />
        ))}
        {data?.temps?.server && (
          <MenuBarExtra.Item
            icon={Icon.Temperature}
            title={[
              data.temps.server.cpu ? `CPU ${data.temps.server.cpu.temp}°` : null,
              ...data.temps.server.disks.map((d) => `${d.name} ${d.temp}°`),
            ]
              .filter(Boolean)
              .join(" · ")}
            onAction={() => open("https://home.bjelke.org")}
          />
        )}
        {data?.uptime && <MenuBarExtra.Item icon={Icon.Clock} title={`Up ${data.uptime}`} />}
      </MenuBarExtra.Section>
      <MenuBarExtra.Section title="NAS">
        {data?.pool && (
          <MenuBarExtra.Item
            icon={Icon.Coin}
            title={`${data.pool.name} ${fmtDisk(data.pool.free)} free / ${fmtDisk(data.pool.total)}${data.pool.healthy ? "" : " — DEGRADED"}`}
            onAction={() => open("https://nas.bjelke.org")}
          />
        )}
        {data?.temps && data.temps.nas.disks.length > 0 && (
          <MenuBarExtra.Item
            icon={Icon.Temperature}
            title={data.temps.nas.disks.map((d) => `${d.name} ${d.temp}°`).join(" · ")}
            onAction={() => open("https://nas.bjelke.org")}
          />
        )}
      </MenuBarExtra.Section>
      {data && data.errors.length > 0 && (
        <MenuBarExtra.Section title="Errors">
          {data.errors.map((e, i) => (
            <MenuBarExtra.Item key={i} icon={Icon.Warning} title={e.slice(0, 60)} />
          ))}
        </MenuBarExtra.Section>
      )}
      <MenuBarExtra.Section>
        <MenuBarExtra.Item
          icon={Icon.ArrowClockwise}
          title={data ? `Updated ${new Date(data.fetchedAt).toLocaleTimeString()} — Refresh` : "Refresh"}
          onAction={() => revalidate()}
        />
      </MenuBarExtra.Section>
    </MenuBarExtra>
  );
}
