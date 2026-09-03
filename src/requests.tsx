import {
  Action,
  ActionPanel,
  Alert,
  Color,
  confirmAlert,
  Icon,
  List,
  showToast,
  Toast, Keyboard,
} from "@raycast/api";
import { useCachedPromise } from "@raycast/utils";
import { useState } from "react";
import {
  actOnRequest,
  deleteRequest,
  jellyseerrPrefs,
  listRequests,
  MediaRequestItem,
  REQUEST_STATUS,
  RequestFilter,
  STATUS,
} from "./jellyseerr-api";
import MediaDetail from "./media-detail";

const COLORS = { green: Color.Green, orange: Color.Orange, blue: Color.Blue, red: Color.Red, yellow: Color.Yellow };

const FILTERS: { id: RequestFilter; title: string }[] = [
  { id: "all", title: "All Requests" },
  { id: "pending", title: "Pending" },
  { id: "approved", title: "Approved" },
  { id: "processing", title: "Processing" },
  { id: "available", title: "Available" },
  { id: "failed", title: "Failed" },
];

export default function Requests() {
  const [filter, setFilter] = useState<RequestFilter>("all");
  const { url, key } = jellyseerrPrefs();

  const { data, isLoading, revalidate, pagination } = useCachedPromise(
    (f: RequestFilter, hasKey: boolean) =>
      async ({ page }: { page: number }) => {
        if (!hasKey) return { data: [] as MediaRequestItem[], hasMore: false };
        const res = await listRequests(f, page);
        return { data: res.results, hasMore: res.hasMore };
      },
    [filter, Boolean(key)],
    { keepPreviousData: true },
  );

  async function act(r: MediaRequestItem, action: "approve" | "decline" | "retry") {
    const toast = await showToast({ style: Toast.Style.Animated, title: `${action} ${r.title}…` });
    try {
      await actOnRequest(r.id, action);
      toast.style = Toast.Style.Success;
      toast.title = `${action}d: ${r.title}`;
      revalidate();
    } catch (e) {
      toast.style = Toast.Style.Failure;
      toast.title = `Failed to ${action}`;
      toast.message = String(e instanceof Error ? e.message : e);
    }
  }

  async function remove(r: MediaRequestItem) {
    const ok = await confirmAlert({
      title: `Delete request for "${r.title}"?`,
      message: "This removes the request from Jellyseerr. Files already downloaded are not touched.",
      primaryAction: { title: "Delete Request", style: Alert.ActionStyle.Destructive },
    });
    if (!ok) return;
    try {
      await deleteRequest(r.id);
      await showToast({ style: Toast.Style.Success, title: `Deleted request: ${r.title}` });
      revalidate();
    } catch (e) {
      await showToast({ style: Toast.Style.Failure, title: "Delete failed", message: String(e) });
    }
  }

  return (
    <List
      isLoading={isLoading}
      pagination={pagination}
      searchBarPlaceholder="Filter requests…"
      searchBarAccessory={
        <List.Dropdown tooltip="Status" value={filter} onChange={(v) => setFilter(v as RequestFilter)}>
          {FILTERS.map((f) => (
            <List.Dropdown.Item key={f.id} title={f.title} value={f.id} />
          ))}
        </List.Dropdown>
      }
    >
      {!key && (
        <List.EmptyView
          icon={{ source: Icon.Key, tintColor: Color.Orange }}
          title="Jellyseerr API key not set"
          description="⌘K → Configure Extension → paste the admin API key"
        />
      )}
      {data?.map((r) => {
        const reqStatus = REQUEST_STATUS[r.status];
        const mediaStatus = r.mediaStatus ? STATUS[r.mediaStatus] : undefined;
        const pending = r.status === 1;
        const failed = r.status === 4;
        const webUrl = `${url}/${r.mediaType}/${r.tmdbId}`;
        return (
          <List.Item
            key={r.id}
            icon={
              r.posterPath
                ? { source: `https://image.tmdb.org/t/p/w92${r.posterPath}` }
                : r.mediaType === "tv"
                  ? Icon.Monitor
                  : Icon.FilmStrip
            }
            title={r.title}
            subtitle={`${r.year ?? ""} · by ${r.requestedBy} · ${r.createdAt}`}
            accessories={[
              ...(r.seasons.length > 0 ? [{ tag: `S${r.seasons.join(", S")}` }] : []),
              ...(mediaStatus && !pending
                ? [{ tag: { value: mediaStatus.label, color: COLORS[mediaStatus.color] } }]
                : []),
              ...(reqStatus ? [{ tag: { value: reqStatus.label, color: COLORS[reqStatus.color] } }] : []),
            ]}
            actions={
              <ActionPanel>
                {pending && (
                  <Action
                    title="Approve"
                    icon={{ source: Icon.CheckCircle, tintColor: Color.Green }}
                    onAction={() => act(r, "approve")}
                  />
                )}
                {pending && (
                  <Action
                    title="Decline"
                    icon={{ source: Icon.XMarkCircle, tintColor: Color.Red }}
                    onAction={() => act(r, "decline")}
                  />
                )}
                {failed && <Action title="Retry" icon={Icon.ArrowClockwise} onAction={() => act(r, "retry")} />}
                <Action.Push
                  title="Show Details"
                  icon={Icon.Sidebar}
                  target={<MediaDetail mediaType={r.mediaType} id={r.tmdbId} onRequested={revalidate} />}
                />
                <Action.OpenInBrowser
                  title="Open in Jellyseerr"
                  url={webUrl}
                  shortcut={Keyboard.Shortcut.Common.Open}
                />
                <Action
                  title="Refresh"
                  icon={Icon.ArrowClockwise}
                  shortcut={Keyboard.Shortcut.Common.Refresh}
                  onAction={revalidate}
                />
                <Action
                  title="Delete Request"
                  icon={Icon.Trash}
                  style={Action.Style.Destructive}
                  shortcut={{ modifiers: ["ctrl"], key: "x" }}
                  onAction={() => remove(r)}
                />
              </ActionPanel>
            }
          />
        );
      })}
    </List>
  );
}
