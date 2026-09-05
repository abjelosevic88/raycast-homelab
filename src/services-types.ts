export type UnitScope = "user" | "system";

export interface UnitState {
  scope: UnitScope;
  unit: string;
  description: string;
  loadState: string;
  activeState: string;
  subState: string;
  unitFileState: string;
}

export interface ServiceUnit extends UnitState {
  type: string;
  result: string;
  exitCode: number | null;
  startedAt: string | null;
  finishedAt: string | null;
  restartCount: number;
  triggeredBy: string[];
  conditionResult: boolean | null;
  assertResult: boolean | null;
}

export interface TimerUnit extends UnitState {
  service: string | null;
  lastTriggerAt: string | null;
  nextRunAt: string | null;
  schedule: string[];
  persistent: boolean;
  accuracySeconds: number;
  serviceStatus: ServiceUnit | null;
}

export interface ServicesSnapshot {
  version: 1;
  host: string;
  collectedAt: string;
  services: ServiceUnit[];
  timers: TimerUnit[];
  errors: { scope: UnitScope; error: string }[];
}

export interface UnitLogs {
  scope: UnitScope;
  unit: string;
  collectedAt: string;
  text: string;
  warning: string | null;
}

export interface UnitHealth {
  label: string;
  level: "ok" | "info" | "warning" | "error";
  attention: boolean;
  detail: string;
}
