export type BackupStorageKind = "local" | "ssh" | "rclone";
export type BackupStorageGroup = "repository" | "replica" | "staging";
export type BackupStorageStatus = "ok" | "offline" | "error";

export interface BackupStorageLocation {
  id: string;
  label: string;
  repoId?: string;
  kind: BackupStorageKind;
  group: BackupStorageGroup;
  status: BackupStorageStatus;
  /** Filesystem allocated bytes for local/SSH, current object bytes for rclone. */
  bytes?: number;
  objectCount?: number;
  error?: string;
}

export interface BackupStorageSnapshot {
  collectedAt: string;
  locations: BackupStorageLocation[];
  errors: string[];
  /** Online repository and replica allocation, excluding cloud and staging. */
  diskBytes: number;
  cloudBytes: number;
  stagingBytes: number;
  measuredLocations: number;
  totalLocations: number;
}

export interface BackupStorageEntry {
  name: string;
  /** Relative to the configured location; never a server path or cloud URL. */
  relativePath: string;
  kind: "directory" | "file" | "symlink";
  bytes?: number;
  objectCount?: number;
}

export interface BackupStorageBreakdown {
  collectedAt: string;
  location: BackupStorageLocation;
  /** Empty at the root of this destination. */
  relativePath: string;
  entries: BackupStorageEntry[];
  totalBytes?: number;
  /** Space outside the displayed entries, including directory allocation. */
  otherBytes?: number;
  truncated: boolean;
  errors: string[];
}
