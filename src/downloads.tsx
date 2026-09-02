import { Action, ActionPanel, Color, Icon, List, showToast, Toast } from "@raycast/api";
import { getProgressIcon, useCachedPromise } from "@raycast/utils";
import { DL_URLS, DownloadItem, fmtSpeed, loadDownloads, qbitToggle, RecentItem, sabToggle } from "./downloads-api";

function stateColor(item: DownloadItem): Color {
  if (item.paused) return Color.SecondaryText;
  if (item.state.includes("stalled") || item.state.includes("queued")) return Color.Orange;
  return Color.Blue;
}

export default function Downloads() {
  const { data, isLoading, revalidate } = useCachedPromise(loadDownloads, [], { keepPreviousData: true });

  async function toggle(source: "qbit" | "sab", item: DownloadItem) {
    const action = source === "qbit" ? (item.paused ? "start" : "stop") : item.paused ? "resume" : "pause";
    try {
      if (source === "qbit") await qbitToggle(item.id, action as "start" | "stop");
      else await sabToggle(item.id, action as "pause" | "resume");
      await showToast({ style: Toast.Style.Success, title: `${action} → ${item.name.slice(0, 40)}` });
      revalidate();
    } catch (e) {
      await showToast({ style: Toast.Style.Failure, title: `Failed to ${action}`, message: String(e) });
    }
  }

  const common = (
    <>
      <Action
        title="Refresh"
        icon={Icon.ArrowClockwise}
        shortcut={{ modifiers: ["cmd"], key: "r" }}
        onAction={revalidate}
      />
      <Action.OpenInBrowser title="Open Qbittorrent" url={DL_URLS.qbit} shortcut={{ modifiers: ["cmd"], key: "q" }} />
      <Action.OpenInBrowser title="Open Sabnzbd" url={DL_URLS.sab} shortcut={{ modifiers: ["cmd"], key: "s" }} />
    </>
  );

  function activeItem(source: "qbit" | "sab", item: DownloadItem) {
    return (
      <List.Item
        key={item.id}
        icon={getProgressIcon(item.progress, stateColor(item))}
        title={item.name}
        accessories={[
          ...(item.speed ? [{ text: item.speed }] : []),
          ...(item.eta && !item.paused ? [{ text: item.eta, tooltip: "ETA" }] : []),
          { tag: { value: item.paused ? "paused" : item.state, color: stateColor(item) }, tooltip: item.detail },
        ]}
        actions={
          <ActionPanel>
            <Action
              title={item.paused ? "Resume" : "Pause"}
              icon={item.paused ? Icon.Play : Icon.Pause}
              onAction={() => toggle(source, item)}
            />
            {common}
          </ActionPanel>
        }
      />
    );
  }

  function recentItem(r: RecentItem) {
    return (
      <List.Item
        key={r.id}
        icon={r.ok ? { source: Icon.CheckCircle, tintColor: Color.Green } : { source: Icon.XMarkCircle, tintColor: Color.Red }}
        title={r.name}
        accessories={[{ text: r.detail }]}
        actions={<ActionPanel>{common}</ActionPanel>}
      />
    );
  }

  const qbitTitle = data?.qbit
    ? `qBittorrent — ↓ ${fmtSpeed(data.qbit.dlSpeed)} · ↑ ${fmtSpeed(data.qbit.upSpeed)}`
    : "qBittorrent";
  const sabTitle = data?.sab
    ? `SABnzbd — ${data.sab.paused ? "PAUSED" : `↓ ${fmtSpeed(data.sab.speedBps)}`}`
    : "SABnzbd";

  return (
    <List isLoading={isLoading} searchBarPlaceholder="Filter downloads…">
      <List.Section title={qbitTitle} subtitle={data?.qbit ? `${data.qbit.items.length} active` : undefined}>
        {data?.qbit?.items.map((i) => activeItem("qbit", i))}
      </List.Section>
      <List.Section title={sabTitle} subtitle={data?.sab ? `${data.sab.items.length} queued` : undefined}>
        {data?.sab?.items.map((i) => activeItem("sab", i))}
      </List.Section>
      <List.Section title="Recently Finished — qBittorrent">
        {data?.qbit?.recent.map(recentItem)}
      </List.Section>
      <List.Section title="Recently Finished — SABnzbd">
        {data?.sab?.recent.map(recentItem)}
      </List.Section>
      {data && data.errors.length > 0 && (
        <List.Section title="Errors">
          {data.errors.map((e, i) => (
            <List.Item
              key={i}
              icon={{ source: Icon.Warning, tintColor: Color.Red }}
              title={e}
              actions={<ActionPanel>{common}</ActionPanel>}
            />
          ))}
        </List.Section>
      )}
    </List>
  );
}
