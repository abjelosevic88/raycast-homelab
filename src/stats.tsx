import { Action, ActionPanel, Color, Icon, List, Keyboard } from "@raycast/api";
import { getProgressIcon, useCachedPromise } from "@raycast/utils";
import { useEffect } from "react";
import { fmtDisk, fmtGiB, loadStats, loadTopProcesses, ProcessInfo, TempReading, URLS } from "./api";

function procItem(p: ProcessInfo, kind: "cpu" | "mem", actions: React.JSX.Element) {
  return (
    <List.Item
      key={`${kind}-${p.pid}`}
      icon={{ source: kind === "cpu" ? Icon.Gauge : Icon.MemoryChip, tintColor: Color.SecondaryText }}
      title={p.name}
      subtitle={{ value: p.cmd.length > 40 ? p.cmd.slice(0, 40) + "…" : p.cmd, tooltip: p.cmd }}
      accessories={
        kind === "cpu"
          ? [{ tag: `${p.cpu.toFixed(1)}%` }, { text: fmtGiB(p.memRss) }]
          : [{ tag: fmtGiB(p.memRss) }, { text: `${p.memPct.toFixed(1)}%` }]
      }
      actions={actions}
    />
  );
}

function usageColor(percent: number): Color {
  if (percent >= 90) return Color.Red;
  if (percent >= 70) return Color.Orange;
  return Color.Green;
}

function tempTag(t: TempReading): List.Item.Accessory {
  const margin = t.warn - t.temp;
  const color = margin <= 0 ? Color.Red : margin <= 10 ? Color.Orange : Color.SecondaryText;
  return { tag: { value: `${t.temp}°`, color }, tooltip: `${t.name} — warns at ${t.warn}°` };
}

function CommonActions(props: { onRefresh: () => void }) {
  return (
    <ActionPanel>
      <Action
        title="Refresh"
        icon={Icon.ArrowClockwise}
        shortcut={Keyboard.Shortcut.Common.Refresh}
        onAction={props.onRefresh}
      />
      <Action.OpenInBrowser title="Open Homepage" url={URLS.homepage} />
      <Action.OpenInBrowser title="Open Glances" url={URLS.glances} shortcut={{ modifiers: ["cmd"], key: "g" }} />
      <Action.OpenInBrowser title="Open TrueNAS" url={URLS.truenas} shortcut={Keyboard.Shortcut.Common.New} />
    </ActionPanel>
  );
}

export default function Stats() {
  const { data, isLoading, revalidate } = useCachedPromise(loadStats, [], { keepPreviousData: true });
  const procs = useCachedPromise(loadTopProcesses, [], { keepPreviousData: true });
  const refreshAll = () => {
    revalidate();
    procs.revalidate();
  };
  useEffect(() => {
    const t = setInterval(refreshAll, 15000);
    return () => clearInterval(t);
  }, []);
  const actions = <CommonActions onRefresh={refreshAll} />;

  const rootFs = data?.fs.find((f) => f.mountPoint === "/");
  const storageFs = data?.fs.find((f) => f.mountPoint === "/mnt/storage");
  const rootTemp = data?.temps?.server.disks.find((d) => d.name === "/");
  const storageTemp = data?.temps?.server.disks.find((d) => d.name === "/mnt/storage");

  return (
    <List isLoading={isLoading || procs.isLoading}>
      <List.Section title="Server">
        {data?.cpu && (
          <List.Item
            icon={getProgressIcon(data.cpu.percent / 100, usageColor(data.cpu.percent))}
            title="CPU"
            subtitle={data.cpu.name.replace(/\(R\)|\(TM\)|CPU @.*$/g, "").trim()}
            accessories={[
              { text: `${Math.round(data.cpu.percent)}%`, tooltip: "CPU usage" },
              {
                tag: `load ${data.cpu.load1.toFixed(1)}`,
                tooltip: `1-min load average (${data.cpu.cores} cores)`,
              },
              ...(data.temps?.server.cpu ? [tempTag(data.temps.server.cpu)] : []),
            ]}
            actions={actions}
          />
        )}
        {data?.mem && (
          <List.Item
            icon={getProgressIcon(data.mem.percent / 100, usageColor(data.mem.percent))}
            title="Memory"
            accessories={[{ text: `${fmtGiB(data.mem.free)} free / ${fmtGiB(data.mem.total)}` }]}
            actions={actions}
          />
        )}
        {rootFs && (
          <List.Item
            icon={getProgressIcon(rootFs.percent / 100, usageColor(rootFs.percent))}
            title="System SSD"
            subtitle="/"
            accessories={[
              { text: `${fmtDisk(rootFs.free)} free / ${fmtDisk(rootFs.total)}` },
              ...(rootTemp ? [tempTag(rootTemp)] : []),
            ]}
            actions={actions}
          />
        )}
        {storageFs && (
          <List.Item
            icon={getProgressIcon(storageFs.percent / 100, usageColor(storageFs.percent))}
            title="Storage SSD"
            subtitle="/mnt/storage"
            accessories={[
              { text: `${fmtDisk(storageFs.free)} free / ${fmtDisk(storageFs.total)}` },
              ...(storageTemp ? [tempTag(storageTemp)] : []),
            ]}
            actions={actions}
          />
        )}
        {data?.uptime && (
          <List.Item icon={Icon.Clock} title="Uptime" accessories={[{ text: data.uptime }]} actions={actions} />
        )}
      </List.Section>

      <List.Section title="NAS">
        {data?.pool && (
          <List.Item
            icon={getProgressIcon(
              1 - data.pool.free / data.pool.total,
              usageColor((1 - data.pool.free / data.pool.total) * 100),
            )}
            title={`Pool ${data.pool.name}`}
            accessories={[
              { text: `${fmtDisk(data.pool.free)} free / ${fmtDisk(data.pool.total)}` },
              data.pool.healthy
                ? { tag: { value: "healthy", color: Color.Green } }
                : { tag: { value: "DEGRADED", color: Color.Red } },
            ]}
            actions={actions}
          />
        )}
        {data?.temps && data.temps.nas.disks.length > 0 && (
          <List.Item
            icon={Icon.Temperature}
            title="Drive Temps"
            accessories={data.temps.nas.disks.map((d) => ({
              tag: { value: `${d.name} ${d.temp}°`, color: d.warn - d.temp <= 5 ? Color.Orange : Color.SecondaryText },
            }))}
            actions={actions}
          />
        )}
      </List.Section>

      <List.Section title="Top CPU">
        {procs.data?.topCpu.map((p) => procItem(p, "cpu", actions))}
      </List.Section>
      <List.Section title="Top Memory">
        {procs.data?.topMem.map((p) => procItem(p, "mem", actions))}
      </List.Section>

      {data && data.errors.length > 0 && (
        <List.Section title="Errors">
          {data.errors.map((e, i) => (
            <List.Item key={i} icon={{ source: Icon.Warning, tintColor: Color.Red }} title={e} actions={actions} />
          ))}
        </List.Section>
      )}
    </List>
  );
}
