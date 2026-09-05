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
import { useEffect } from "react";
import { optionalUrl } from "./config";
import {
  backupConnectionKey,
  backupSummary,
  formatBackupBytes,
  loadBackupHealth,
} from "./backups-api";
import {
  BackupLevel,
  BackupPlan,
  BackupRepository,
  BackupRun,
} from "./backups-types";
import {
  backupStorageConnectionKey,
  hasBackupStorageHost,
  loadBackupStorage,
} from "./backup-storage-api";
import { BackupStorageLocation } from "./backup-storage-types";

const HEALTH_POLL_MS = 60_000;
const COLORS: Record<BackupLevel, Color> = {
  ok: Color.Green,
  info: Color.SecondaryText,
  warning: Color.Orange,
  error: Color.Red,
};
const ORDER: Record<BackupLevel, number> = {
  error: 0,
  warning: 1,
  info: 2,
  ok: 3,
};
const M = List.Item.Detail.Metadata;

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

function runLabel(run?: BackupRun): string {
  return run
    ? `${run.status} · ${dateLabel(run.finishedAt ?? run.startedAt)}`
    : "Never recorded";
}

function CommonActions({ refresh }: { refresh: () => void }) {
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

function PlanDetail({ plan, stale }: { plan: BackupPlan; stale: boolean }) {
  return (
    <List.Item.Detail
      markdown={`## ${markdownText(plan.id)}\n\n${markdownText(plan.health.detail)}${stale ? "\n\n**Cached snapshot. Refresh to verify the current state.**" : ""}\n\nThe latest snapshot size is the logical size of files in that snapshot. Deduplication and compression make repository storage different; snapshot sizes are not added to storage totals.`}
      metadata={
        <M>
          <M.TagList title="Health">
            <M.TagList.Item
              text={plan.health.label}
              color={COLORS[plan.health.level]}
            />
          </M.TagList>
          <M.Label title="Repository" text={plan.repoId} />
          <M.Label title="Schedule" text={plan.schedule} />
          <M.Label title="Next Run" text={dateLabel(plan.nextRunAt)} />
          <M.Separator />
          <M.Label title="Latest Backup" text={runLabel(plan.lastBackup)} />
          <M.Label
            title="Last Successful Backup"
            text={dateLabel(plan.lastSuccessAt)}
          />
          <M.Label
            title="Latest Snapshot (Logical)"
            text={formatBackupBytes(plan.latestSnapshotBytes)}
          />
        </M>
      }
    />
  );
}

function RepositoryDetail({
  repo,
  stale,
}: {
  repo: BackupRepository;
  stale: boolean;
}) {
  return (
    <List.Item.Detail
      markdown={`## ${markdownText(repo.id)}\n\n${markdownText(repo.health.detail)}${stale ? "\n\n**Cached snapshot. Refresh to verify the current state.**" : ""}\n\nRaw data is Backrest's cached restic statistic for deduplicated, compressed repository data. Its measurement time is shown below. It excludes filesystem overhead and additional copies. See **Backup Storage** for measured disk allocation and cloud object storage.\n\nVerification coverage depends on the configured check mode; a metadata check is not a full read of all backed-up data.`}
      metadata={
        <M>
          <M.TagList title="Health">
            <M.TagList.Item
              text={repo.health.label}
              color={COLORS[repo.health.level]}
            />
          </M.TagList>
          <M.Label
            title="Raw Data (Cached)"
            text={formatBackupBytes(repo.storedBytes)}
          />
          <M.Label title="Raw Data Measured" text={dateLabel(repo.statsAt)} />
          <M.Label
            title="Snapshots at Last Measurement"
            text={repo.snapshotCount?.toLocaleString() ?? "Not recorded"}
          />
          <M.Separator />
          <M.Label
            title="Latest Verification"
            text={runLabel(repo.lastCheck)}
          />
          <M.Label
            title="Last Successful Verification"
            text={dateLabel(repo.lastSuccessfulCheckAt)}
          />
          <M.Label title="Check Mode" text={repo.checkMode} />
          <M.Label
            title="Next Verification"
            text={dateLabel(repo.nextCheckAt)}
          />
        </M>
      }
    />
  );
}

function LocationDetail({
  location,
  collectedAt,
  stale,
}: {
  location: BackupStorageLocation;
  collectedAt: string;
  stale: boolean;
}) {
  const cloud = location.kind === "rclone";
  return (
    <List.Item.Detail
      markdown={`## ${markdownText(location.label)}\n\n${location.status === "ok" ? (cloud ? "Current cloud object bytes. Provider-retained versions and billing overhead may occupy additional storage." : "Allocated filesystem bytes for this backup location, including repository files and overhead.") : markdownText(location.error ?? "This location could not be measured.")}\n\n${location.status !== "ok" ? "**Unknown usage is excluded from the measured subtotal; it is not zero.**\n\n" : ""}${stale ? "**Cached measurement. Refresh to measure storage again.**\n\n" : ""}${location.group === "staging" ? "Staging contains backup exports or working files and is reported separately from retained backup copies." : "Each physical backup copy contributes separately to disk or cloud usage. Do not add the raw-data statistic to this measurement."}`}
      metadata={
        <M>
          <M.Label title="Status" text={location.status} />
          <M.Label
            title={cloud ? "Cloud Object Storage" : "Allocated Disk Space"}
            text={formatBackupBytes(location.bytes)}
          />
          <M.Label title="Role" text={location.group} />
          <M.Label
            title="Location Type"
            text={
              location.kind === "local"
                ? "Server filesystem"
                : location.kind === "ssh"
                  ? "Remote filesystem"
                  : "Cloud objects"
            }
          />
          {location.repoId && (
            <M.Label title="Repository" text={location.repoId} />
          )}
          {location.objectCount !== undefined && (
            <M.Label
              title="Objects"
              text={location.objectCount.toLocaleString()}
            />
          )}
          <M.Label title="Measured" text={dateLabel(collectedAt)} />
        </M>
      }
    />
  );
}

export default function Backups() {
  const configured = Boolean(optionalUrl("backrestUrl"));
  const storageConfigured = hasBackupStorageHost();
  const health = useCachedPromise(
    async (connectionKey: string) => {
      void connectionKey; // Partition cached snapshots by Backrest connection.
      return loadBackupHealth();
    },
    [backupConnectionKey()],
    {
      execute: configured,
      keepPreviousData: false,
      onError: () => {
        /* Keep failures visible in the view. */
      },
    },
  );
  const storage = useCachedPromise(
    loadBackupStorage,
    [backupStorageConnectionKey()],
    {
      execute: storageConfigured,
      keepPreviousData: false,
      onError: () => {
        /* Keep failures visible in the view. */
      },
    },
  );
  useEffect(() => {
    if (!configured) return;
    const timer = setInterval(() => void health.revalidate(), HEALTH_POLL_MS);
    return () => clearInterval(timer);
  }, [configured, health.revalidate]);

  function refresh() {
    if (configured) void health.revalidate();
    if (storageConfigured) void storage.revalidate();
  }

  const snapshot = configured ? health.data : undefined;
  const usage = storageConfigured ? storage.data : undefined;
  const stale = Boolean(
    snapshot &&
    (health.error ||
      health.isLoading ||
      Date.now() - snapshot.fetchedAt > HEALTH_POLL_MS * 2),
  );
  const storageStale = Boolean(
    usage &&
    (storage.error ||
      storage.isLoading ||
      Date.now() - Date.parse(usage.collectedAt) > 10 * 60_000),
  );
  const partialStorage = Boolean(
    usage &&
    (usage.measuredLocations < usage.totalLocations || usage.errors.length),
  );
  const attention = Boolean(
    snapshot &&
    (snapshot.warnings.length ||
      [...snapshot.plans, ...snapshot.repositories].some(
        (item) => item.health.attention,
      )),
  );
  const status = !configured
    ? "Backrest Is Not Configured"
    : health.error
      ? snapshot
        ? "Backup Health Unavailable — Cached Snapshot"
        : "Backup Health Unavailable"
      : stale
        ? "Backup Health — Cached Snapshot"
        : snapshot
          ? backupSummary(snapshot)
          : "Loading Backup Health…";
  const plans = [...(snapshot?.plans ?? [])].sort(
    (a, b) =>
      ORDER[a.health.level] - ORDER[b.health.level] || a.id.localeCompare(b.id),
  );
  const repos = [...(snapshot?.repositories ?? [])].sort(
    (a, b) =>
      ORDER[a.health.level] - ORDER[b.health.level] || a.id.localeCompare(b.id),
  );
  const actions = (
    <ActionPanel>
      <CommonActions refresh={refresh} />
    </ActionPanel>
  );
  const hasDisk = usage?.locations.some(
    (location) =>
      location.kind !== "rclone" &&
      location.group !== "staging" &&
      location.bytes !== undefined,
  );
  const hasCloud = usage?.locations.some(
    (location) =>
      location.kind === "rclone" &&
      location.group !== "staging" &&
      location.bytes !== undefined,
  );
  const hasStaging = usage?.locations.some(
    (location) => location.group === "staging" && location.bytes !== undefined,
  );

  return (
    <List
      navigationTitle="Backup Health"
      isLoading={health.isLoading || storage.isLoading}
      isShowingDetail
      searchBarPlaceholder="Search plans, repositories, or backup copies…"
    >
      <List.EmptyView
        title="No Matching Backups"
        description="Try another search or refresh the backup inventory."
        actions={actions}
      />
      <List.Section title="Overview">
        <List.Item
          id="backup-summary"
          title={status}
          icon={{
            source:
              health.error || attention || stale
                ? Icon.Warning
                : Icon.HardDrive,
            tintColor: health.error
              ? Color.Red
              : attention || stale
                ? Color.Orange
                : snapshot
                  ? Color.Green
                  : Color.SecondaryText,
          }}
          accessories={
            stale ? [{ tag: { value: "Cached", color: Color.Orange } }] : []
          }
          detail={
            <List.Item.Detail
              markdown={[
                `## ${markdownText(status)}`,
                !configured
                  ? "Configure the Backrest URL and credentials in extension preferences to see backup freshness and verification."
                  : health.error
                    ? markdownText(health.error.message)
                    : "Backup health refreshes every minute while this view is open. Storage is measured when you open this command or choose Refresh.",
                stale
                  ? "**The displayed health snapshot has not been verified as current.**"
                  : "",
                ...(snapshot?.warnings ?? []).map(
                  (warning) => `**Warning:** ${markdownText(warning)}`,
                ),
                "Raw data is Backrest's cached deduplicated repository statistic. Actual disk allocation, cloud copies and staging are reported separately under Backup Storage. Unknown sizes are excluded from subtotals.",
              ]
                .filter(Boolean)
                .join("\n\n")}
              metadata={
                snapshot ? (
                  <M>
                    <M.Label
                      title="Health Retrieved"
                      text={dateLabel(snapshot.fetchedAt)}
                    />
                    <M.Label
                      title="Configured Plans"
                      text={String(snapshot.plans.length)}
                    />
                    <M.Label
                      title="Configured Repositories"
                      text={String(snapshot.repositories.length)}
                    />
                    <M.Label
                      title="Raw Data Subtotal (Cached)"
                      text={formatBackupBytes(snapshot.totalStoredBytes)}
                    />
                    <M.Label
                      title="Raw Data Coverage"
                      text={`${snapshot.measuredRepositoryCount} of ${snapshot.repositories.length} repositories`}
                    />
                  </M>
                ) : undefined
              }
            />
          }
          actions={actions}
        />
      </List.Section>
      <List.Section
        title="Backup Storage"
        subtitle={
          usage
            ? `${usage.measuredLocations}/${usage.totalLocations} locations measured`
            : undefined
        }
      >
        <List.Item
          id="storage-summary"
          title={
            !storageConfigured
              ? "Storage Measurement Is Not Configured"
              : storage.error
                ? "Storage Measurement Unavailable"
                : usage
                  ? usage.totalLocations === 0
                    ? "No Backup Storage Locations Configured"
                    : partialStorage
                      ? "Measured Storage Subtotals — Partial Coverage"
                      : "Measured Storage Totals"
                  : "Measuring Backup Storage…"
          }
          icon={{
            source: Icon.HardDrive,
            tintColor: storage.error
              ? Color.Red
              : partialStorage || storageStale
                ? Color.Orange
                : Color.SecondaryText,
          }}
          accessories={[
            ...(usage
              ? [
                  {
                    text: `${formatBackupBytes(hasDisk ? usage.diskBytes : undefined)} disk · ${formatBackupBytes(hasCloud ? usage.cloudBytes : undefined)} cloud`,
                  },
                ]
              : []),
            ...(storageStale
              ? [{ tag: { value: "Cached", color: Color.Orange } }]
              : []),
          ]}
          detail={
            <List.Item.Detail
              markdown={[
                "## Backup Storage",
                !storageConfigured
                  ? "Set the Services SSH Host preference and configure the server's backup storage inventory as described in the README to measure repositories, replicas and staging directories."
                  : storage.error
                    ? markdownText(storage.error.message)
                    : "Disk totals include measured repository and replica allocation. Cloud totals include current object bytes. Staging is separate. These totals do not include the raw-data statistic above.",
                partialStorage
                  ? "**Some locations are offline or could not be measured. The displayed totals cover only measured locations; unknown sizes are not zero.**"
                  : "",
                storageStale
                  ? "**The displayed storage measurement is cached. Refresh to measure it again.**"
                  : "",
                ...(usage?.errors ?? []).map(
                  (error) => `**Measurement warning:** ${markdownText(error)}`,
                ),
              ]
                .filter(Boolean)
                .join("\n\n")}
              metadata={
                usage ? (
                  <M>
                    <M.Label
                      title="Allocated Disk Subtotal"
                      text={formatBackupBytes(
                        hasDisk ? usage.diskBytes : undefined,
                      )}
                    />
                    <M.Label
                      title="Cloud Objects Subtotal"
                      text={formatBackupBytes(
                        hasCloud ? usage.cloudBytes : undefined,
                      )}
                    />
                    <M.Label
                      title="Staging (Separate)"
                      text={formatBackupBytes(
                        hasStaging ? usage.stagingBytes : undefined,
                      )}
                    />
                    <M.Label
                      title="Coverage"
                      text={`${usage.measuredLocations} of ${usage.totalLocations} locations`}
                    />
                    <M.Label
                      title="Measured"
                      text={dateLabel(usage.collectedAt)}
                    />
                  </M>
                ) : undefined
              }
            />
          }
          actions={actions}
        />
        {usage?.locations.map((location) => (
          <List.Item
            key={`location-${location.id}`}
            title={location.label}
            keywords={[
              location.group,
              location.kind,
              location.repoId ?? "",
              location.status,
            ]}
            icon={{
              source:
                location.status === "ok"
                  ? location.kind === "rclone"
                    ? Icon.Cloud
                    : Icon.HardDrive
                  : Icon.Warning,
              tintColor:
                location.status === "ok"
                  ? Color.SecondaryText
                  : location.status === "offline"
                    ? Color.Orange
                    : Color.Red,
            }}
            accessories={[
              { text: formatBackupBytes(location.bytes) },
              {
                tag: {
                  value:
                    location.status === "ok"
                      ? location.group === "staging"
                        ? "Staging"
                        : location.kind === "rclone"
                          ? "Cloud"
                          : "Disk"
                      : location.status,
                  color:
                    location.status === "ok"
                      ? Color.SecondaryText
                      : Color.Orange,
                },
              },
              ...(storageStale
                ? [{ tag: { value: "Cached", color: Color.Orange } }]
                : []),
            ]}
            detail={
              <LocationDetail
                location={location}
                collectedAt={usage.collectedAt}
                stale={storageStale}
              />
            }
            actions={actions}
          />
        ))}
      </List.Section>
      <List.Section title="Plans" subtitle={`${plans.length} configured`}>
        {plans.map((plan) => (
          <List.Item
            key={`plan-${plan.id}`}
            title={plan.id}
            keywords={[plan.repoId, plan.health.label, plan.schedule]}
            icon={{
              source: plan.health.attention ? Icon.Warning : Icon.Clock,
              tintColor: COLORS[plan.health.level],
            }}
            accessories={[
              {
                tag: {
                  value: plan.health.label,
                  color: COLORS[plan.health.level],
                },
              },
              ...(stale ? [{ text: "Cached" }] : []),
            ]}
            detail={<PlanDetail plan={plan} stale={stale} />}
            actions={actions}
          />
        ))}
        {snapshot && !plans.length && (
          <List.Item
            title="No Backup Plans Configured"
            icon={Icon.Info}
            detail={
              <List.Item.Detail markdown="Backrest returned no configured backup plans." />
            }
            actions={actions}
          />
        )}
      </List.Section>
      <List.Section
        title="Repositories"
        subtitle={`${repos.length} configured`}
      >
        {repos.map((repo) => (
          <List.Item
            key={`repo-${repo.id}`}
            title={repo.id}
            keywords={[repo.health.label, repo.checkMode]}
            icon={{
              source: repo.health.attention ? Icon.Warning : Icon.HardDrive,
              tintColor: COLORS[repo.health.level],
            }}
            accessories={[
              { text: `${formatBackupBytes(repo.storedBytes)} raw (cached)` },
              {
                tag: {
                  value: repo.health.label,
                  color: COLORS[repo.health.level],
                },
              },
              ...(stale ? [{ text: "Cached" }] : []),
            ]}
            detail={<RepositoryDetail repo={repo} stale={stale} />}
            actions={actions}
          />
        ))}
        {snapshot && !repos.length && (
          <List.Item
            title="No Backup Repositories Configured"
            icon={Icon.Info}
            detail={
              <List.Item.Detail markdown="Backrest returned no configured repositories." />
            }
            actions={actions}
          />
        )}
      </List.Section>
    </List>
  );
}
