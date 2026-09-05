import {
  collectBackupStorage,
  collectBackupStorageBreakdown,
  hasServicesHost,
  servicesConnectionKey,
} from "./services-api";
import {
  BackupStorageBreakdown,
  BackupStorageEntry,
  BackupStorageLocation,
  BackupStorageSnapshot,
} from "./backup-storage-types";

export const hasBackupStorageHost = hasServicesHost;
export const backupStorageConnectionKey = servicesConnectionKey;

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function safeText(value: unknown, max: number): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= max &&
    !Array.from(value).some(
      (char) => char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127,
    )
  );
}

function relativePath(value: unknown): value is string {
  return (
    value === "" ||
    (safeText(value, 2048) &&
      !value.includes("\\") &&
      value.split("/").every((part) => part && part !== "." && part !== ".."))
  );
}

function entry(value: unknown, parent: string): value is BackupStorageEntry {
  if (!record(value)) return false;
  return (
    safeText(value.name, 512) &&
    !value.name.includes("/") &&
    relativePath(value.relativePath) &&
    value.relativePath === (parent ? `${parent}/${value.name}` : value.name) &&
    ["directory", "file", "symlink"].includes(String(value.kind)) &&
    (value.bytes === undefined || size(value.bytes)) &&
    (value.objectCount === undefined || size(value.objectCount))
  );
}

/** Browse only a configured backup destination. Absolute paths never cross SSH. */
export async function loadBackupStorageBreakdown(
  connectionKey: string,
  locationId: string,
  path = "",
): Promise<BackupStorageBreakdown> {
  if (connectionKey !== servicesConnectionKey())
    throw new Error("Backup storage connection changed. Reopen Space Usage.");
  if (!safeText(locationId, 512) || !relativePath(path))
    throw new Error(
      "Invalid backup destination or folder. Reopen Space Usage.",
    );
  const data = await collectBackupStorageBreakdown(locationId, path);
  if (
    record(data) &&
    data.location === undefined &&
    strings(data.errors) &&
    data.errors.length
  ) {
    // A removed destination or missing inventory has no location metadata.
    // Surface known collector diagnostics without echoing arbitrary server text.
    const inventoryErrors = new Set([
      "Backup storage configuration is unavailable on the server.",
      "Backup storage location is not configured on the server.",
    ]);
    throw new Error(
      inventoryErrors.has(data.errors[0])
        ? data.errors[0]
        : "Backup storage inventory is unavailable. Check its configuration on the Services SSH server.",
    );
  }
  if (
    !record(data) ||
    !location(data.location) ||
    data.location.id !== locationId ||
    data.relativePath !== path ||
    typeof data.collectedAt !== "string" ||
    !Number.isFinite(Date.parse(data.collectedAt)) ||
    typeof data.truncated !== "boolean" ||
    !strings(data.errors) ||
    !Array.isArray(data.entries) ||
    data.entries.length > 200 ||
    !data.entries.every((value) => entry(value, path)) ||
    new Set(data.entries.map((value) => value.relativePath)).size !==
      data.entries.length ||
    (data.totalBytes !== undefined && !size(data.totalBytes)) ||
    (data.otherBytes !== undefined && !size(data.otherBytes))
  )
    throw new Error(
      "The backup storage collector returned an invalid folder breakdown.",
    );

  // Keep unknown measurements unknown and reject inconsistent totals rather
  // than displaying percentages that suggest complete accounting.
  const knownBytes = data.entries.reduce(
    (sum, item) => sum + (item.bytes ?? 0),
    0,
  );
  if (
    !Number.isSafeInteger(knownBytes) ||
    (data.totalBytes !== undefined &&
      (knownBytes > data.totalBytes ||
        (data.otherBytes !== undefined &&
          knownBytes + data.otherBytes !== data.totalBytes))) ||
    (data.totalBytes === undefined && data.otherBytes !== undefined) ||
    (data.location.status !== "ok" &&
      (data.totalBytes !== undefined || data.entries.length > 0))
  )
    throw new Error(
      "The backup folder sizes are inconsistent. Refresh Space Usage.",
    );

  // Only display fields enter the persistent client cache. Server paths and
  // rclone configuration are never part of this public response.
  return {
    collectedAt: data.collectedAt,
    location: publicLocation(data.location),
    relativePath: path,
    entries: data.entries
      .map((item) => ({
        name: item.name,
        relativePath: item.relativePath,
        kind: item.kind,
        bytes: item.bytes,
        objectCount: item.objectCount,
      }))
      .sort(
        (a, b) =>
          (b.bytes ?? -1) - (a.bytes ?? -1) || a.name.localeCompare(b.name),
      ),
    totalBytes: data.totalBytes,
    otherBytes: data.otherBytes,
    truncated: data.truncated,
    errors: data.errors,
  };
}

function strings(value: unknown): value is string[] {
  return (
    Array.isArray(value) && value.every((entry) => typeof entry === "string")
  );
}

function size(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function location(value: unknown): value is BackupStorageLocation {
  if (!record(value)) return false;
  return (
    typeof value.id === "string" &&
    typeof value.label === "string" &&
    (value.repoId === undefined || typeof value.repoId === "string") &&
    ["local", "ssh", "rclone"].includes(String(value.kind)) &&
    ["repository", "replica", "staging"].includes(String(value.group)) &&
    ["ok", "offline", "error"].includes(String(value.status)) &&
    (value.status === "ok" ? size(value.bytes) : value.bytes === undefined) &&
    (value.objectCount === undefined || size(value.objectCount)) &&
    (value.error === undefined || typeof value.error === "string")
  );
}

function publicLocation(source: BackupStorageLocation): BackupStorageLocation {
  return {
    id: source.id,
    label: source.label,
    kind: source.kind,
    group: source.group,
    repoId: source.repoId,
    status: source.status,
    bytes: source.bytes,
    objectCount: source.objectCount,
    error: source.error,
  };
}

/** The connection key isolates Raycast's cache when SSH preferences change. */
export async function loadBackupStorage(
  connectionKey: string,
): Promise<BackupStorageSnapshot> {
  if (connectionKey !== servicesConnectionKey())
    throw new Error(
      "Backup storage connection changed. Refresh Backup Health.",
    );
  const data = await collectBackupStorage();
  if (
    !record(data) ||
    typeof data.collectedAt !== "string" ||
    !Number.isFinite(Date.parse(data.collectedAt)) ||
    !strings(data.errors) ||
    !Array.isArray(data.locations) ||
    !data.locations.every(location) ||
    new Set(data.locations.map((entry) => entry.id)).size !==
      data.locations.length
  )
    throw new Error(
      "The backup storage collector returned an invalid response.",
    );
  const locations = data.locations.map(publicLocation);
  const measured = locations.filter((entry) => entry.status === "ok");
  const sum = (entries: BackupStorageLocation[]) => {
    const total = entries.reduce(
      (bytes, entry) => bytes + (entry.bytes ?? 0),
      0,
    );
    if (!Number.isSafeInteger(total))
      throw new Error(
        "The backup storage total exceeds the supported size range.",
      );
    return total;
  };
  return {
    collectedAt: data.collectedAt,
    locations,
    errors: data.errors,
    diskBytes: sum(
      measured.filter(
        (entry) => entry.kind !== "rclone" && entry.group !== "staging",
      ),
    ),
    cloudBytes: sum(
      measured.filter(
        (entry) => entry.kind === "rclone" && entry.group !== "staging",
      ),
    ),
    stagingBytes: sum(measured.filter((entry) => entry.group === "staging")),
    measuredLocations: measured.length,
    totalLocations: locations.length,
  };
}
