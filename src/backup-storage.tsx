import {
  Action,
  ActionPanel,
  Color,
  Icon,
  Keyboard,
  List,
  openExtensionPreferences,
} from "@raycast/api";
import { useCachedPromise } from "@raycast/utils";
import { optionalUrl } from "./config";
import { formatBackupBytes } from "./backups-api";
import { BackupPlan } from "./backups-types";
import {
  backupStorageConnectionKey,
  hasBackupStorageHost,
  loadBackupStorageBreakdown,
} from "./backup-storage-api";
import {
  BackupStorageEntry,
  BackupStorageLocation,
} from "./backup-storage-types";

const M = List.Item.Detail.Metadata;
const STORAGE_FRESH_MS = 10 * 60_000;
const RESTIC_CATEGORIES: Record<
  string,
  { title: string; description: string }
> = {
  data: {
    title: "Shared Encrypted Backup Data",
    description:
      "Restic stores compressed, encrypted data packs here. Packs are shared across snapshots and plans through deduplication, so this space cannot be assigned exactly to a single plan or original file.",
  },
  index: {
    title: "Repository Indexes",
    description:
      "Indexes locate deduplicated backup data within the repository's data packs.",
  },
  snapshots: {
    title: "Snapshot Metadata",
    description:
      "These files describe retained snapshots. Their size is metadata only; the backed-up file contents are stored in shared data packs.",
  },
  keys: {
    title: "Encryption Key Metadata",
    description: "Encrypted repository key metadata used to unlock backups.",
  },
  locks: {
    title: "Repository Locks",
    description: "Small lock records coordinate operations on this repository.",
  },
  config: {
    title: "Repository Configuration",
    description: "The restic repository's format and configuration metadata.",
  },
};

function markdownText(value: string): string {
  return value.replace(/[\\`*_{}[\]()<>#+.!|~-]/g, "\\$&");
}

function dateLabel(value?: number | string): string {
  if (value === undefined) return "Not recorded";
  const date = new Date(value);
  return Number.isFinite(date.getTime())
    ? date.toLocaleString(undefined, { timeZoneName: "short" })
    : "Unavailable";
}

function percentLabel(bytes?: number, total?: number): string | undefined {
  if (bytes === undefined || total === undefined || total <= 0)
    return undefined;
  const percentage = (bytes / total) * 100;
  return percentage > 0 && percentage < 0.1
    ? "<0.1%"
    : `${percentage.toFixed(1)}%`;
}

export function BackupActions({ refresh }: { refresh: () => void }) {
  const url = optionalUrl("backrestUrl");
  return (
    <>
      <Action
        title="Refresh"
        icon={Icon.ArrowClockwise}
        shortcut={Keyboard.Shortcut.Common.Refresh}
        onAction={refresh}
      />
      {url && <Action.OpenInBrowser title="Open Backrest" url={url} />}
      <Action
        title="Configure Extension"
        icon={Icon.Gear}
        onAction={openExtensionPreferences}
      />
    </>
  );
}

export function StorageBreakdown({
  location,
  plans = [],
  relativePath = "",
}: {
  location: BackupStorageLocation;
  plans?: BackupPlan[];
  relativePath?: string;
}) {
  const configured = hasBackupStorageHost();
  const { data, error, isLoading, revalidate } = useCachedPromise(
    loadBackupStorageBreakdown,
    [backupStorageConnectionKey(), location.id, relativePath],
    {
      execute: configured,
      keepPreviousData: false,
      onError: () => {
        /* Preserve cached entries and display the failure in the view. */
      },
    },
  );
  const current = data?.location ?? location;
  const cloud = current.kind === "rclone";
  const restic = Boolean(current.repoId && current.group !== "staging");
  const stale = Boolean(
    data &&
    (error ||
      isLoading ||
      Date.now() - Date.parse(data.collectedAt) > STORAGE_FRESH_MS),
  );
  const incomplete = Boolean(
    data?.errors.length ||
    (data && (data.location.status !== "ok" || data.totalBytes === undefined)),
  );
  const entries = [...(data?.entries ?? [])].sort(
    (a, b) => (b.bytes ?? -1) - (a.bytes ?? -1) || a.name.localeCompare(b.name),
  );
  const logicalPlans = [...plans].sort(
    (a, b) =>
      (b.latestSnapshotBytes ?? -1) - (a.latestSnapshotBytes ?? -1) ||
      a.id.localeCompare(b.id),
  );
  const breadcrumb = relativePath
    ? relativePath.split("/").join(" › ")
    : "Destination Root";
  const sizeLabel = cloud
    ? "Current Cloud Object Bytes"
    : "Allocated Disk Space";
  const measurement = cloud
    ? "Sizes count current cloud objects. Provider-retained versions and billing overhead may occupy additional storage."
    : "Sizes count allocated filesystem space, including file and directory allocation.";
  const protection = restic
    ? "Restic shares compressed, encrypted data across snapshots and plans. Physical storage cannot be divided exactly by plan. Protected plan sizes shown at the destination root describe logical file contents and are not added to these totals."
    : current.group === "staging"
      ? "This destination contains staging exports or working files, reported separately from retained backup copies."
      : "This view shows stored folders and files within this backup destination.";
  const status = !configured
    ? "Storage Measurement Is Not Configured"
    : error
      ? data
        ? "Space Usage Unavailable — Cached Measurement"
        : "Space Usage Unavailable"
      : data?.location.status === "offline"
        ? "Destination Offline"
        : incomplete
          ? "Space Usage — Partial Measurement"
          : stale
            ? "Space Usage — Cached Measurement"
            : data
              ? "Space Usage"
              : "Measuring Space Usage…";
  const actions = (
    <ActionPanel>
      <BackupActions refresh={() => void revalidate()} />
    </ActionPanel>
  );
  const summaryMarkdown = [
    `## ${markdownText(current.label)}`,
    `**Folder:** ${markdownText(breadcrumb)}`,
    !configured
      ? "Set the Services SSH Host in extension preferences to measure backup storage."
      : "",
    error ? `**Measurement failed:** ${markdownText(error.message)}` : "",
    data?.location.error
      ? `**${markdownText(data.location.status)}:** ${markdownText(data.location.error)}`
      : "",
    stale ? "**Cached measurement. Refresh to verify current usage.**" : "",
    incomplete
      ? "**Some contents could not be measured. Unknown sizes are not zero; percentages are shown only when a folder total is known.**"
      : "",
    measurement,
    "Folders and files are sorted largest first. Select a folder and press Return to explore it. Storage is measured when you open a folder or choose Refresh.",
    protection,
    data?.truncated
      ? `**Listing limited:** showing the largest ${data.entries.length.toLocaleString()} entries. Remaining measured space is included in Other Space.`
      : "",
    ...(data?.errors ?? []).map(
      (warning) => `**Measurement warning:** ${markdownText(warning)}`,
    ),
  ]
    .filter(Boolean)
    .join("\n\n");

  function entryCategory(entry: BackupStorageEntry) {
    return restic && relativePath === ""
      ? RESTIC_CATEGORIES[entry.name]
      : undefined;
  }

  return (
    <List
      navigationTitle={`${current.label} › ${relativePath ? breadcrumb : "Space Usage"}`}
      searchBarPlaceholder="Search this folder's contents…"
      isLoading={isLoading}
      isShowingDetail
      actions={actions}
    >
      <List.EmptyView
        title="No Matching Contents"
        description="Try another search."
        actions={actions}
      />
      <List.Section title="Folder Summary">
        <List.Item
          id="folder-summary"
          title={status}
          icon={{
            source:
              error || incomplete || stale
                ? Icon.Warning
                : cloud
                  ? Icon.Cloud
                  : Icon.HardDrive,
            tintColor: error
              ? Color.Red
              : incomplete || stale
                ? Color.Orange
                : Color.SecondaryText,
          }}
          accessories={[
            { text: formatBackupBytes(data?.totalBytes) },
            ...(stale
              ? [{ tag: { value: "Cached", color: Color.Orange } }]
              : []),
          ]}
          detail={
            <List.Item.Detail
              markdown={summaryMarkdown}
              metadata={
                <M>
                  <M.Label title="Destination" text={current.label} />
                  <M.Label
                    title="Folder"
                    text={relativePath || "Destination Root"}
                  />
                  <M.Label
                    title={sizeLabel}
                    text={formatBackupBytes(data?.totalBytes)}
                  />
                  <M.Label
                    title="Measured"
                    text={dateLabel(data?.collectedAt)}
                  />
                  <M.Label
                    title="Listed Entries"
                    text={
                      data
                        ? `${data.entries.length.toLocaleString()}${data.truncated ? " (limited)" : ""}`
                        : "Unknown"
                    }
                  />
                  {current.repoId && (
                    <M.Label title="Repository" text={current.repoId} />
                  )}
                </M>
              }
            />
          }
          actions={actions}
        />
      </List.Section>
      <List.Section
        title="Contents"
        subtitle="Largest first · share of current folder"
      >
        {entries.map((entry) => {
          const category = entryCategory(entry);
          const percentage = percentLabel(entry.bytes, data?.totalBytes);
          return (
            <List.Item
              key={entry.relativePath}
              id={`entry-${entry.relativePath}`}
              title={category?.title ?? entry.name}
              subtitle={category ? entry.name : undefined}
              keywords={[entry.name, entry.kind, category?.description ?? ""]}
              icon={
                entry.kind === "directory"
                  ? Icon.Folder
                  : entry.kind === "symlink"
                    ? Icon.Link
                    : Icon.Document
              }
              accessories={[
                {
                  text: formatBackupBytes(entry.bytes),
                  tooltip:
                    entry.bytes === undefined
                      ? "Usage could not be measured"
                      : `${entry.bytes.toLocaleString()} bytes`,
                },
                ...(percentage
                  ? [
                      {
                        text: percentage,
                        tooltip: "Share of this folder's measured space",
                      },
                    ]
                  : []),
                ...(stale
                  ? [{ tag: { value: "Cached", color: Color.Orange } }]
                  : []),
              ]}
              detail={
                <List.Item.Detail
                  markdown={[
                    `## ${markdownText(category?.title ?? entry.name)}`,
                    category?.description ??
                      (entry.kind === "directory"
                        ? "Press Return to see which folders and files use this space."
                        : entry.kind === "symlink"
                          ? "Symbolic link allocation is shown. Link targets are not followed."
                          : "Measured storage for this file."),
                    entry.bytes === undefined
                      ? "**This entry's usage is unknown. It is not zero.**"
                      : "",
                    stale
                      ? "**Cached measurement. Refresh to verify current usage.**"
                      : "",
                    measurement,
                  ]
                    .filter(Boolean)
                    .join("\n\n")}
                  metadata={
                    <M>
                      <M.Label title="Destination" text={current.label} />
                      <M.Label
                        title="Relative Path"
                        text={entry.relativePath}
                      />
                      <M.Label
                        title="Type"
                        text={
                          entry.kind === "symlink"
                            ? "Symbolic link"
                            : entry.kind === "directory"
                              ? "Folder"
                              : "File"
                        }
                      />
                      <M.Label
                        title={sizeLabel}
                        text={formatBackupBytes(entry.bytes)}
                      />
                      <M.Label
                        title="Share of Folder"
                        text={percentage ?? "Unavailable"}
                      />
                      {entry.objectCount !== undefined && (
                        <M.Label
                          title="Objects"
                          text={entry.objectCount.toLocaleString()}
                        />
                      )}
                      <M.Label
                        title="Measured"
                        text={dateLabel(data?.collectedAt)}
                      />
                    </M>
                  }
                />
              }
              actions={
                <ActionPanel>
                  {entry.kind === "directory" && (
                    <Action.Push
                      title="Show Space Usage"
                      icon={Icon.Folder}
                      target={
                        <StorageBreakdown
                          location={current}
                          plans={plans}
                          relativePath={entry.relativePath}
                        />
                      }
                    />
                  )}
                  <BackupActions refresh={() => void revalidate()} />
                </ActionPanel>
              }
            />
          );
        })}
        {data && ((data.otherBytes ?? 0) > 0 || data.truncated) && (
          <List.Item
            id="other-space"
            title="Other Space"
            icon={Icon.Ellipsis}
            accessories={[
              { text: formatBackupBytes(data.otherBytes) },
              ...(percentLabel(data.otherBytes, data.totalBytes)
                ? [{ text: percentLabel(data.otherBytes, data.totalBytes) }]
                : []),
            ]}
            detail={
              <List.Item.Detail
                markdown={`## Other Space\n\n${data.truncated ? "Includes entries omitted by the listing limit and any directory allocation outside the displayed entries." : "Directory allocation or other measured space outside the displayed child entries."}\n\nThis is part of the current folder total. Unknown or unmeasured contents are not assigned to this amount.`}
              />
            }
            actions={actions}
          />
        )}
        {!isLoading && !entries.length && (
          <List.Item
            id="no-contents"
            title={
              data && !error && !incomplete
                ? "Empty Folder"
                : "Contents Unavailable"
            }
            icon={data && !error && !incomplete ? Icon.Folder : Icon.Warning}
            detail={
              <List.Item.Detail
                markdown={
                  data && !error && !incomplete
                    ? "This folder contains no child folders or files. Disk allocation for the folder itself may still use space."
                    : summaryMarkdown
                }
              />
            }
            actions={actions}
          />
        )}
      </List.Section>
      {!relativePath && logicalPlans.length > 0 && (
        <List.Section
          title="Protected Plans"
          subtitle="Latest logical snapshot size · separate from stored space"
        >
          {logicalPlans.map((plan) => (
            <List.Item
              key={plan.id}
              title={plan.id}
              icon={Icon.Clock}
              accessories={[
                {
                  text: `${formatBackupBytes(plan.latestSnapshotBytes)} logical`,
                },
              ]}
              detail={
                <List.Item.Detail
                  markdown={`## ${markdownText(plan.id)}\n\nThis is the logical size of file contents in the latest recorded snapshot. It is not this plan's disk or cloud usage. Restic deduplication, compression and shared snapshots prevent exact storage attribution by plan.\n\nThe repository's configured plans describe protected content; their presence does not verify that a replica contains the latest snapshot.\n\n${markdownText(plan.health.detail)}\n\nPlan details were loaded with Backup Health. Return to Backup Health and refresh to update them.`}
                  metadata={
                    <M>
                      <M.Label title="Repository" text={plan.repoId} />
                      <M.Label
                        title="Latest Snapshot (Logical)"
                        text={formatBackupBytes(plan.latestSnapshotBytes)}
                      />
                      <M.Label
                        title="Last Successful Backup"
                        text={dateLabel(plan.lastSuccessAt)}
                      />
                    </M>
                  }
                />
              }
              actions={actions}
            />
          ))}
        </List.Section>
      )}
    </List>
  );
}
