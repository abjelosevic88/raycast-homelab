import { Action, ActionPanel, Color, Grid, Icon, showToast, Toast } from "@raycast/api";
import { useCachedPromise } from "@raycast/utils";
import { useState } from "react";
import {
  getProfiles,
  jellyseerrPrefs,
  requestMedia,
  searchMedia,
  SearchResult,
  ServiceProfiles,
  STATUS,
  trendingMedia,
} from "./jellyseerr-api";

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

function titleOf(r: SearchResult): string {
  return r.title ?? r.name ?? "Untitled";
}

function yearOf(r: SearchResult): string | undefined {
  return (r.releaseDate ?? r.firstAirDate)?.slice(0, 4);
}

export default function Request() {
  const [query, setQuery] = useState("");
  const { url, key } = jellyseerrPrefs();

  const searching = query.trim().length >= 2;
  const { data, isLoading, revalidate } = useCachedPromise(
    async (q: string, hasKey: boolean) => {
      if (!hasKey) return [];
      return q.trim().length < 2 ? await trendingMedia() : await searchMedia(q.trim());
    },
    [query, Boolean(key)],
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
    <Grid
      isLoading={isLoading}
      searchText={query}
      onSearchTextChange={setQuery}
      throttle
      columns={5}
      aspectRatio="2/3"
      fit={Grid.Fit.Fill}
      searchBarPlaceholder="Search movies & shows on Jellyseerr…"
    >
      {!key && (
        <Grid.EmptyView
          icon={{ source: Icon.Key, tintColor: Color.Orange }}
          title="Jellyseerr API key not set"
          description="⌘K → Configure Extension → paste the API key from Jellyseerr → Settings → General"
        />
      )}
      <Grid.Section title={searching ? "Search Results" : "Trending"}>
      {data?.map((r) => {
        const status = r.mediaInfo?.status ? STATUS[r.mediaInfo.status] : undefined;
        const requestable = !status || r.mediaInfo?.status === 1;
        const webUrl = `${url}/${r.mediaType}/${r.id}`;
        const subtitle = [yearOf(r), r.mediaType === "tv" ? "TV" : "Movie", status?.label]
          .filter(Boolean)
          .join(" · ");
        return (
          <Grid.Item
            key={`${r.mediaType}-${r.id}`}
            content={
              r.posterPath
                ? { source: `https://image.tmdb.org/t/p/w342${r.posterPath}` }
                : { source: r.mediaType === "tv" ? Icon.Monitor : Icon.FilmStrip, tintColor: Color.SecondaryText }
            }
            title={titleOf(r)}
            subtitle={subtitle}
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
      </Grid.Section>
    </Grid>
  );
}
