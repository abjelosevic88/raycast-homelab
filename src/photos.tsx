import {
  Action,
  ActionPanel,
  Color,
  Detail,
  Grid,
  Icon,
  showToast,
  Toast,
} from "@raycast/api";
import { useCachedPromise } from "@raycast/utils";
import { useState } from "react";
import {
  albumAssets,
  albumWebUrl,
  hasImmichKey,
  ImmichAlbum,
  listAlbums,
  listPhotos,
  Memory,
  Photo,
  PHOTO_MODES,
  PhotoMode,
  photoWebUrl,
  setFavorite,
  smartSearch,
  thumbUrl,
} from "./immich-api";

function PhotoPreview(props: { photo: Photo }) {
  const p = props.photo;
  return (
    <Detail
      navigationTitle={p.originalFileName}
      markdown={`![${p.originalFileName}](${thumbUrl(p.id, "preview")})${
        p.type === "VIDEO"
          ? "\n\n*Video — press Enter to play it in Immich*"
          : ""
      }`}
      metadata={
        <Detail.Metadata>
          <Detail.Metadata.Label title="File" text={p.originalFileName} />
          <Detail.Metadata.Label
            title="Taken"
            text={p.fileCreatedAt?.slice(0, 19).replace("T", " ") ?? "—"}
          />
          <Detail.Metadata.Label
            title="Type"
            text={p.type === "VIDEO" ? "Video" : "Photo"}
          />
          {p.isFavorite && (
            <Detail.Metadata.TagList title="Favorite">
              <Detail.Metadata.TagList.Item text="♥" color={Color.Red} />
            </Detail.Metadata.TagList>
          )}
        </Detail.Metadata>
      }
      actions={
        <ActionPanel>
          <Action.OpenInBrowser
            title="Open in Immich"
            url={photoWebUrl(p.id)}
          />
          <Action.CopyToClipboard
            title="Copy File Name"
            content={p.originalFileName}
          />
        </ActionPanel>
      }
    />
  );
}

function PhotoItem(props: { photo: Photo; onChanged?: () => void }) {
  const p = props.photo;
  const date = p.fileCreatedAt?.slice(0, 10) ?? "";

  async function toggleFav() {
    try {
      await setFavorite(p.id, !p.isFavorite);
      await showToast({
        style: Toast.Style.Success,
        title: p.isFavorite ? "Removed from favorites" : "Added to favorites",
      });
      props.onChanged?.();
    } catch (e) {
      await showToast({
        style: Toast.Style.Failure,
        title: "Failed",
        message: String(e),
      });
    }
  }

  return (
    <Grid.Item
      content={{ source: thumbUrl(p.id) }}
      title={`${p.isFavorite ? "♥ " : ""}${p.type === "VIDEO" ? "▶ " : ""}${date}`}
      subtitle={p.originalFileName}
      actions={
        <ActionPanel>
          <Action.Push
            title="Quick Look"
            icon={Icon.Eye}
            target={<PhotoPreview photo={p} />}
          />
          <Action.OpenInBrowser
            title="Open in Immich"
            url={photoWebUrl(p.id)}
            shortcut={{ modifiers: ["shift"], key: "return" }}
          />
          <Action
            title={p.isFavorite ? "Remove Favorite" : "Add to Favorites"}
            icon={p.isFavorite ? Icon.HeartDisabled : Icon.Heart}
            shortcut={{ modifiers: ["cmd"], key: "f" }}
            onAction={toggleFav}
          />
          <Action.CopyToClipboard
            title="Copy File Name"
            content={p.originalFileName}
            shortcut={{ modifiers: ["cmd"], key: "c" }}
          />
        </ActionPanel>
      }
    />
  );
}

export function MemoryGrid(props: { memories: Memory[] }) {
  const thisYear = new Date().getFullYear();
  return (
    <Grid
      navigationTitle="On This Day"
      columns={4}
      aspectRatio="1"
      fit={Grid.Fit.Fill}
      searchBarPlaceholder="Filter…"
    >
      {props.memories.map((m) => (
        <Grid.Section
          key={m.id}
          title={`${m.year} — ${thisYear - m.year} year${thisYear - m.year === 1 ? "" : "s"} ago`}
        >
          {m.assets.map((p) => (
            <PhotoItem key={p.id} photo={p} />
          ))}
        </Grid.Section>
      ))}
    </Grid>
  );
}

function AlbumGrid(props: { album: ImmichAlbum }) {
  const { data, isLoading, revalidate } = useCachedPromise(albumAssets, [
    props.album.id,
  ]);
  return (
    <Grid
      isLoading={isLoading}
      navigationTitle={props.album.albumName}
      columns={4}
      aspectRatio="1"
      fit={Grid.Fit.Fill}
      searchBarPlaceholder={`Filter ${props.album.assetCount} photos…`}
    >
      {data?.map((p) => (
        <PhotoItem key={p.id} photo={p} onChanged={revalidate} />
      ))}
    </Grid>
  );
}

export default function Photos() {
  const [query, setQuery] = useState("");
  const [mode, setMode] = useState<PhotoMode>("recent");
  const hasKey = hasImmichKey();
  const searching = query.trim().length >= 2;

  const photosResult = useCachedPromise(
    (q: string, m: PhotoMode, ok: boolean) =>
      async ({ page }: { page: number }) => {
        if (!ok || m === "albums")
          return { data: [] as Photo[], hasMore: false };
        const r =
          q.trim().length >= 2
            ? await smartSearch(q.trim(), page)
            : await listPhotos(m, page);
        return { data: r.photos, hasMore: r.hasMore };
      },
    [query, mode, hasKey],
    {
      keepPreviousData: true,
      onError: (e) => {
        void showToast({
          style: Toast.Style.Failure,
          title: "Immich",
          message: e.message,
        });
      },
    },
  );
  const albumsResult = useCachedPromise(
    async (m: PhotoMode, ok: boolean) =>
      ok && m === "albums" ? await listAlbums() : [],
    [mode, hasKey],
  );

  const seen = new Set<string>();
  const photos = (photosResult.data ?? []).filter(
    (p) => !seen.has(p.id) && (seen.add(p.id) || true),
  );
  const showAlbums = mode === "albums" && !searching;

  return (
    <Grid
      isLoading={photosResult.isLoading || albumsResult.isLoading}
      pagination={showAlbums ? undefined : photosResult.pagination}
      searchText={query}
      onSearchTextChange={setQuery}
      throttle
      columns={4}
      aspectRatio="1"
      fit={Grid.Fit.Fill}
      searchBarPlaceholder="Smart search — e.g. sunset at the beach…"
      searchBarAccessory={
        <Grid.Dropdown
          tooltip="View"
          value={mode}
          onChange={(v) => setMode(v as PhotoMode)}
        >
          {PHOTO_MODES.map((m) => (
            <Grid.Dropdown.Item key={m.id} title={m.title} value={m.id} />
          ))}
        </Grid.Dropdown>
      }
    >
      {!hasKey && (
        <Grid.EmptyView
          icon={{ source: Icon.Key, tintColor: Color.Orange }}
          title="Immich API key not set"
          description="⌘K → Configure Extension → set the Immich URL and an API key (Account Settings → API Keys)"
        />
      )}
      {showAlbums ? (
        <Grid.Section title={`Albums (${albumsResult.data?.length ?? 0})`}>
          {albumsResult.data?.map((a) => (
            <Grid.Item
              key={a.id}
              content={
                a.albumThumbnailAssetId
                  ? { source: thumbUrl(a.albumThumbnailAssetId) }
                  : { source: Icon.Folder, tintColor: Color.SecondaryText }
              }
              title={a.albumName}
              subtitle={`${a.assetCount} items`}
              actions={
                <ActionPanel>
                  <Action.Push
                    title="Open Album"
                    icon={Icon.Folder}
                    target={<AlbumGrid album={a} />}
                  />
                  <Action.OpenInBrowser
                    title="Open in Immich"
                    url={albumWebUrl(a.id)}
                  />
                </ActionPanel>
              }
            />
          ))}
        </Grid.Section>
      ) : (
        <Grid.Section
          title={
            searching
              ? "Smart Search"
              : PHOTO_MODES.find((m) => m.id === mode)?.title
          }
        >
          {photos.map((p) => (
            <PhotoItem
              key={p.id}
              photo={p}
              onChanged={photosResult.revalidate}
            />
          ))}
        </Grid.Section>
      )}
    </Grid>
  );
}
