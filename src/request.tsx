import { Action, ActionPanel, Color, Grid, Icon } from "@raycast/api";
import { useCachedPromise } from "@raycast/utils";
import { useState } from "react";
import {
  DISCOVER_CATEGORIES,
  DiscoverCategory,
  discoverMedia,
  jellyseerrPrefs,
  searchMedia,
  SearchResult,
  STATUS,
} from "./jellyseerr-api";
import { doRequest, ProfileSubmenu } from "./media-actions";
import MediaDetail from "./media-detail";

function titleOf(r: SearchResult): string {
  return r.title ?? r.name ?? "Untitled";
}

function yearOf(r: SearchResult): string | undefined {
  return (r.releaseDate ?? r.firstAirDate)?.slice(0, 4);
}

export default function Request() {
  const [query, setQuery] = useState("");
  const [category, setCategory] = useState<DiscoverCategory>("trending");
  const { url, key } = jellyseerrPrefs();

  const searching = query.trim().length >= 2;
  const { data, isLoading, revalidate } = useCachedPromise(
    async (q: string, cat: DiscoverCategory, hasKey: boolean) => {
      if (!hasKey) return [];
      return q.trim().length < 2 ? await discoverMedia(cat) : await searchMedia(q.trim());
    },
    [query, category, Boolean(key)],
    { keepPreviousData: true },
  );

  const categoryTitle = DISCOVER_CATEGORIES.find((c) => c.id === category)?.title ?? "Discover";

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
      searchBarAccessory={
        <Grid.Dropdown tooltip="Discover" value={category} onChange={(v) => setCategory(v as DiscoverCategory)}>
          {DISCOVER_CATEGORIES.map((c) => (
            <Grid.Dropdown.Item key={c.id} title={c.title} value={c.id} />
          ))}
        </Grid.Dropdown>
      }
    >
      {!key && (
        <Grid.EmptyView
          icon={{ source: Icon.Key, tintColor: Color.Orange }}
          title="Jellyseerr API key not set"
          description="⌘K → Configure Extension → paste the admin API key"
        />
      )}
      <Grid.Section title={searching ? "Search Results" : categoryTitle}>
        {data?.map((r) => {
          const status = r.mediaInfo?.status ? STATUS[r.mediaInfo.status] : undefined;
          const requestable = !status || r.mediaInfo?.status === 1;
          const webUrl = `${url}/${r.mediaType}/${r.id}`;
          const target = { mediaType: r.mediaType as "movie" | "tv", id: r.id, title: titleOf(r) };
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
                  <Action.Push
                    title="Show Details"
                    icon={Icon.Sidebar}
                    target={<MediaDetail mediaType={target.mediaType} id={r.id} onRequested={revalidate} />}
                  />
                  {requestable && (
                    <Action
                      title={r.mediaType === "tv" ? "Request All Seasons" : "Request"}
                      icon={Icon.Download}
                      onAction={() => doRequest(target, { onDone: revalidate })}
                    />
                  )}
                  {requestable && <ProfileSubmenu target={target} onDone={revalidate} />}
                  <Action.OpenInBrowser
                    title="Open in Jellyseerr"
                    url={webUrl}
                    shortcut={{ modifiers: ["cmd"], key: "o" }}
                  />
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
