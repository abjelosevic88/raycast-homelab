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
