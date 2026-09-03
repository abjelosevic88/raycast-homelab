import { Action, ActionPanel, Color, Icon, List } from "@raycast/api";
import { useCachedPromise } from "@raycast/utils";
import { ARR_URLS, CalendarEntry, configuredArrs, loadArrData, StuckItem } from "./arr-api";

const APP_META = {
  radarr: { label: "Movie", color: Color.Yellow, icon: Icon.FilmStrip },
  sonarr: { label: "TV", color: Color.Purple, icon: Icon.Monitor },
  lidarr: { label: "Music", color: Color.Green, icon: Icon.Music },
} as const;

function dayLabel(date: string): string {
  const today = new Date().toISOString().slice(0, 10);
  const diff = Math.round((new Date(date).getTime() - new Date(today).getTime()) / 86400000);
  if (diff < 0) return "Yesterday";
  if (diff === 0) return "Today";
  if (diff === 1) return "Tomorrow";
  const weekday = new Date(date).toLocaleDateString("en-US", { weekday: "short" });
  return `${weekday} ${date.slice(5)}`;
}

export default function Calendar() {
  const { data, isLoading, revalidate } = useCachedPromise(loadArrData, [], { keepPreviousData: true });
  const configured = configuredArrs();

  const common = (
    <>
      <Action title="Refresh" icon={Icon.ArrowClockwise} shortcut={{ modifiers: ["cmd"], key: "r" }} onAction={revalidate} />
      <Action.OpenInBrowser title="Open Radarr" url={ARR_URLS.radarr} />
      <Action.OpenInBrowser title="Open Sonarr" url={ARR_URLS.sonarr} />
      <Action.OpenInBrowser title="Open Lidarr" url={ARR_URLS.lidarr} />
    </>
  );

  function calItem(e: CalendarEntry) {
    const meta = APP_META[e.app];
    return (
      <List.Item
        key={e.id}
        icon={{ source: meta.icon, tintColor: meta.color }}
        title={e.title}
        subtitle={e.subtitle}
        accessories={[
          { text: dayLabel(e.date) },
          e.has
            ? { tag: { value: "downloaded", color: Color.Green } }
            : { tag: { value: meta.label, color: meta.color } },
        ]}
        actions={<ActionPanel>{common}</ActionPanel>}
      />
    );
  }

  function stuckItem(s: StuckItem) {
    const meta = APP_META[s.app];
    return (
      <List.Item
        key={s.id}
        icon={{ source: Icon.Warning, tintColor: Color.Red }}
        title={s.title}
        subtitle={s.error}
        accessories={[{ tag: { value: s.app, color: meta.color } }, { text: s.status }]}
        actions={<ActionPanel>{common}</ActionPanel>}
      />
    );
  }

  const today = new Date().toISOString().slice(0, 10);
  const past = data?.calendar.filter((e) => e.date < today) ?? [];
  const todayList = data?.calendar.filter((e) => e.date === today) ?? [];
  const upcoming = data?.calendar.filter((e) => e.date > today) ?? [];

  return (
    <List isLoading={isLoading} searchBarPlaceholder="Filter releases…">
      {configured.length === 0 && (
        <List.EmptyView
          icon={{ source: Icon.Key, tintColor: Color.Orange }}
          title="No arr API keys set"
          description="⌘K → Configure Extension → paste Radarr / Sonarr / Lidarr API keys"
        />
      )}
      {(data?.stuck.length ?? 0) > 0 && (
        <List.Section title={`Stuck in Queue (${data?.stuck.length})`}>{data?.stuck.map(stuckItem)}</List.Section>
      )}
      {todayList.length > 0 && <List.Section title="Today">{todayList.map(calItem)}</List.Section>}
      {upcoming.length > 0 && <List.Section title="Upcoming (14 days)">{upcoming.map(calItem)}</List.Section>}
      {past.length > 0 && <List.Section title="Yesterday">{past.map(calItem)}</List.Section>}
      {data && data.errors.length > 0 && (
        <List.Section title="Errors">
          {data.errors.map((e, i) => (
            <List.Item key={i} icon={{ source: Icon.Warning, tintColor: Color.Red }} title={e} />
          ))}
        </List.Section>
      )}
      {!isLoading && configured.length > 0 && (data?.calendar.length ?? 0) === 0 && (data?.stuck.length ?? 0) === 0 && (
        <List.EmptyView icon={Icon.Calendar} title="Nothing scheduled" description="No releases in the next 14 days, queues clean" />
      )}
    </List>
  );
}
