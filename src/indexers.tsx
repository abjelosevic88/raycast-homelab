import {
  Action,
  ActionPanel,
  Color,
  confirmAlert,
  Icon,
  List,
  showToast,
  Toast,
  Keyboard,
} from "@raycast/api";
import { useCachedPromise } from "@raycast/utils";
import { useState } from "react";
import {
  CATEGORIES,
  fmtBytes,
  grabRelease,
  hasProwlarrKey,
  PROWLARR_URL,
  Release,
  searchReleases,
} from "./prowlarr-api";

export default function Indexers() {
  const [query, setQuery] = useState("");
  const [category, setCategory] = useState("all");
  const hasKey = hasProwlarrKey();

  const { data, isLoading } = useCachedPromise(
    async (q: string, cat: string, ok: boolean) =>
      ok && q.trim().length >= 3 ? await searchReleases(q.trim(), cat) : [],
    [query, category, hasKey],
    {
      keepPreviousData: true,
      onError: (e) => {
        void showToast({
          style: Toast.Style.Failure,
          title: "Prowlarr search failed",
          message: e.message,
        });
      },
    },
  );

  async function grab(r: Release) {
    if (
      !(await confirmAlert({
        title: `Grab "${r.title.slice(0, 80)}"?`,
        message: `${r.indexer} · ${fmtBytes(r.size)} · sent to the ${r.protocol} client`,
      }))
    )
      return;
    const toast = await showToast({
      style: Toast.Style.Animated,
      title: "Grabbing…",
    });
    try {
      await grabRelease(r);
      toast.style = Toast.Style.Success;
      toast.title = "Sent to download client";
      toast.message = r.title.slice(0, 60);
    } catch (e) {
      toast.style = Toast.Style.Failure;
      toast.title = "Grab failed";
      toast.message = String(e instanceof Error ? e.message : e);
    }
  }

  return (
    <List
      isLoading={isLoading}
      filtering={false}
      searchText={query}
      onSearchTextChange={setQuery}
      throttle
      searchBarPlaceholder="Search all indexers (3+ chars)…"
      searchBarAccessory={
        <List.Dropdown
          tooltip="Category"
          value={category}
          onChange={setCategory}
        >
          {CATEGORIES.map((c) => (
            <List.Dropdown.Item key={c.id} title={c.title} value={c.id} />
          ))}
        </List.Dropdown>
      }
    >
      {!hasKey && (
        <List.EmptyView
          icon={{ source: Icon.Key, tintColor: Color.Orange }}
          title="Prowlarr API key not set"
          description="⌘K → Configure Extension → set the Prowlarr URL and API key (Settings → General)"
        />
      )}
      {hasKey && query.trim().length < 3 && (
        <List.EmptyView
          icon={Icon.MagnifyingGlass}
          title="Search every indexer at once"
          description="Results sorted by seeders; Enter grabs straight to your download client"
        />
      )}
      <List.Section
        title={data && data.length > 0 ? `${data.length} releases` : undefined}
      >
        {data?.map((r) => (
          <List.Item
            key={`${r.indexerId}-${r.guid}`}
            icon={{
              source: r.protocol === "usenet" ? Icon.Globe : Icon.Network,
              tintColor:
                (r.seeders ?? 0) > 5 ? Color.Green : Color.SecondaryText,
            }}
            title={r.title}
            subtitle={r.indexer}
            accessories={[
              { text: fmtBytes(r.size) },
              ...(r.protocol === "torrent"
                ? [{ text: `${r.seeders ?? 0}↑ ${r.leechers ?? 0}↓` }]
                : [{ text: `${r.grabs ?? 0} grabs` }]),
              { tag: `${Math.round(r.age)}d` },
            ]}
            actions={
              <ActionPanel>
                <Action
                  title="Grab Release"
                  icon={Icon.Download}
                  onAction={() => grab(r)}
                />
                {r.infoUrl && (
                  <Action.OpenInBrowser
                    title="Open Release Page"
                    url={r.infoUrl}
                  />
                )}
                <Action.CopyToClipboard
                  title="Copy Title"
                  content={r.title}
                  shortcut={{ modifiers: ["cmd"], key: "c" }}
                />
                <Action.OpenInBrowser
                  title="Open Prowlarr"
                  url={PROWLARR_URL}
                  shortcut={Keyboard.Shortcut.Common.Open}
                />
              </ActionPanel>
            }
          />
        ))}
      </List.Section>
    </List>
  );
}
