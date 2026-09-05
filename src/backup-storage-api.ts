import {
  collectBackupStorage,
  hasServicesHost,
  servicesConnectionKey,
} from "./services-api";
import {
  BackupStorageLocation,
  BackupStorageSnapshot,
} from "./backup-storage-types";

export const hasBackupStorageHost = hasServicesHost;
export const backupStorageConnectionKey = servicesConnectionKey;

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
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
  const locations = data.locations;
  const measured = locations.filter((entry) => entry.status === "ok");
  const sum = (entries: BackupStorageLocation[]) =>
    entries.reduce((total, entry) => total + (entry.bytes ?? 0), 0);
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
