import { Action, ActionPanel, Color, Icon, List, showToast, Toast } from "@raycast/api";
import { getProgressIcon, useCachedPromise } from "@raycast/utils";
import { useEffect } from "react";
import { DL_URLS, DownloadItem, fmtSpeed, loadDownloads, qbitToggle, sabToggle } from "./downloads-api";

const POLL_MS = 5000;

function stateColor(item: DownloadItem): Color {
  if (item.paused) return Color.SecondaryText;
  if (item.state.includes("stalled") || item.state.includes("queued")) return Color.Orange;
  return Color.Blue;
}

export default function Downloads() {
  const { data, isLoading, revalidate } = useCachedPromise(loadDownloads, [], { keepPreviousData: true });

  // live view: poll while the window is open
  useEffect(() => {
    const t = setInterval(revalidate, POLL_MS);
    return () => clearInterval(t);
  }, [revalidate]);

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
  const commonPanel = <ActionPanel>{common}</ActionPanel>;

  function activeItem(source: "qbit" | "sab", item: DownloadItem) {
    return (
      <List.Item
        key={item.id}
        icon={getProgressIcon(item.progress, stateColor(item))}
        title={item.name}
        subtitle={item.detail}
        accessories={[
          { text: `${Math.round(item.progress * 100)}%`, tooltip: "progress" },
          ...(item.speed ? [{ text: item.speed }] : []),
          ...(item.eta && !item.paused ? [{ text: item.eta, tooltip: "time left" }] : []),
          { tag: { value: item.paused ? "paused" : item.state, color: stateColor(item) } },
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

  return (
    <List isLoading={isLoading} searchBarPlaceholder="Filter downloads…">
      <List.Section title="Torrents — qBittorrent">
        {data?.qbitHint && (
          <List.Item
            icon={{ source: Icon.Key, tintColor: Color.Orange }}
            title={data.qbitHint}
            actions={commonPanel}
          />
        )}
        {data?.qbit && (
          <List.Item
            icon={{ source: Icon.LineChart, tintColor: Color.Blue }}
            title={`↓ ${fmtSpeed(data.qbit.dlSpeed)}   ↑ ${fmtSpeed(data.qbit.upSpeed)}`}
            subtitle={`${data.qbit.downloading.length} downloading · ${data.qbit.seedCount} seeding`}
            accessories={[{ tag: { value: "live", color: Color.Green }, tooltip: "refreshes every 5s" }]}
            actions={commonPanel}
          />
        )}
        {data?.qbit?.downloading.map((i) => activeItem("qbit", i))}
        {data?.qbit?.seeding.map((s) => (
          <List.Item
            key={s.id}
            icon={{ source: Icon.ArrowUpCircle, tintColor: s.upSpeed > 0 ? Color.Green : Color.SecondaryText }}
            title={s.name}
            subtitle="seeding"
            accessories={[
              s.upSpeed > 0
                ? { text: `↑ ${fmtSpeed(s.upSpeed)}` }
                : { tag: { value: "idle", color: Color.SecondaryText }, tooltip: "seeding, but no one is downloading right now" },
              { tag: `ratio ${s.ratio.toFixed(1)}` },
            ]}
            actions={commonPanel}
          />
        ))}
        {data?.qbit && data.qbit.seedCount > data.qbit.seeding.length && (
          <List.Item
            icon={Icon.Ellipsis}
            title={`…and ${data.qbit.seedCount - data.qbit.seeding.length} more idle seeds`}
            actions={commonPanel}
          />
        )}
      </List.Section>

      <List.Section title="Usenet — SABnzbd">
        {data?.sab && (
          <List.Item
            icon={{ source: Icon.LineChart, tintColor: Color.Purple }}
            title={data.sab.paused ? "PAUSED" : `↓ ${fmtSpeed(data.sab.speedBps)}`}
            subtitle={
              data.sab.items.length > 0
                ? `${data.sab.items.length} queued · ${data.sab.timeLeft} left`
                : "queue empty"
            }
            accessories={[{ tag: { value: "live", color: Color.Green }, tooltip: "refreshes every 5s" }]}
            actions={commonPanel}
          />
        )}
        {data?.sab?.items.map((i) => activeItem("sab", i))}
      </List.Section>

      {data && data.errors.length > 0 && (
        <List.Section title="Errors">
          {data.errors.map((e, i) => (
            <List.Item
              key={i}
              icon={{ source: Icon.Warning, tintColor: Color.Red }}
              title={e}
              actions={commonPanel}
            />
          ))}
        </List.Section>
      )}
    </List>
  );
}
