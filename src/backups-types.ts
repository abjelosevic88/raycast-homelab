export type BackupLevel = "ok" | "info" | "warning" | "error";

export interface BackupStatus {
  label: string;
  level: BackupLevel;
  detail: string;
  attention: boolean;
}

export interface BackupRun {
  startedAt: number;
  finishedAt?: number;
  status: string;
}

export interface BackupPlan {
  id: string;
  repoId: string;
  health: BackupStatus;
  schedule: string;
  lastBackup?: BackupRun;
  lastSuccessAt?: number;
  nextRunAt?: number;
  latestSnapshotBytes?: number;
}

export interface BackupRepository {
  id: string;
  health: BackupStatus;
  storedBytes?: number;
  statsAt?: number;
  snapshotCount?: number;
  lastCheck?: BackupRun;
  lastSuccessfulCheckAt?: number;
  checkMode: string;
  nextCheckAt?: number;
}

export interface BackupHealthSnapshot {
  fetchedAt: number;
  plans: BackupPlan[];
  repositories: BackupRepository[];
  warnings: string[];
  totalStoredBytes?: number;
  measuredRepositoryCount: number;
}
