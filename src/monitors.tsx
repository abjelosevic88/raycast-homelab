import { Action, ActionPanel, Color, Icon, List } from "@raycast/api";
import { useCachedPromise } from "@raycast/utils";
import { useEffect } from "react";
import { KUMA_URL, loadKuma, MonitorStatus } from "./kuma-api";

const POLL_MS = 15000;

const STATUS_META: Record<number, { label: string; color: Color; icon: Icon }> = {
  0: { label: "DOWN", color: Color.Red, icon: Icon.XMarkCircle },
  1: { label: "up", color: Color.Green, icon: Icon.CheckCircle },
  2: { label: "pending", color: Color.Orange, icon: Icon.CircleProgress50 },
  3: { label: "maintenance", color: Color.Blue, icon: Icon.Hammer },
};

function monitorItem(m: MonitorStatus) {
  const meta = STATUS_META[m.status] ?? STATUS_META[2];
  return (
    <List.Item
      key={`${m.group ?? ""}/${m.name}`}
      icon={{ source: meta.icon, tintColor: meta.color }}
      title={m.name}
      subtitle={m.group}
      accessories={[
        ...(m.ping !== undefined ? [{ text: `${Math.round(m.ping)} ms` }] : []),
        ...(m.uptime24 !== undefined ? [{ text: `${(m.uptime24 * 100).toFixed(1)}%`, tooltip: "24h uptime" }] : []),
        { tag: { value: meta.label, color: meta.color } },
      ]}
      actions={
        <ActionPanel>
          <Action.OpenInBrowser title="Open Uptime Kuma" url={KUMA_URL} />
        </ActionPanel>
      }
    />
  );
}

export default function Monitors() {
  const { data, isLoading, revalidate } = useCachedPromise(loadKuma, [], { keepPreviousData: true });

  useEffect(() => {
    const t = setInterval(revalidate, POLL_MS);
    return () => clearInterval(t);
  }, [revalidate]);

  const monitors = data?.monitors ?? [];
  const down = monitors.filter((m) => m.status === 0);
  const notUp = monitors.filter((m) => m.status === 2 || m.status === 3);
  const up = monitors.filter((m) => m.status === 1);

  return (
    <List
      isLoading={isLoading}
      searchBarPlaceholder={`Filter ${monitors.length} monitors…`}
      navigationTitle={down.length > 0 ? `Monitors — ${down.length} DOWN` : "Monitors — all up"}
    >
      {down.length > 0 && <List.Section title={`Down (${down.length})`}>{down.map(monitorItem)}</List.Section>}
      {notUp.length > 0 && (
        <List.Section title={`Pending / Maintenance (${notUp.length})`}>{notUp.map(monitorItem)}</List.Section>
      )}
      <List.Section
        title={`Up (${up.length})`}
        subtitle={data?.source === "status-page" ? "status page only — add a Kuma API key for all monitors" : undefined}
      >
        {up.map(monitorItem)}
      </List.Section>
    </List>
  );
}
