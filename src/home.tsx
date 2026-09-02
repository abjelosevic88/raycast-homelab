import { Action, ActionPanel, Color, Icon, List } from "@raycast/api";
import { getProgressIcon, useCachedPromise } from "@raycast/utils";
import { useEffect } from "react";
import { fmtDisk, fmtGiB, loadStats, URLS } from "./api";
import { DL_URLS, fmtSpeed, loadDownloads } from "./downloads-api";
import { JELLYSEERR_URL } from "./jellyseerr-api";
import Stats from "./stats";
import Downloads from "./downloads";
import Request from "./request";
import Requests from "./requests";
import Transaction from "./transaction";
import Monitors from "./monitors";
import { loadKuma } from "./kuma-api";

const POLL_MS = 10000;

// Pushed (not launched) so Esc/Back returns here instead of the Raycast root
const COMMANDS = [
  { name: "stats", title: "Homelab Stats", subtitle: "CPU · RAM · disks · temps · NAS", icon: Icon.Gauge, view: () => <Stats /> },
  { name: "downloads", title: "Homelab Downloads", subtitle: "Torrents & Usenet, live", icon: Icon.Download, view: () => <Downloads /> },
  { name: "request", title: "Discover Media", subtitle: "Browse & request movies and shows", icon: Icon.FilmStrip, view: () => <Request /> },
  { name: "requests", title: "Request History", subtitle: "Approve · decline · retry", icon: Icon.BulletPoints, view: () => <Requests /> },
  { name: "transaction", title: "Add Transaction", subtitle: "Firefly Pico assistant & templates", icon: Icon.Coins, view: () => <Transaction /> },
  { name: "monitors", title: "Homelab Monitors", subtitle: "Uptime Kuma — what's down", icon: Icon.Heartbeat, view: () => <Monitors /> },
];

const LINKS: { title: string; url: string; icon: Icon }[] = [
  { title: "Homepage", url: URLS.homepage, icon: Icon.House },
  { title: "Jellyfin", url: "https://jellyfin.bjelke.org", icon: Icon.Play },
  { title: "Jellyseerr", url: JELLYSEERR_URL, icon: Icon.Stars },
  { title: "Glances", url: URLS.glances, icon: Icon.LineChart },
  { title: "TrueNAS", url: URLS.truenas, icon: Icon.HardDrive },
  { title: "qBittorrent", url: DL_URLS.qbit, icon: Icon.Download },
  { title: "SABnzbd", url: DL_URLS.sab, icon: Icon.Download },
  { title: "Forgejo", url: "https://git.bjelke.org", icon: Icon.Code },
];

export default function Home() {
  const stats = useCachedPromise(loadStats, [], { keepPreviousData: true });
  const dls = useCachedPromise(loadDownloads, [], { keepPreviousData: true });
  const kuma = useCachedPromise(loadKuma, [], { keepPreviousData: true });

  useEffect(() => {
    const t = setInterval(() => {
      stats.revalidate();
      dls.revalidate();
      kuma.revalidate();
    }, POLL_MS);
    return () => clearInterval(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const s = stats.data;
  const d = dls.data;

  const cpuTemp = s?.temps?.server.cpu?.temp;
  const dlSpeed = (d?.qbit?.dlSpeed ?? 0) + (d?.sab?.speedBps ?? 0);
  const upSpeed = d?.qbit?.upSpeed ?? 0;
  const activeCount = (d?.qbit?.downloading.length ?? 0) + (d?.sab?.items.length ?? 0);

  return (
    <List isLoading={stats.isLoading || dls.isLoading} searchBarPlaceholder="Homelab…">
      <List.Section title="Right Now">
        {s?.cpu && (
          <List.Item
            icon={getProgressIcon(s.cpu.percent / 100, s.cpu.percent > 80 ? Color.Red : Color.Green)}
            title="Server"
            subtitle={`up ${s.uptime ?? "—"}`}
            accessories={[
              { text: `CPU ${Math.round(s.cpu.percent)}%` },
              ...(cpuTemp !== undefined ? [{ tag: { value: `${cpuTemp}°`, color: cpuTemp > 80 ? Color.Red : Color.SecondaryText } }] : []),
              ...(s.mem ? [{ text: `${fmtGiB(s.mem.free)} RAM free` }] : []),
            ]}
            actions={
              <ActionPanel>
                <Action.Push title="Open Homelab Stats" icon={Icon.Gauge} target={<Stats />} />
                <Action.OpenInBrowser title="Open Glances" url={URLS.glances} />
              </ActionPanel>
            }
          />
        )}
        {s?.pool && (
          <List.Item
            icon={getProgressIcon(1 - s.pool.free / s.pool.total, s.pool.healthy ? Color.Green : Color.Red)}
            title="NAS"
            subtitle={s.pool.healthy ? "healthy" : "DEGRADED"}
            accessories={[
              { text: `${fmtDisk(s.pool.free)} free of ${fmtDisk(s.pool.total)}` },
              ...(s.temps?.nas.disks.length
                ? [{ tag: `${Math.max(...s.temps.nas.disks.map((x) => x.temp))}° max` }]
                : []),
            ]}
            actions={
              <ActionPanel>
                <Action.Push title="Open Homelab Stats" icon={Icon.Gauge} target={<Stats />} />
                <Action.OpenInBrowser title="Open TrueNAS" url={URLS.truenas} />
              </ActionPanel>
            }
          />
        )}
        <List.Item
          icon={
            activeCount > 0
              ? { source: Icon.Download, tintColor: Color.Blue }
              : { source: Icon.Download, tintColor: Color.SecondaryText }
          }
          title="Downloads"
          subtitle={
            activeCount > 0
              ? `${activeCount} active`
              : (d?.qbit?.seedCount ?? 0) > 0
                ? `idle · seeding ${d?.qbit?.seedCount}`
                : "idle"
          }
          accessories={[
            ...(dlSpeed > 0 ? [{ text: `↓ ${fmtSpeed(dlSpeed)}` }] : []),
            ...(upSpeed > 0 ? [{ text: `↑ ${fmtSpeed(upSpeed)}` }] : []),
          ]}
          actions={
            <ActionPanel>
              <Action.Push title="Open Homelab Downloads" icon={Icon.Download} target={<Downloads />} />
            </ActionPanel>
          }
        />
        {kuma.data &&
          (() => {
            const down = kuma.data.monitors.filter((m) => m.status === 0);
            return (
              <List.Item
                icon={{
                  source: down.length > 0 ? Icon.XMarkCircle : Icon.Heartbeat,
                  tintColor: down.length > 0 ? Color.Red : Color.Green,
                }}
                title="Monitors"
                subtitle={
                  down.length > 0
                    ? `${down.length} DOWN: ${down.map((m) => m.name).slice(0, 3).join(", ")}`
                    : `all ${kuma.data.monitors.length} up`
                }
                actions={
                  <ActionPanel>
                    <Action.Push title="Open Homelab Monitors" icon={Icon.Heartbeat} target={<Monitors />} />
                    <Action.OpenInBrowser title="Open Uptime Kuma" url="https://kuma.bjelke.org" />
                  </ActionPanel>
                }
              />
            );
          })()}
        {[...(s?.errors ?? []), ...(d?.errors ?? [])].slice(0, 2).map((e, i) => (
          <List.Item key={i} icon={{ source: Icon.Warning, tintColor: Color.Red }} title={e} />
        ))}
      </List.Section>

      <List.Section title="Commands">
        {COMMANDS.map((c) => (
          <List.Item
            key={c.name}
            icon={c.icon}
            title={c.title}
            subtitle={c.subtitle}
            actions={
              <ActionPanel>
                <Action.Push title={`Open ${c.title}`} icon={c.icon} target={c.view()} />
              </ActionPanel>
            }
          />
        ))}
      </List.Section>

      <List.Section title="Open in Browser">
        {LINKS.map((l) => (
          <List.Item
            key={l.title}
            icon={l.icon}
            title={l.title}
            accessories={[{ text: l.url.replace("https://", "") }]}
            actions={
              <ActionPanel>
                <Action.OpenInBrowser url={l.url} />
                <Action.CopyToClipboard title="Copy URL" content={l.url} />
              </ActionPanel>
            }
          />
        ))}
      </List.Section>
    </List>
  );
}
