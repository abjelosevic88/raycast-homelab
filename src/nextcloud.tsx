import {
  Action,
  ActionPanel,
  Alert,
  Clipboard,
  confirmAlert,
  Form,
  Icon,
  Keyboard,
  List,
  openExtensionPreferences,
  showInFinder,
  showToast,
  Toast,
  useNavigation,
} from "@raycast/api";
import { usePromise } from "@raycast/utils";
import { useRef, useState } from "react";
import { fetchError } from "./fetch-error";
import NotConfigured from "./not-configured";
import {
  browseFiles,
  CloudFile,
  createShare,
  defaultSearch,
  deleteShare,
  downloadFile,
  fileWebUrl,
  hasNextcloudCredentials,
  isOcrExcerpt,
  listShares,
  SearchOptions,
  searchFiles,
} from "./nextcloud-api";

function plain(text: string) {
  return text
    .replace(/<\/?em>/g, "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/[\\`*_{}[\]()#+.!|~-]/g, "\\$&");
}
function SearchSettings({
  initial,
  apply,
}: {
  initial: SearchOptions;
  apply: (options: SearchOptions) => void;
}) {
  const { pop } = useNavigation();
  const [mode, setMode] = useState(initial.mode);
  return (
    <Form
      navigationTitle="Advanced Nextcloud Search"
      actions={
        <ActionPanel>
          <Action.SubmitForm
            title="Apply Search Options"
            onSubmit={(values: {
              mode: SearchOptions["mode"];
              extension: string;
              ocrOnly: boolean;
            }) => {
              if (
                values.extension &&
                !/^\.?[a-z0-9]{1,16}$/i.test(values.extension.trim())
              ) {
                void showToast(
                  Toast.Style.Failure,
                  "Enter one extension, such as pdf",
                );
                return;
              }
              apply({
                ...values,
                ocrOnly: values.mode === "all" && values.ocrOnly,
              });
              pop();
            }}
          />
        </ActionPanel>
      }
    >
      <Form.Dropdown
        id="mode"
        title="Search In"
        value={mode}
        onChange={(value) => setMode(value as SearchOptions["mode"])}
      >
        <Form.Dropdown.Item
          value="all"
          title="All Indexed Text — Includes OCR"
        />
        <Form.Dropdown.Item
          value="content"
          title="Main Document Text — Includes Image OCR"
        />
        <Form.Dropdown.Item value="filename" title="Indexed File Names" />
        <Form.Dropdown.Item value="dav" title="File Names (WebDAV)" />
      </Form.Dropdown>
      <Form.TextField
        id="extension"
        title="File Extension"
        placeholder="All types, or pdf / png / docx…"
        defaultValue={initial.extension}
      />
      {mode === "all" && (
        <Form.Checkbox
          id="ocrOnly"
          title="OCR"
          label="Show only results with OCR highlights"
          defaultValue={initial.ocrOnly}
        />
      )}
      <Form.Description
        title="Full-text Search"
        text={
          'Search uses your Nextcloud Elasticsearch index. Use "quoted phrases", +required or -excluded terms. All Indexed Text includes filenames, document text, comments and Tesseract OCR. File Names (WebDAV) works without an index.'
        }
      />
      <Form.Description
        title="OCR Matches"
        text="OCR highlights identify matches in PDF OCR fields or extracted image text. This filter applies to each page of results; use Next Page even if a page is empty. OCR must already be enabled and indexed on the server. Language and PDF page limits are server settings."
      />
      <Form.Description
        title="Recent Files"
        text="An empty query shows up to 200 recently modified files through WebDAV. Type a query to apply full-text and OCR options."
      />
    </Form>
  );
}
function CreateShare({ file }: { file: CloudFile }) {
  const [busy, setBusy] = useState(false);
  const inFlight = useRef(false);
  const [created, setCreated] = useState<string>();
  const date = new Date();
  date.setDate(date.getDate() + 7);
  const expiry = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
  return (
    <Form
      navigationTitle={`Share ${file.name}`}
      isLoading={busy}
      actions={
        <ActionPanel>
          {created ? (
            <Action.CopyToClipboard
              title="Copy Created Share Link"
              content={created}
            />
          ) : (
            <Action.SubmitForm
              title="Create Read-Only Share Link"
              icon={Icon.Link}
              onSubmit={async (values: {
                expiry: string;
                password: string;
              }) => {
                if (inFlight.current) return;
                inFlight.current = true;
                setBusy(true);
                try {
                  const share = await createShare(
                    file,
                    values.expiry,
                    values.password,
                  );
                  setCreated(share.url);
                  await Clipboard.copy(share.url);
                  await showToast(
                    Toast.Style.Success,
                    "Share link created and copied",
                  );
                } catch (error) {
                  fetchError("Create Nextcloud share")(
                    error instanceof Error ? error : new Error(String(error)),
                  );
                } finally {
                  inFlight.current = false;
                  setBusy(false);
                }
              }}
            />
          )}
        </ActionPanel>
      }
    >
      <Form.Description title="File" text={file.path} />
      {created ? (
        <Form.Description title="Share Link" text={created} />
      ) : (
        <>
          <Form.Description
            title="Access"
            text="Anyone with this link can view and download this item until it expires. An optional password restricts access. Folder links include their contents."
          />
          <Form.TextField
            id="expiry"
            title="Expires On"
            defaultValue={expiry}
            placeholder="YYYY-MM-DD"
          />
          <Form.PasswordField
            id="password"
            title="Password"
            placeholder="Optional, unless required by your server"
          />
        </>
      )}
    </Form>
  );
}
function Shares({ file }: { file: CloudFile }) {
  const { data, error, isLoading, revalidate } = usePromise(
    listShares,
    [file],
    { onError: fetchError("Nextcloud shares") },
  );
  const actions = (
    <ActionPanel>
      <Action.Push
        title="Create Share Link"
        target={<CreateShare file={file} />}
      />
      <Action
        title="Refresh"
        icon={Icon.ArrowClockwise}
        onAction={revalidate}
        shortcut={Keyboard.Shortcut.Common.Refresh}
      />
    </ActionPanel>
  );
  return (
    <List
      navigationTitle={`Share Links — ${file.name}`}
      isLoading={isLoading}
      actions={actions}
    >
      <List.EmptyView
        title={error ? "Could Not Load Share Links" : "No Public Share Links"}
        description={error?.message}
        actions={actions}
      />
      {data?.map((share) => (
        <List.Item
          key={share.id}
          title={`Link #${share.id}`}
          subtitle={
            share.expiration
              ? `Expires ${share.expiration.slice(0, 10)}`
              : "No expiry"
          }
          accessories={[
            {
              text:
                (Number(share.permissions) & 15) === 1
                  ? "Read only"
                  : `Permissions: ${share.permissions}`,
            },
          ]}
          actions={
            <ActionPanel>
              <Action.CopyToClipboard
                title="Copy Share Link"
                content={share.url}
              />
              <Action.Push
                title="Create Another Share Link"
                target={<CreateShare file={file} />}
              />
              <Action
                title="Revoke Share Link"
                icon={Icon.Trash}
                style={Action.Style.Destructive}
                onAction={async () => {
                  if (
                    !(await confirmAlert({
                      title: "Revoke this share link?",
                      message: "People using this link will lose access.",
                      primaryAction: {
                        title: "Revoke",
                        style: Alert.ActionStyle.Destructive,
                      },
                    }))
                  )
                    return;
                  try {
                    await deleteShare(String(share.id));
                    await revalidate();
                    await showToast(Toast.Style.Success, "Share link revoked");
                  } catch (e) {
                    fetchError("Revoke Nextcloud share")(
                      e instanceof Error ? e : new Error(String(e)),
                    );
                  }
                }}
              />
              <Action
                title="Refresh"
                icon={Icon.ArrowClockwise}
                onAction={revalidate}
                shortcut={Keyboard.Shortcut.Common.Refresh}
              />
            </ActionPanel>
          }
        />
      ))}
    </List>
  );
}
function FileActions({
  file,
  controls,
}: {
  file: CloudFile;
  controls: React.JSX.Element;
}) {
  const busy = useRef(false);
  return (
    <ActionPanel>
      {file.directory ? (
        <Action.Push
          title="Browse Folder"
          icon={Icon.Folder}
          target={<Nextcloud folder={file.path} />}
        />
      ) : (
        <Action.OpenInBrowser
          title="Open in Nextcloud"
          url={fileWebUrl(file)}
        />
      )}
      {!file.directory && (
        <Action
          title="Download File"
          icon={Icon.Download}
          shortcut={{ modifiers: ["cmd"], key: "d" }}
          onAction={async () => {
            if (busy.current) return;
            busy.current = true;
            const toast = await showToast(
              Toast.Style.Animated,
              "Downloading file…",
            );
            try {
              const path = await downloadFile(file);
              toast.style = Toast.Style.Success;
              toast.title = "Saved to Downloads";
              toast.primaryAction = {
                title: "Show in Finder",
                onAction: () => showInFinder(path),
              };
            } catch (error) {
              toast.style = Toast.Style.Failure;
              toast.title = "Download failed";
              toast.message =
                error instanceof Error ? error.message : String(error);
            } finally {
              busy.current = false;
            }
          }}
        />
      )}
      <Action.Push
        title="Create Share Link"
        icon={Icon.Link}
        target={<CreateShare file={file} />}
        shortcut={Keyboard.Shortcut.Common.Duplicate}
      />
      <Action.Push
        title="Manage Share Links"
        icon={Icon.Link}
        target={<Shares file={file} />}
      />
      <Action.CopyToClipboard
        title="Copy Nextcloud File Link"
        content={fileWebUrl(file)}
        shortcut={Keyboard.Shortcut.Common.Copy}
      />
      <Action.CopyToClipboard title="Copy File Path" content={file.path} />
      {controls}
    </ActionPanel>
  );
}
export default function Nextcloud({ folder }: { folder?: string } = {}) {
  const [query, setQuery] = useState("");
  const [options, setOptions] = useState<SearchOptions>(defaultSearch);
  const [page, setPage] = useState(1);
  const abortable = useRef<AbortController | null>(null);
  const configured = hasNextcloudCredentials();
  const { data, error, isLoading, revalidate } = usePromise(
    (
      text: string,
      opts: SearchOptions,
      currentPage: number,
      dir: string | undefined,
    ) =>
      dir !== undefined
        ? browseFiles(dir, abortable.current?.signal)
        : searchFiles(text, opts, currentPage, abortable.current?.signal),
    [folder === undefined ? query.trim() : "", options, page, folder],
    { execute: configured, abortable, onError: fetchError("Nextcloud") },
  );
  const controls = (
    <ActionPanel.Section title="Search and Navigation">
      {folder === undefined && (
        <Action.Push
          title="Advanced Search Options"
          icon={Icon.MagnifyingGlass}
          shortcut={{ modifiers: ["cmd"], key: "f" }}
          target={
            <SearchSettings
              initial={options}
              apply={(value) => {
                setOptions(value);
                setPage(1);
              }}
            />
          }
        />
      )}
      {folder === undefined && (
        <Action.Push
          title="Browse All Files"
          icon={Icon.Folder}
          target={<Nextcloud folder="/" />}
        />
      )}
      {data?.hasMore && (
        <Action
          title="Next Page"
          icon={Icon.ArrowRight}
          onAction={() => setPage(page + 1)}
          shortcut={{ modifiers: ["cmd"], key: "arrowRight" }}
        />
      )}
      {page > 1 && (
        <Action
          title="Previous Page"
          icon={Icon.ArrowLeft}
          onAction={() => setPage(page - 1)}
          shortcut={{ modifiers: ["cmd"], key: "arrowLeft" }}
        />
      )}
      <Action
        title="Refresh"
        icon={Icon.ArrowClockwise}
        onAction={revalidate}
        shortcut={Keyboard.Shortcut.Common.Refresh}
      />
      <Action
        title="Configure Extension"
        icon={Icon.Gear}
        onAction={openExtensionPreferences}
      />
    </ActionPanel.Section>
  );
  const actions = <ActionPanel>{controls}</ActionPanel>;
  const files = data?.files || [];
  const modeLabel = {
    all: "Indexed Text + OCR",
    content: "Document Content",
    filename: "Indexed File Names",
    dav: "File Names (WebDAV)",
  }[options.mode];
  return (
    <List
      navigationTitle={
        folder !== undefined
          ? `Nextcloud — ${folder}`
          : "Nextcloud Files and Sharing"
      }
      isLoading={configured && isLoading}
      filtering={folder !== undefined}
      searchText={query}
      onSearchTextChange={(text) => {
        setQuery(text);
        setPage(1);
      }}
      throttle
      isShowingDetail={files.length > 0}
      searchBarPlaceholder={
        folder !== undefined
          ? "Filter this folder…"
          : "Search files, document text and OCR…"
      }
      actions={actions}
    >
      {!configured && (
        <NotConfigured
          service="Nextcloud"
          needs="URL, username and app password"
        />
      )}
      {configured && error && (
        <List.Item
          title="Could Not Load Files"
          subtitle={error.message}
          icon={Icon.Warning}
          actions={actions}
        />
      )}
      {configured && !error && (
        <List.EmptyView
          title={isLoading ? "Loading Files…" : "No Matching Files"}
          description={
            data?.hasMore
              ? "No OCR highlights on this page. Use Next Page in Actions to continue."
              : "Try another query or File Names (WebDAV) in Advanced Search Options. OCR results require a completed server index."
          }
          actions={actions}
        />
      )}
      {configured && (
        <List.Section
          title={
            folder !== undefined
              ? "Folder Contents"
              : query.trim()
                ? `${modeLabel}${options.ocrOnly ? " · OCR Highlights" : ""} · Page ${page}`
                : "Recently Modified"
          }
          subtitle={
            data?.truncated
              ? "First 200 files — narrow your search or browse folders"
              : options.extension && folder === undefined
                ? `.${options.extension.replace(/^\./, "")} files`
                : undefined
          }
        >
          {files.map((file) => (
            <List.Item
              key={file.id}
              id={file.id}
              title={file.name}
              icon={file.directory ? Icon.Folder : Icon.Document}
              keywords={[file.path]}
              detail={
                <List.Item.Detail
                  markdown={`# ${plain(file.name)}\n\n${plain(file.path)}\n\n${file.excerpts
                    .slice(0, 8)
                    .map(
                      (e) =>
                        `**${isOcrExcerpt(file, e) ? "OCR match" : "Text match"}**\n\n${plain(e.excerpt)}`,
                    )
                    .join("\n\n")}`}
                  metadata={
                    <List.Item.Detail.Metadata>
                      <List.Item.Detail.Metadata.Label
                        title="Type"
                        text={file.directory ? "Folder" : file.mime || "File"}
                      />
                      {!file.directory && (
                        <List.Item.Detail.Metadata.Label
                          title="Size"
                          text={`${(file.size / 1024 / 1024).toLocaleString(undefined, { maximumFractionDigits: 2 })} MB`}
                        />
                      )}
                      <List.Item.Detail.Metadata.Label
                        title="Modified"
                        text={
                          file.modified
                            ? new Date(file.modified).toLocaleString()
                            : "Unknown"
                        }
                      />
                      <List.Item.Detail.Metadata.Label
                        title="Path"
                        text={file.path}
                      />
                    </List.Item.Detail.Metadata>
                  }
                />
              }
              actions={<FileActions file={file} controls={controls} />}
            />
          ))}
        </List.Section>
      )}
    </List>
  );
}
