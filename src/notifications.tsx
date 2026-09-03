import { Action, ActionPanel, Color, Icon, List, Keyboard } from "@raycast/api";
import { useCachedPromise } from "@raycast/utils";
import { useEffect, useState } from "react";
import { loadNotifications, Notification, NTFY_URL, ntfyPrefs, timeAgo } from "./notifications-api";

const POLL_MS = 30000;

const KIND_META: Record<Notification["kind"], { icon: Icon; color: Color }> = {
  success: { icon: Icon.CheckCircle, color: Color.Green },
  failure: { icon: Icon.Warning, color: Color.Red },
  info: { icon: Icon.Bell, color: Color.SecondaryText },
};

export default function Notifications() {
  const [topic, setTopic] = useState("all");
  const { topics } = ntfyPrefs();
  const { data, isLoading, revalidate } = useCachedPromise(loadNotifications, [], { keepPreviousData: true });

  useEffect(() => {
    const t = setInterval(revalidate, POLL_MS);
    return () => clearInterval(t);
  }, [revalidate]);

  const shown = (data ?? []).filter((n) => topic === "all" || n.topic === topic);

  return (
    <List
      isLoading={isLoading}
      isShowingDetail
      searchBarPlaceholder={`Filter ${shown.length} notifications…`}
      searchBarAccessory={
        <List.Dropdown tooltip="Topic" value={topic} onChange={setTopic}>
          <List.Dropdown.Item title="All Topics" value="all" />
          {topics.map((t) => (
            <List.Dropdown.Item key={t} title={t} value={t} />
          ))}
        </List.Dropdown>
      }
    >
      {shown.map((n) => {
        const meta = KIND_META[n.kind];
        return (
          <List.Item
            key={n.id}
            icon={{ source: meta.icon, tintColor: meta.color }}
            title={n.title}
            accessories={[{ text: timeAgo(n.time) }]}
            detail={
              <List.Item.Detail
                markdown={`### ${n.title}\n\n${n.message || "*no body*"}`}
                metadata={
                  <List.Item.Detail.Metadata>
                    <List.Item.Detail.Metadata.TagList title="Topic">
                      <List.Item.Detail.Metadata.TagList.Item
                        text={n.topic}
                        color={n.topic === "downloads" ? Color.Blue : Color.Orange}
                      />
                    </List.Item.Detail.Metadata.TagList>
                    <List.Item.Detail.Metadata.Label
                      title="Received"
                      text={`${new Date(n.time * 1000).toLocaleString()} (${timeAgo(n.time)})`}
                    />
                    {n.priority !== undefined && n.priority !== 3 && (
                      <List.Item.Detail.Metadata.Label title="Priority" text={String(n.priority)} />
                    )}
                  </List.Item.Detail.Metadata>
                }
              />
            }
            actions={
              <ActionPanel>
                <Action.CopyToClipboard title="Copy Message" content={`${n.title}\n\n${n.message}`} />
                <Action.OpenInBrowser title="Open Ntfy" url={NTFY_URL} />
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
      {!isLoading && shown.length === 0 && (
        <List.EmptyView icon={Icon.BellDisabled} title="No notifications" description="Quiet week on the homelab" />
      )}
    </List>
  );
}
