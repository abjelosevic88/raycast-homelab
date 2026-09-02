import { Action, ActionPanel, Color, Icon, List, showToast, Toast } from "@raycast/api";
import { useCachedPromise } from "@raycast/utils";
import { useState } from "react";
import { jellyseerrPrefs, requestMedia, searchMedia, SearchResult, STATUS } from "./jellyseerr-api";

const TAG_COLORS = { green: Color.Green, orange: Color.Orange, blue: Color.Blue, yellow: Color.Yellow } as const;

function titleOf(r: SearchResult): string {
  return r.title ?? r.name ?? "Untitled";
}

function yearOf(r: SearchResult): string | undefined {
  return (r.releaseDate ?? r.firstAirDate)?.slice(0, 4);
}

export default function Request() {
  const [query, setQuery] = useState("");
  const { url, key } = jellyseerrPrefs();

  const { data, isLoading, revalidate } = useCachedPromise(
    async (q: string) => (q.trim().length < 2 ? [] : await searchMedia(q.trim())),
    [query],
    { keepPreviousData: true },
  );

  async function request(r: SearchResult) {
    const toast = await showToast({ style: Toast.Style.Animated, title: `Requesting ${titleOf(r)}…` });
    try {
      await requestMedia(r);
      toast.style = Toast.Style.Success;
      toast.title = `Requested ${titleOf(r)}`;
      toast.message = r.mediaType === "tv" ? "all seasons" : undefined;
      revalidate();
    } catch (e) {
      toast.style = Toast.Style.Failure;
      toast.title = `Request failed`;
      toast.message = String(e instanceof Error ? e.message : e);
    }
  }

  return (
    <List
      isLoading={isLoading}
      searchText={query}
      onSearchTextChange={setQuery}
      throttle
      searchBarPlaceholder="Search movies & shows on Jellyseerr…"
    >
      {!key && (
        <List.EmptyView
          icon={{ source: Icon.Key, tintColor: Color.Orange }}
          title="Jellyseerr API key not set"
          description="⌘K → Configure Extension → paste the API key from Jellyseerr → Settings → General"
        />
      )}
      {key && query.trim().length < 2 && (
        <List.EmptyView icon={Icon.MagnifyingGlass} title="Type to search" description="Movies and TV shows" />
      )}
      {data?.map((r) => {
        const status = r.mediaInfo?.status ? STATUS[r.mediaInfo.status] : undefined;
        const requestable = !status || r.mediaInfo?.status === 1;
        const webUrl = `${url}/${r.mediaType}/${r.id}`;
        return (
          <List.Item
            key={`${r.mediaType}-${r.id}`}
            icon={
              r.posterPath
                ? { source: `https://image.tmdb.org/t/p/w92${r.posterPath}` }
                : r.mediaType === "tv"
                  ? Icon.Monitor
                  : Icon.FilmStrip
            }
            title={titleOf(r)}
            subtitle={yearOf(r)}
            accessories={[
              { tag: { value: r.mediaType === "tv" ? "TV" : "Movie", color: r.mediaType === "tv" ? Color.Purple : Color.Blue } },
              ...(status ? [{ tag: { value: status.label, color: TAG_COLORS[status.color] } }] : []),
            ]}
            actions={
              <ActionPanel>
                {requestable ? (
                  <Action
                    title={r.mediaType === "tv" ? "Request All Seasons" : "Request"}
                    icon={Icon.Download}
                    onAction={() => request(r)}
                  />
                ) : (
                  <Action.OpenInBrowser title={`Open in Jellyseerr (${status?.label})`} url={webUrl} />
                )}
                <Action.OpenInBrowser title="Open in Jellyseerr" url={webUrl} />
                <Action.CopyToClipboard
                  title="Copy Title"
                  content={titleOf(r)}
                  shortcut={{ modifiers: ["cmd"], key: "c" }}
                />
              </ActionPanel>
            }
          />
        );
      })}
    </List>
  );
}
