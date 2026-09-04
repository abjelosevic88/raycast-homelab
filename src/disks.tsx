import { Action, ActionPanel, Color, Icon, List, Keyboard } from "@raycast/api";
import { useCachedPromise } from "@raycast/utils";
import { HEALTH_URLS } from "./health-api";
import { has, requireUrl } from "./config";
import NotConfigured from "./not-configured";

interface Disk {
  wwn: string;
  name: string;
  host: string;
  status: number; // 0 = passed; bit 1 = SMART failed, bit 2 = Scrutiny thresholds failed
  model: string;
  serial: string;
  capacity: number;
  temp?: number;
  powerOnHours?: number;
  lastChecked?: string;
}

async function loadDisks(): Promise<Disk[]> {
  const res = await fetch(
    `${requireUrl("scrutinyUrl", "Scrutiny")}/api/summary`,
    { signal: AbortSignal.timeout(10000) },
  );
  if (!res.ok) throw new Error(`Scrutiny → HTTP ${res.status}`);
  const body = (await res.json()) as {
    data: {
      summary: Record<
        string,
        {
          device: {
            wwn: string;
            device_name: string;
            host_id?: string;
            device_status: number;
            model_name?: string;
            serial_number?: string;
            capacity?: number;
          };
          smart?: {
            temp?: number;
            power_on_hours?: number;
            collector_date?: string;
          };
        }
      >;
    };
  };
  return Object.values(body.data.summary).map((e) => ({
    wwn: e.device.wwn,
    name: e.device.device_name,
    host: e.device.host_id || "server",
    status: e.device.device_status,
    model: e.device.model_name ?? "",
    serial: e.device.serial_number ?? "",
    capacity: e.device.capacity ?? 0,
    temp: e.smart?.temp,
    powerOnHours: e.smart?.power_on_hours,
    lastChecked: e.smart?.collector_date,
  }));
}

function statusMeta(status: number): { label: string; color: Color } {
  if (status === 0) return { label: "passed", color: Color.Green };
  const parts = [];
  if (status & 1) parts.push("SMART failed");
  if (status & 2) parts.push("thresholds failed");
  return { label: parts.join(" + ") || "warning", color: Color.Red };
}

function fmtCap(bytes: number): string {
  return bytes >= 1e12
    ? `${(bytes / 1e12).toFixed(0)} TB`
    : `${Math.round(bytes / 1e9)} GB`;
}

function fmtAge(hours?: number): string | undefined {
  if (!hours) return undefined;
  const years = hours / 8760;
  return years >= 1
    ? `${years.toFixed(1)}y on`
    : `${Math.round(hours / 24)}d on`;
}

export default function Disks() {
  const configured = has("scrutinyUrl");
  const { data, isLoading, revalidate } = useCachedPromise(
    async (ok: boolean) => (ok ? await loadDisks() : []),
    [configured],
    {
      keepPreviousData: true,
    },
  );

  const hosts = [...new Set((data ?? []).map((d) => d.host))].sort();

  return (
    <List isLoading={isLoading} searchBarPlaceholder="Filter disks…">
      {!configured && <NotConfigured service="Scrutiny" needs="URL" />}
      {hosts.map((host) => (
        <List.Section
          key={host}
          title={host}
          subtitle={`${data?.filter((d) => d.host === host).length} disks`}
        >
          {data
            ?.filter((d) => d.host === host)
            .sort((a, b) => a.name.localeCompare(b.name))
            .map((d) => {
              const meta = statusMeta(d.status);
              return (
                <List.Item
                  key={d.wwn}
                  icon={{
                    source: d.status === 0 ? Icon.HardDrive : Icon.Warning,
                    tintColor: meta.color,
                  }}
                  title={d.name}
                  subtitle={`${d.model} · ${fmtCap(d.capacity)}`}
                  accessories={[
                    ...(d.temp !== undefined
                      ? [
                          {
                            tag: {
                              value: `${d.temp}°`,
                              color:
                                d.temp >= 50
                                  ? Color.Orange
                                  : Color.SecondaryText,
                            },
                          },
                        ]
                      : []),
                    ...(fmtAge(d.powerOnHours)
                      ? [{ text: fmtAge(d.powerOnHours) }]
                      : []),
                    { tag: { value: meta.label, color: meta.color } },
                  ]}
                  actions={
                    <ActionPanel>
                      <Action.OpenInBrowser
                        title="Open in Scrutiny"
                        url={`${HEALTH_URLS.scrutiny}/web/device/${d.wwn}`}
                      />
                      <Action.CopyToClipboard
                        title="Copy Serial"
                        content={d.serial}
                        shortcut={{ modifiers: ["cmd"], key: "c" }}
                      />
                      <Action
                        title="Refresh"
                        icon={Icon.ArrowClockwise}
                        shortcut={Keyboard.Shortcut.Common.Refresh}
                        onAction={revalidate}
                      />
                    </ActionPanel>
                  }
                />
              );
            })}
        </List.Section>
      ))}
    </List>
  );
}
