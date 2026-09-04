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
import { useEffect } from "react";
import {
  hasJellyfinKey,
  itemLabel,
  itemWebUrl,
  JELLYFIN_URL,
  JfItem,
  loadNextUp,
  loadResume,
  loadSessions,
  markPlayed,
  posterUrl,
} from "./jellyfin-api";

const POLL_MS = 15000;

function ItemTile(props: {
  item: JfItem;
  onChanged?: () => void;
  badge?: string;
}) {
  const i = props.item;
  const sub = [
    i.type === "Episode" ? i.name : undefined,
    i.progress > 0 && i.progress < 1
      ? `${Math.round(i.progress * 100)}%`
      : undefined,
    props.badge,
  ]
    .filter(Boolean)
    .join(" · ");

  async function played() {
    try {
      await markPlayed(i.id);
      await showToast({
        style: Toast.Style.Success,
        title: `Marked played: ${itemLabel(i)}`,
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
      content={{ source: posterUrl(i) }}
      title={itemLabel(i)}
      subtitle={sub}
      actions={
        <ActionPanel>
          <Action.OpenInBrowser
            title="Open in Jellyfin"
            url={itemWebUrl(i.id)}
          />
          <Action
            title="Mark as Played"
            icon={Icon.CheckCircle}
            shortcut={{ modifiers: ["cmd", "shift"], key: "p" }}
            onAction={played}
          />
          <Action.OpenInBrowser
            title="Open Jellyfin"
            url={JELLYFIN_URL}
            shortcut={Keyboard.Shortcut.Common.Open}
          />
        </ActionPanel>
      }
    />
  );
}

export default function Jellyfin() {
  const hasKey = hasJellyfinKey();
  const onError = (e: Error) => {
    void showToast({
      style: Toast.Style.Failure,
      title: "Jellyfin",
      message: e.message,
    });
  };
  const sessions = useCachedPromise(
    async (ok: boolean) => (ok ? await loadSessions() : []),
    [hasKey],
    { keepPreviousData: true, onError },
  );
  const resume = useCachedPromise(
    async (ok: boolean) => (ok ? await loadResume() : []),
    [hasKey],
    { keepPreviousData: true, onError },
  );
  const nextUp = useCachedPromise(
    async (ok: boolean) => (ok ? await loadNextUp() : []),
    [hasKey],
    { keepPreviousData: true, onError },
  );

  useEffect(() => {
    const t = setInterval(() => {
      sessions.revalidate();
      resume.revalidate();
    }, POLL_MS);
    return () => clearInterval(t);
  }, []);

  const refresh = () => {
    sessions.revalidate();
    resume.revalidate();
    nextUp.revalidate();
  };

  return (
    <Grid
      isLoading={sessions.isLoading || resume.isLoading || nextUp.isLoading}
      columns={5}
      aspectRatio="2/3"
      fit={Grid.Fit.Fill}
      searchBarPlaceholder="Filter…"
    >
      {!hasKey && (
        <Grid.EmptyView
          icon={{ source: Icon.Key, tintColor: Color.Orange }}
          title="Jellyfin API key not set"
          description="⌘K → Configure Extension → set the Jellyfin URL and an API key (Dashboard → API Keys)"
        />
      )}
      {(sessions.data?.length ?? 0) > 0 && (
        <Grid.Section title="Now Playing">
          {sessions.data?.map((s, idx) =>
            s.item ? (
              <ItemTile
                key={`np-${idx}`}
                item={s.item}
                badge={`${s.paused ? "⏸" : "▶"} ${s.user} on ${s.device}`}
                onChanged={refresh}
              />
            ) : null,
          )}
        </Grid.Section>
      )}
      <Grid.Section title={`Continue Watching (${resume.data?.length ?? 0})`}>
        {resume.data?.map((i) => (
          <ItemTile key={`r-${i.id}`} item={i} onChanged={refresh} />
        ))}
      </Grid.Section>
      <Grid.Section title={`Next Up (${nextUp.data?.length ?? 0})`}>
        {nextUp.data?.map((i) => (
          <ItemTile key={`n-${i.id}`} item={i} onChanged={refresh} />
        ))}
      </Grid.Section>
    </Grid>
  );
}
