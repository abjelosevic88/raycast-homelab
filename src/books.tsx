import { Action, ActionPanel, Color, Grid, Icon, Keyboard, showInFinder, showToast, Toast } from "@raycast/api";
import { useCachedPromise } from "@raycast/utils";
import { useState } from "react";
import {
  Book,
  BookFormat,
  bookWebUrl,
  downloadBook,
  hasCalibreCreds,
  newBooks,
  searchBooks,
  sendToKindle,
} from "./calibre-api";

// Kindle accepts EPUB natively now; keep AZW3/MOBI as fallbacks
const KINDLE_ORDER = ["epub", "azw3", "mobi", "pdf"];

function fmtSize(bytes?: number): string {
  if (!bytes) return "";
  return bytes >= 1e6 ? `${(bytes / 1e6).toFixed(1)} MB` : `${Math.round(bytes / 1e3)} KB`;
}

function BookTile(props: { book: Book }) {
  const b = props.book;
  const kindleFormats = [...b.formats].sort(
    (x, y) => (KINDLE_ORDER.indexOf(x.format) + 1 || 99) - (KINDLE_ORDER.indexOf(y.format) + 1 || 99),
  );
  const preferred = kindleFormats[0];

  async function kindle(f: BookFormat) {
    const toast = await showToast({ style: Toast.Style.Animated, title: `Sending ${b.title} (${f.format}) to Kindle…` });
    try {
      const msg = await sendToKindle(b, f);
      toast.style = Toast.Style.Success;
      toast.title = "Sent to Kindle";
      toast.message = msg;
    } catch (e) {
      toast.style = Toast.Style.Failure;
      toast.title = "Kindle send failed";
      toast.message = String(e instanceof Error ? e.message : e);
    }
  }

  async function download(f: BookFormat) {
    const toast = await showToast({ style: Toast.Style.Animated, title: `Downloading ${f.format.toUpperCase()}…` });
    try {
      const path = await downloadBook(b, f);
      toast.style = Toast.Style.Success;
      toast.title = "Saved to Downloads";
      toast.message = path.split("/").pop();
      toast.primaryAction = { title: "Show in Finder", onAction: () => showInFinder(path) };
    } catch (e) {
      toast.style = Toast.Style.Failure;
      toast.title = "Download failed";
      toast.message = String(e instanceof Error ? e.message : e);
    }
  }

  return (
    <Grid.Item
      content={b.coverPath ? { source: b.coverPath } : { source: Icon.Book, tintColor: Color.SecondaryText }}
      title={b.title}
      subtitle={[b.authors.join(", "), b.year, b.formats.map((f) => f.format.toUpperCase()).join("/")].filter(Boolean).join(" · ")}
      actions={
        <ActionPanel>
          <Action.OpenInBrowser title="Open in Calibre-Web" url={bookWebUrl(b.id)} />
          {preferred && (
            <Action
              title={`Send to Kindle (${preferred.format.toUpperCase()})`}
              icon={Icon.Envelope}
              shortcut={{ modifiers: ["cmd"], key: "e" }}
              onAction={() => kindle(preferred)}
            />
          )}
          {kindleFormats.length > 1 && (
            <ActionPanel.Submenu title="Send to Kindle as…" icon={Icon.Envelope} shortcut={{ modifiers: ["cmd", "shift"], key: "k" }}>
              {kindleFormats.map((f) => (
                <Action key={f.format} title={`${f.format.toUpperCase()} ${fmtSize(f.size)}`} onAction={() => kindle(f)} />
              ))}
            </ActionPanel.Submenu>
          )}
          <ActionPanel.Submenu title="Download…" icon={Icon.Download} shortcut={{ modifiers: ["cmd"], key: "d" }}>
            {b.formats.map((f) => (
              <Action key={f.format} title={`${f.format.toUpperCase()} ${fmtSize(f.size)}`} onAction={() => download(f)} />
            ))}
          </ActionPanel.Submenu>
          <Action.CopyToClipboard title="Copy Author – Title" content={`${b.authors.join(", ")} - ${b.title}`} shortcut={Keyboard.Shortcut.Common.Copy} />
        </ActionPanel>
      }
    />
  );
}

export default function Books() {
  const [query, setQuery] = useState("");
  const hasCreds = hasCalibreCreds();
  const searching = query.trim().length >= 2;

  const { data, isLoading } = useCachedPromise(
    async (q: string, ok: boolean) => (!ok ? [] : q.trim().length >= 2 ? await searchBooks(q.trim()) : await newBooks()),
    [query, hasCreds],
    {
      keepPreviousData: true,
      onError: (e) => {
        void showToast({ style: Toast.Style.Failure, title: "Calibre-Web", message: e.message });
      },
    },
  );

  return (
    <Grid
      isLoading={isLoading}
      searchText={query}
      onSearchTextChange={setQuery}
      throttle
      columns={6}
      aspectRatio="2/3"
      fit={Grid.Fit.Fill}
      searchBarPlaceholder="Search ebooks (title, author, series…)"
    >
      {!hasCreds && (
        <Grid.EmptyView
          icon={{ source: Icon.Key, tintColor: Color.Orange }}
          title="Calibre-Web password not set"
          description="⌘K → Configure Extension → Calibre-Web user + password"
        />
      )}
      {hasCreds && searching && !isLoading && (data?.length ?? 0) === 0 && (
        <Grid.EmptyView icon={Icon.Book} title="No books found" description={`Nothing matches "${query.trim()}"`} />
      )}
      <Grid.Section title={searching ? `Results (${data?.length ?? 0})` : "Recently Added"}>
        {data?.map((b) => <BookTile key={b.id} book={b} />)}
      </Grid.Section>
    </Grid>
  );
}
