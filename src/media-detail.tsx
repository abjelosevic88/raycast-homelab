import { Action, ActionPanel, Color, Detail, Icon } from "@raycast/api";
import { useCachedPromise } from "@raycast/utils";
import { getDetails, jellyseerrPrefs, STATUS } from "./jellyseerr-api";
import { doRequest, ProfileSubmenu, SeasonSubmenu } from "./media-actions";

const STATUS_COLORS = { green: Color.Green, orange: Color.Orange, blue: Color.Blue, yellow: Color.Yellow } as const;

export default function MediaDetail(props: { mediaType: "movie" | "tv"; id: number; onRequested?: () => void }) {
  const { url } = jellyseerrPrefs();
  const { data, isLoading, revalidate } = useCachedPromise(getDetails, [props.mediaType, props.id], {
    keepPreviousData: true,
  });

  const status = data?.status ? STATUS[data.status] : undefined;
  const requestable = !status;
  const webUrl = `${url}/${props.mediaType}/${props.id}`;
  const target = data ? { mediaType: data.mediaType, id: data.id, title: data.title } : undefined;
  const onDone = () => {
    revalidate();
    props.onRequested?.();
  };

  const markdown = data
    ? [
        `# ${data.title}${data.year ? ` (${data.year})` : ""}`,
        data.posterPath ? `<img src="https://image.tmdb.org/t/p/w342${data.posterPath}" height="280" />` : "",
        data.overview || "*No overview available.*",
      ].join("\n\n")
    : "";

  return (
    <Detail
      isLoading={isLoading}
      markdown={markdown}
      navigationTitle={data?.title}
      metadata={
        data && (
          <Detail.Metadata>
            {status && (
              <Detail.Metadata.TagList title="Status">
                <Detail.Metadata.TagList.Item text={status.label} color={STATUS_COLORS[status.color]} />
              </Detail.Metadata.TagList>
            )}
            <Detail.Metadata.Label title="Type" text={data.mediaType === "tv" ? "Series" : "Movie"} />
            {data.rating !== undefined && data.rating > 0 && (
              <Detail.Metadata.Label title="Rating" text={`★ ${data.rating.toFixed(1)} / 10`} />
            )}
            {data.runtime !== undefined && data.runtime > 0 && (
              <Detail.Metadata.Label
                title={data.mediaType === "tv" ? "Episode Length" : "Runtime"}
                text={`${data.runtime} min`}
              />
            )}
            {data.mediaType === "tv" && data.seasons.length > 0 && (
              <Detail.Metadata.Label title="Seasons" text={String(data.seasons.length)} />
            )}
            {data.network && <Detail.Metadata.Label title={data.mediaType === "tv" ? "Network" : "Studio"} text={data.network} />}
            {data.genres.length > 0 && (
              <Detail.Metadata.TagList title="Genres">
                {data.genres.map((g) => (
                  <Detail.Metadata.TagList.Item key={g} text={g} />
                ))}
              </Detail.Metadata.TagList>
            )}
            {data.cast.length > 0 && <Detail.Metadata.Label title="Cast" text={data.cast.join(", ")} />}
            <Detail.Metadata.Separator />
            <Detail.Metadata.Link title="Jellyseerr" target={webUrl} text="Open in browser" />
          </Detail.Metadata>
        )
      }
      actions={
        target && (
          <ActionPanel>
            {requestable && (
              <Action
                title={target.mediaType === "tv" ? "Request All Seasons" : "Request"}
                icon={Icon.Download}
                onAction={() => doRequest(target, { onDone })}
              />
            )}
            {requestable && data && <SeasonSubmenu target={target} seasons={data.seasons} onDone={onDone} />}
            {requestable && <ProfileSubmenu target={target} onDone={onDone} />}
            <Action.OpenInBrowser title="Open in Jellyseerr" url={webUrl} />
            <Action.CopyToClipboard title="Copy Title" content={target.title} shortcut={{ modifiers: ["cmd"], key: "c" }} />
          </ActionPanel>
        )
      }
    />
  );
}
