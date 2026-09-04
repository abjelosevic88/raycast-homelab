import { Action, ActionPanel, Color, Icon, List, Keyboard } from "@raycast/api";
import { useCachedPromise } from "@raycast/utils";
import { fetchError } from "./fetch-error";
import {
  BAZARR_URL,
  hasBazarrKey,
  hasSubsync,
  loadSubsyncStatus,
  loadWanted,
  WantedItem,
} from "./subtitles-api";
import Nudge from "./nudge";

export default function Subtitles() {
  const sync = useCachedPromise(
    async (ok: boolean) => (ok ? await loadSubsyncStatus() : undefined),
    [hasSubsync()],
    { keepPreviousData: true, onError: fetchError("Subtitle sync server") },
  );
  const hasKey = hasBazarrKey();
  const wanted = useCachedPromise(
    async (ok: boolean) => (ok ? await loadWanted() : undefined),
    [hasKey],
    { keepPreviousData: true, onError: fetchError("Bazarr") },
  );

  const actions = (
    <ActionPanel>
      <Action.Push
        title="Nudge a Subtitle…"
        icon={Icon.Text}
        target={<Nudge />}
      />
      {BAZARR_URL && (
        <Action.OpenInBrowser title="Open Bazarr" url={BAZARR_URL} />
      )}
      <Action
        title="Refresh"
        icon={Icon.ArrowClockwise}
        shortcut={Keyboard.Shortcut.Common.Refresh}
        onAction={() => {
          sync.revalidate();
          wanted.revalidate();
        }}
      />
    </ActionPanel>
  );

  function wantedItem(w: WantedItem) {
    return (
      <List.Item
        key={w.id}
        icon={{
          source: w.kind === "movie" ? Icon.FilmStrip : Icon.Monitor,
          tintColor: Color.SecondaryText,
        }}
        title={w.title}
        subtitle={w.detail}
        accessories={w.languages.map((l) => ({
          tag: { value: l, color: Color.Orange },
        }))}
        actions={actions}
      />
    );
  }

  const s = sync.data;
  return (
    <List
      isLoading={sync.isLoading || wanted.isLoading}
      searchBarPlaceholder="Filter…"
    >
      <List.Section title="Subtitle Sync">
        <List.Item
          icon={{
            source:
              s?.status === "idle" ? Icon.CheckCircle : Icon.CircleProgress50,
            tintColor: s?.status === "idle" ? Color.Green : Color.Blue,
          }}
          title={
            s ? (s.status === "idle" ? "Idle" : `${s.status}: ${s.now}`) : "…"
          }
          subtitle={
            s
              ? `${s.queued} queued · ${s.missing} missing subtitles`
              : undefined
          }
          actions={actions}
        />
        {s?.items
          .filter((i) => i.name !== "Nothing in the queue")
          .map((i, idx) => (
            <List.Item
              key={`q-${idx}`}
              icon={Icon.Clock}
              title={i.name}
              subtitle={i.detail}
              actions={actions}
            />
          ))}
      </List.Section>
      {!hasKey && (
        <List.Section title="Wanted (Bazarr)">
          <List.Item
            icon={{ source: Icon.Key, tintColor: Color.Orange }}
            title="Bazarr API key not set — add it to list wanted subtitles"
            actions={actions}
          />
        </List.Section>
      )}
      {wanted.data && (
        <>
          <List.Section
            title={`Wanted — Episodes (${wanted.data.totals.episodes})`}
          >
            {wanted.data.episodes.map(wantedItem)}
          </List.Section>
          <List.Section
            title={`Wanted — Movies (${wanted.data.totals.movies})`}
          >
            {wanted.data.movies.map(wantedItem)}
          </List.Section>
        </>
      )}
    </List>
  );
}
