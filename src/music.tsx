import {
  Action,
  ActionPanel,
  Color,
  Grid,
  Icon,
  List,
  showToast,
  Toast,
  Keyboard,
} from "@raycast/api";
import { useCachedPromise } from "@raycast/utils";
import { fetchError } from "./fetch-error";
import { useState } from "react";
import {
  Album,
  ALBUM_SORTS,
  AlbumSort,
  albumWebUrl,
  coverUrl,
  fmtDuration,
  getAlbumSongs,
  hasNavidromeCreds,
  listAlbums,
  NAVIDROME_URL,
  searchAlbums,
} from "./navidrome-api";

function AlbumDetail(props: { album: Album }) {
  const { data, isLoading } = useCachedPromise(
    getAlbumSongs,
    [props.album.id],
    {
      onError: fetchError("Navidrome"),
    },
  );
  const a = data?.album ?? props.album;
  return (
    <List
      isLoading={isLoading}
      navigationTitle={`${a.name} — ${a.artist}`}
      searchBarPlaceholder="Filter tracks…"
    >
      <List.Section
        title={a.name}
        subtitle={`${a.songCount} songs · ${fmtDuration(a.duration)}`}
      >
        {data?.songs.map((s) => (
          <List.Item
            key={s.id}
            icon={
              a.coverArt ? { source: coverUrl(a.coverArt, 64) } : Icon.Music
            }
            title={`${s.track ?? "–"}. ${s.title}`}
            subtitle={s.artist !== a.artist ? s.artist : undefined}
            accessories={[
              ...(s.suffix
                ? [{ tag: `${s.suffix}${s.bitRate ? ` ${s.bitRate}k` : ""}` }]
                : []),
              { text: fmtDuration(s.duration) },
            ]}
            actions={
              <ActionPanel>
                <Action.OpenInBrowser
                  title="Open Album in Navidrome"
                  url={albumWebUrl(a.id)}
                />
                <Action.CopyToClipboard
                  title="Copy Track Title"
                  content={s.title}
                />
              </ActionPanel>
            }
          />
        ))}
      </List.Section>
    </List>
  );
}

export default function Music() {
  const [query, setQuery] = useState("");
  const [sort, setSort] = useState<AlbumSort>("newest");
  const hasCreds = hasNavidromeCreds();

  const searching = query.trim().length >= 2;
  const { data, isLoading, pagination } = useCachedPromise(
    (q: string, s: AlbumSort, ok: boolean) =>
      async ({ page }: { page: number }) => {
        if (!ok) return { data: [] as Album[], hasMore: false };
        if (q.trim().length >= 2) {
          return {
            data: page === 0 ? await searchAlbums(q.trim()) : [],
            hasMore: false,
          };
        }
        const r = await listAlbums(s, page);
        return { data: r.albums, hasMore: r.hasMore };
      },
    [query, sort, hasCreds],
    {
      keepPreviousData: true,
      onError: (e) => {
        void showToast({
          style: Toast.Style.Failure,
          title: "Navidrome",
          message: e.message,
        });
      },
    },
  );

  const seen = new Set<string>();
  const albums = (data ?? []).filter(
    (a) => !seen.has(a.id) && (seen.add(a.id) || true),
  );

  return (
    <Grid
      isLoading={isLoading}
      pagination={pagination}
      searchText={query}
      onSearchTextChange={setQuery}
      throttle
      columns={5}
      aspectRatio="1"
      fit={Grid.Fit.Fill}
      searchBarPlaceholder="Search albums…"
      searchBarAccessory={
        <Grid.Dropdown
          tooltip="Sort"
          value={sort}
          onChange={(v) => setSort(v as AlbumSort)}
        >
          {ALBUM_SORTS.map((s) => (
            <Grid.Dropdown.Item key={s.id} title={s.title} value={s.id} />
          ))}
        </Grid.Dropdown>
      }
    >
      {!hasCreds && (
        <Grid.EmptyView
          icon={{ source: Icon.Key, tintColor: Color.Orange }}
          title="Navidrome login not set"
          description="⌘K → Configure Extension → set the Navidrome URL, username and password"
        />
      )}
      <Grid.Section
        title={
          searching
            ? "Search Results"
            : ALBUM_SORTS.find((s) => s.id === sort)?.title
        }
      >
        {albums.map((a) => (
          <Grid.Item
            key={a.id}
            content={
              a.coverArt
                ? { source: coverUrl(a.coverArt, 300) }
                : { source: Icon.Music, tintColor: Color.SecondaryText }
            }
            title={a.name}
            subtitle={`${a.artist}${a.year ? ` · ${a.year}` : ""}`}
            actions={
              <ActionPanel>
                <Action.Push
                  title="Show Tracks"
                  icon={Icon.List}
                  target={<AlbumDetail album={a} />}
                />
                <Action.OpenInBrowser
                  title="Open in Navidrome"
                  url={albumWebUrl(a.id)}
                />
                <Action.OpenInBrowser
                  title="Open Navidrome"
                  url={NAVIDROME_URL}
                  shortcut={Keyboard.Shortcut.Common.Open}
                />
                <Action.CopyToClipboard
                  title="Copy Artist – Album"
                  content={`${a.artist} - ${a.name}`}
                  shortcut={{ modifiers: ["cmd"], key: "c" }}
                />
              </ActionPanel>
            }
          />
        ))}
      </Grid.Section>
    </Grid>
  );
}
