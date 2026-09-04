import {
  Action,
  ActionPanel,
  Color,
  Grid,
  Icon,
  showToast,
  Toast,
  Keyboard,
} from "@raycast/api";
import { useCachedPromise } from "@raycast/utils";
import { useState } from "react";
import {
  ABS_URL,
  AbsItem,
  absCoverUrl,
  absItemWebUrl,
  continueListening,
  hasAbsToken,
  listItems,
  listLibraries,
  searchLibrary,
} from "./abs-api";

function ItemTile(props: { item: AbsItem }) {
  const i = props.item;
  const pct =
    i.progress !== undefined ? ` · ${Math.round(i.progress * 100)}%` : "";
  return (
    <Grid.Item
      content={{ source: absCoverUrl(i.id) }}
      title={i.title}
      subtitle={`${i.author}${pct}`}
      actions={
        <ActionPanel>
          <Action.OpenInBrowser
            title="Open in Audiobookshelf"
            url={absItemWebUrl(i.id)}
          />
          <Action.OpenInBrowser
            title="Open Audiobookshelf"
            url={ABS_URL}
            shortcut={Keyboard.Shortcut.Common.Open}
          />
          <Action.CopyToClipboard
            title="Copy Title"
            content={`${i.author} - ${i.title}`}
            shortcut={{ modifiers: ["cmd"], key: "c" }}
          />
        </ActionPanel>
      }
    />
  );
}

export default function Audiobooks() {
  const [query, setQuery] = useState("");
  const [libraryId, setLibraryId] = useState("");
  const hasToken = hasAbsToken();
  const searching = query.trim().length >= 2;

  const libraries = useCachedPromise(
    async (ok: boolean) => (ok ? await listLibraries() : []),
    [hasToken],
  );
  const activeLibrary = libraryId || libraries.data?.[0]?.id || "";

  const inProgress = useCachedPromise(
    async (ok: boolean) => (ok ? await continueListening() : []),
    [hasToken],
  );

  const itemsResult = useCachedPromise(
    (lib: string, q: string, ok: boolean) =>
      async ({ page }: { page: number }) => {
        if (!ok || !lib) return { data: [] as AbsItem[], hasMore: false };
        if (q.trim().length >= 2)
          return {
            data: page === 0 ? await searchLibrary(lib, q.trim()) : [],
            hasMore: false,
          };
        const r = await listItems(lib, page);
        return { data: r.items, hasMore: r.hasMore };
      },
    [activeLibrary, query, hasToken],
    {
      keepPreviousData: true,
      onError: (e) => {
        void showToast({
          style: Toast.Style.Failure,
          title: "Audiobookshelf",
          message: e.message,
        });
      },
    },
  );

  const seen = new Set<string>();
  const items = (itemsResult.data ?? []).filter(
    (i) => !seen.has(i.id) && (seen.add(i.id) || true),
  );

  return (
    <Grid
      isLoading={
        libraries.isLoading || itemsResult.isLoading || inProgress.isLoading
      }
      pagination={itemsResult.pagination}
      searchText={query}
      onSearchTextChange={setQuery}
      throttle
      columns={5}
      aspectRatio="1"
      fit={Grid.Fit.Fill}
      searchBarPlaceholder="Search the library…"
      searchBarAccessory={
        <Grid.Dropdown
          tooltip="Library"
          value={activeLibrary}
          onChange={setLibraryId}
        >
          {libraries.data?.map((l) => (
            <Grid.Dropdown.Item key={l.id} title={l.name} value={l.id} />
          ))}
        </Grid.Dropdown>
      }
    >
      {!hasToken && (
        <Grid.EmptyView
          icon={{ source: Icon.Key, tintColor: Color.Orange }}
          title="Audiobookshelf token not set"
          description="⌘K → Configure Extension → set the Audiobookshelf URL and API token (Settings → Users → your user)"
        />
      )}
      {!searching && (inProgress.data?.length ?? 0) > 0 && (
        <Grid.Section title="Continue Listening">
          {inProgress.data?.map((i) => (
            <ItemTile key={`cl-${i.id}`} item={i} />
          ))}
        </Grid.Section>
      )}
      <Grid.Section title={searching ? "Search Results" : "Recently Added"}>
        {items.map((i) => (
          <ItemTile key={i.id} item={i} />
        ))}
      </Grid.Section>
    </Grid>
  );
}
