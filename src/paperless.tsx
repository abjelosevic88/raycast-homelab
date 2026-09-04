import {
  Action,
  ActionPanel,
  Clipboard,
  Detail,
  Icon,
  Keyboard,
  List,
  open,
  openExtensionPreferences,
  showInFinder,
  showToast,
  Toast,
} from "@raycast/api";
import { usePromise } from "@raycast/utils";
import { useRef, useState } from "react";
import { optionalUrl } from "./config";
import { fetchError } from "./fetch-error";
import NotConfigured from "./not-configured";
import {
  documentWebUrl,
  downloadDocument,
  getDocument,
  getPaperlessMetadata,
  hasPaperlessCredentials,
  PaperlessDocument,
  PaperlessMetadata,
  previewDocument,
  searchDocuments,
} from "./paperless-api";

// OCR text is untrusted plain text: never render embedded links or remote images.
function plainMarkdown(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/[\\`*_{}[\]()#+.!|~-]/g, "\\$&")
    .replace(/\r\n/g, "\n")
    .replace(/\n/g, "  \n");
}

function documentMarkdown(document: PaperlessDocument, limit: number): string {
  const content =
    document.content?.trim() || "No OCR text is available for this document.";
  return `# ${plainMarkdown(document.title || "Untitled")}\n\n${plainMarkdown(content.slice(0, limit))}${content.length > limit ? "\n\n*Preview truncated. Open the document in Paperless or copy its full text.*" : ""}`;
}

function DocumentMetadata({
  document,
  metadata,
}: {
  document: PaperlessDocument;
  metadata?: PaperlessMetadata;
}) {
  return (
    <Detail.Metadata>
      <Detail.Metadata.Label title="Document ID" text={String(document.id)} />
      <Detail.Metadata.Label
        title="Created"
        text={document.created?.slice(0, 10) || "Unknown"}
      />
      <Detail.Metadata.Label
        title="Added"
        text={document.added?.slice(0, 10) || "Unknown"}
      />
      {document.correspondent != null && (
        <Detail.Metadata.Label
          title="Correspondent"
          text={
            metadata?.correspondents[document.correspondent] ||
            `#${document.correspondent}`
          }
        />
      )}
      {document.document_type != null && (
        <Detail.Metadata.Label
          title="Type"
          text={
            metadata?.documentTypes[document.document_type] ||
            `#${document.document_type}`
          }
        />
      )}
      {document.archive_serial_number != null && (
        <Detail.Metadata.Label
          title="Archive Serial Number"
          text={String(document.archive_serial_number)}
        />
      )}
      {document.tags.length > 0 && (
        <Detail.Metadata.TagList title="Tags">
          {document.tags.map((id) => (
            <Detail.Metadata.TagList.Item
              key={id}
              text={metadata?.tags[id]?.name || `#${id}`}
            />
          ))}
        </Detail.Metadata.TagList>
      )}
      <Detail.Metadata.Link
        title="Paperless"
        text="Open Document"
        target={documentWebUrl(document.id)}
      />
    </Detail.Metadata>
  );
}

function DocumentActions({
  document,
  metadata,
  onRefresh,
  inDetail = false,
}: {
  document: PaperlessDocument;
  metadata?: PaperlessMetadata;
  onRefresh: () => void;
  inDetail?: boolean;
}) {
  const busy = useRef(false);

  async function copyText() {
    const toast = await showToast({
      style: Toast.Style.Animated,
      title: "Loading full document text…",
    });
    try {
      // Search results contain only an excerpt, even when opened in a detail view.
      const full = await getDocument(document.id);
      await Clipboard.copy(full.content || "");
      toast.style = Toast.Style.Success;
      toast.title = full.content
        ? "Copied OCR text"
        : "Document has no OCR text";
    } catch (error) {
      toast.style = Toast.Style.Failure;
      toast.title = "Could not copy OCR text";
      toast.message = error instanceof Error ? error.message : String(error);
    }
  }

  async function fileAction(variant: "preview" | "original" | "archive") {
    if (busy.current) return;
    busy.current = true;
    try {
      const toast = await showToast({
        style: Toast.Style.Animated,
        title:
          variant === "preview"
            ? "Preparing document preview…"
            : "Downloading document…",
      });
      try {
        const path =
          variant === "preview"
            ? await previewDocument(document)
            : await downloadDocument(document, variant);
        if (variant === "preview") {
          await open(path);
          toast.style = Toast.Style.Success;
          toast.title = "Opened document preview";
        } else {
          toast.style = Toast.Style.Success;
          toast.title = "Saved to Downloads";
          toast.primaryAction = {
            title: "Show in Finder",
            onAction: () => showInFinder(path),
          };
        }
      } catch (error) {
        toast.style = Toast.Style.Failure;
        toast.title =
          variant === "preview" ? "Preview failed" : "Download failed";
        toast.message = error instanceof Error ? error.message : String(error);
      }
    } finally {
      busy.current = false;
    }
  }

  return (
    <ActionPanel>
      {!inDetail && (
        <Action.Push
          title="Read Document Text"
          icon={Icon.Document}
          target={<DocumentText document={document} metadata={metadata} />}
        />
      )}
      <Action.OpenInBrowser
        title="Open in Paperless"
        url={documentWebUrl(document.id)}
        shortcut={Keyboard.Shortcut.Common.Open}
      />
      <Action
        title="Preview File"
        icon={Icon.Eye}
        onAction={() => fileAction("preview")}
        shortcut={Keyboard.Shortcut.Common.ToggleQuickLook}
      />
      <ActionPanel.Section title="Download">
        <Action
          title="Download Original"
          icon={Icon.Download}
          onAction={() => fileAction("original")}
          shortcut={{ modifiers: ["cmd"], key: "d" }}
        />
        {document.archived_file_name && (
          <Action
            title="Download Archived PDF"
            icon={Icon.Download}
            onAction={() => fileAction("archive")}
          />
        )}
      </ActionPanel.Section>
      <ActionPanel.Section>
        <Action.CopyToClipboard
          title="Copy Document Link"
          content={documentWebUrl(document.id)}
          shortcut={Keyboard.Shortcut.Common.Copy}
        />
        <Action
          title="Copy OCR Text"
          icon={Icon.Clipboard}
          onAction={copyText}
        />
        <Action
          title="Refresh"
          icon={Icon.ArrowClockwise}
          onAction={onRefresh}
          shortcut={Keyboard.Shortcut.Common.Refresh}
        />
        <Action
          title="Configure Extension"
          icon={Icon.Gear}
          onAction={openExtensionPreferences}
        />
      </ActionPanel.Section>
    </ActionPanel>
  );
}

function DocumentText({
  document,
  metadata,
}: {
  document: PaperlessDocument;
  metadata?: PaperlessMetadata;
}) {
  const { data, isLoading, error, revalidate } = usePromise(
    getDocument,
    [document.id],
    { onError: fetchError("Paperless") },
  );
  const current = data || document;
  return (
    <Detail
      navigationTitle={current.title}
      isLoading={isLoading}
      markdown={
        error
          ? `# Could not refresh document\n\n${plainMarkdown(error.message)}`
          : documentMarkdown(current, 80000)
      }
      metadata={<DocumentMetadata document={current} metadata={metadata} />}
      actions={
        <DocumentActions
          document={current}
          metadata={metadata}
          onRefresh={revalidate}
          inDetail
        />
      }
    />
  );
}

export default function Paperless() {
  const [query, setQuery] = useState("");
  const abortable = useRef<AbortController | null>(null);
  const configured = hasPaperlessCredentials();
  // Keep private document contents in memory only, rather than Raycast's persistent cache.
  const documents = usePromise(
    (text: string) =>
      async ({ page }: { page: number }) => {
        const result = await searchDocuments(
          text,
          page + 1,
          abortable.current?.signal,
        );
        return { data: result.results, hasMore: Boolean(result.next) };
      },
    [query.trim()],
    { execute: configured, abortable, onError: fetchError("Paperless") },
  );
  const metadata = usePromise(getPaperlessMetadata, [], {
    execute: configured,
    onError: fetchError("Paperless metadata"),
  });
  function refresh() {
    void documents.revalidate();
    void metadata.revalidate();
  }
  const commonActions = (
    <ActionPanel>
      {configured && (
        <Action
          title="Retry"
          icon={Icon.ArrowClockwise}
          onAction={refresh}
          shortcut={Keyboard.Shortcut.Common.Refresh}
        />
      )}
      <Action
        title="Configure Extension"
        icon={Icon.Gear}
        onAction={openExtensionPreferences}
      />
      {optionalUrl("paperlessUrl") && (
        <Action.OpenInBrowser
          title="Open Paperless"
          url={optionalUrl("paperlessUrl")}
        />
      )}
    </ActionPanel>
  );
  const seen = new Set<number>();
  const shown = (documents.data || []).filter((document) => {
    if (seen.has(document.id)) return false;
    seen.add(document.id);
    return true;
  });
  return (
    <List
      navigationTitle="Paperless Search"
      isLoading={configured && (documents.isLoading || metadata.isLoading)}
      isShowingDetail={shown.length > 0 || Boolean(documents.error)}
      searchText={query}
      onSearchTextChange={setQuery}
      searchBarPlaceholder="Search documents and OCR text…"
      filtering={false}
      throttle
      pagination={configured ? documents.pagination : undefined}
      actions={commonActions}
    >
      {!configured && (
        <NotConfigured service="Paperless" needs="URL and API token" />
      )}
      {configured && documents.error && (
        <List.Item
          id="paperless-error"
          icon={Icon.Warning}
          title="Could not load documents"
          subtitle={documents.error.message}
          detail={
            <List.Item.Detail
              markdown={plainMarkdown(documents.error.message)}
            />
          }
          actions={commonActions}
        />
      )}
      {configured &&
        !documents.isLoading &&
        !documents.error &&
        shown.length === 0 && (
          <List.EmptyView
            icon={Icon.Document}
            title={query.trim() ? "No matching documents" : "No documents yet"}
            description={
              query.trim()
                ? "Try another name, invoice number, or phrase from the document."
                : "Add a document in Paperless to start searching."
            }
            actions={commonActions}
          />
        )}
      {configured && (
        <List.Section
          title={query.trim() ? "Search Results" : "Recently Added"}
          subtitle={
            metadata.error
              ? "Metadata unavailable — refresh to retry"
              : undefined
          }
        >
          {shown.map((document) => (
            <List.Item
              key={document.id}
              id={String(document.id)}
              title={document.title || "Untitled"}
              icon={Icon.Document}
              detail={
                <List.Item.Detail
                  markdown={`${documentMarkdown(document, 4000)}\n\n*Text excerpt · Press Enter to read the document text.*`}
                  metadata={
                    <DocumentMetadata
                      document={document}
                      metadata={metadata.data}
                    />
                  }
                />
              }
              actions={
                <DocumentActions
                  document={document}
                  metadata={metadata.data}
                  onRefresh={refresh}
                />
              }
            />
          ))}
        </List.Section>
      )}
    </List>
  );
}
