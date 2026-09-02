import { Action, ActionPanel, Color, Icon, List, showToast, Toast } from "@raycast/api";
import { useCachedPromise } from "@raycast/utils";
import { useState } from "react";
import { getProfiles, jellyseerrPrefs, requestMedia, searchMedia, SearchResult, ServiceProfiles, STATUS } from "./jellyseerr-api";

function ProfileSubmenu(props: { result: SearchResult; onPick: (profileId: number) => void }) {
  const [profiles, setProfiles] = useState<ServiceProfiles | null>(null);
  return (
    <ActionPanel.Submenu
      title="Request with Profile…"
      icon={Icon.Gear}
      shortcut={{ modifiers: ["cmd"], key: "p" }}
      isLoading={profiles === null}
      onOpen={() => {
        getProfiles(props.result.mediaType as "movie" | "tv")
          .then(setProfiles)
          .catch(async (e) => {
            await showToast({ style: Toast.Style.Failure, title: "Couldn't load profiles", message: String(e) });
          });
      }}
    >
      {profiles?.profiles.map((p) => (
        <Action
          key={p.id}
          title={p.id === profiles.activeProfileId ? `${p.name} (default)` : p.name}
          icon={p.id === profiles.activeProfileId ? Icon.Star : Icon.Circle}
          onAction={() => props.onPick(p.id)}
        />
      ))}
    </ActionPanel.Submenu>
  );
}

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

  async function request(r: SearchResult, profileId?: number) {
    const toast = await showToast({ style: Toast.Style.Animated, title: `Requesting ${titleOf(r)}…` });
    try {
      await requestMedia(r, profileId);
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
                  <>
                    <Action
                      title={r.mediaType === "tv" ? "Request All Seasons" : "Request"}
                      icon={Icon.Download}
                      onAction={() => request(r)}
                    />
                    <ProfileSubmenu result={r} onPick={(profileId) => request(r, profileId)} />
                  </>
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
