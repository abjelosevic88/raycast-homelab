import {
  Action,
  ActionPanel,
  Color,
  Detail,
  Icon,
  Keyboard,
  List,
  openExtensionPreferences,
} from "@raycast/api";
import { useCachedState, usePromise } from "@raycast/utils";
import { useCallback, useEffect, useRef, useState } from "react";
import NotConfigured from "./not-configured";
import {
  hasServicesHost,
  loadServices,
  loadUnitLogs,
  serviceHealth,
  servicesConnectionKey,
  timerHealth,
} from "./services-api";
import {
  ServicesSnapshot,
  ServiceUnit,
  TimerUnit,
  UnitHealth,
  UnitScope,
  UnitState,
} from "./services-types";

const POLL_MS = 30_000;
const HEALTH_COLORS: Record<UnitHealth["level"], Color> = {
  ok: Color.Green,
  info: Color.SecondaryText,
  warning: Color.Orange,
  error: Color.Red,
};
const HEALTH_ORDER: Record<UnitHealth["level"], number> = {
  error: 0,
  warning: 1,
  info: 2,
  ok: 3,
};
const VIEWS = [
  ["all", "All"],
  ["attention", "Needs Attention"],
  ["services", "Services"],
  ["jobs", "Jobs"],
] as const;

function markdownText(value: string): string {
  return value.replace(/[\\`*_{}[\]()<>#+.!|~-]/g, "\\$&");
}

function dateLabel(value: string | null): string {
  if (!value) return "Not recorded";
  const date = new Date(value);
  return Number.isFinite(date.getTime())
    ? date.toLocaleString(undefined, { timeZoneName: "short" })
    : "Unavailable";
}

function scopeLabel(scope: UnitScope): string {
  return scope === "user" ? "User" : "System";
}

function CommonActions({ refresh }: { refresh: () => void }) {
  return (
    <>
      <Action
        title="Refresh"
        icon={Icon.ArrowClockwise}
        shortcut={Keyboard.Shortcut.Common.Refresh}
        onAction={refresh}
      />
      <Action
        title="Configure Extension"
        icon={Icon.Gear}
        onAction={openExtensionPreferences}
      />
    </>
  );
}

function RecentLogs({ scope, unit }: { scope: UnitScope; unit: string }) {
  const { data, error, isLoading, revalidate } = usePromise(
    loadUnitLogs,
    [scope, unit],
    {
      onError: () => {
        /* The error stays visible in the detail view. */
      },
    },
  );
  const message = error
    ? `**Could not load recent logs:** ${markdownText(error.message)}\n\n${data ? "The logs below are from the previous request.\n\n" : ""}`
    : "";
  const warning = data?.warning
    ? `**Journal warning:** ${markdownText(data.warning)}\n\n`
    : "";
  const logs = data?.text
    ? data.text
        .split("\n")
        .map((line) => `    ${line}`)
        .join("\n")
    : isLoading
      ? "Loading recent journal entries…"
      : error
        ? ""
        : "No journal entries returned.";

  return (
    <Detail
      navigationTitle={`${unit} Logs`}
      isLoading={isLoading}
      markdown={`# ${markdownText(unit)}\n\n${message}${warning}${logs}`}
      metadata={
        <Detail.Metadata>
          <Detail.Metadata.Label title="Scope" text={scopeLabel(scope)} />
          <Detail.Metadata.Label title="Unit" text={unit} />
          {data && (
            <Detail.Metadata.Label
              title="Collected"
              text={dateLabel(data.collectedAt)}
            />
          )}
        </Detail.Metadata>
      }
      actions={
        <ActionPanel>
          <CommonActions refresh={revalidate} />
          {data?.text && (
            <Action.CopyToClipboard title="Copy Logs" content={data.text} />
          )}
        </ActionPanel>
      }
    />
  );
}

function UnitDetail({
  unit,
  health,
  snapshot,
  stale,
  timer,
}: {
  unit: UnitState;
  health: UnitHealth;
  snapshot: ServicesSnapshot;
  stale: boolean;
  timer?: TimerUnit;
}) {
  const service = timer ? timer.serviceStatus : (unit as ServiceUnit);
  const M = List.Item.Detail.Metadata;
  return (
    <List.Item.Detail
      markdown={`## ${markdownText(unit.description || unit.unit)}\n\n${markdownText(health.detail)}${stale ? "\n\n**Cached or outdated snapshot. Refresh to verify the current state.**" : ""}${snapshot.errors.length ? "\n\n**Some server data could not be read. See Connection for details.**" : ""}`}
      metadata={
        <M>
          <M.TagList title="Status">
            <M.TagList.Item
              text={health.label}
              color={HEALTH_COLORS[health.level]}
            />
          </M.TagList>
          <M.Label title="Scope" text={scopeLabel(unit.scope)} />
          <M.Label title="Unit" text={unit.unit} />
          <M.Label
            title="State"
            text={`${unit.activeState} / ${unit.subState}`}
          />
          <M.Label title="Loaded" text={unit.loadState || "Unknown"} />
          <M.Label
            title="Enabled State"
            text={unit.unitFileState || "Unknown"}
          />
          {timer && (
            <>
              <M.Separator />
              <M.Label title="Next Run" text={dateLabel(timer.nextRunAt)} />
              <M.Label
                title="Last Trigger"
                text={dateLabel(timer.lastTriggerAt)}
              />
              <M.Label
                title="Schedule"
                text={timer.schedule.join("; ") || "Not available"}
              />
              <M.Label
                title="Persistent"
                text={timer.persistent ? "Yes" : "No"}
              />
              <M.Label
                title="Scheduling Accuracy"
                text={`${timer.accuracySeconds}s`}
              />
              <M.Label
                title="Job Service"
                text={timer.service || "Not available"}
              />
            </>
          )}
          <M.Separator />
          {service ? (
            <>
              {timer && (
                <M.Label
                  title="Service State"
                  text={`${service.activeState} / ${service.subState}`}
                />
              )}
              <M.Label title="Service Type" text={service.type || "Unknown"} />
              {service.conditionResult !== null && (
                <M.Label
                  title="Last Condition Check"
                  text={
                    service.conditionResult
                      ? "Passed"
                      : "Not met — execution skipped"
                  }
                />
              )}
              {service.assertResult !== null && (
                <M.Label
                  title="Last Assertion Check"
                  text={service.assertResult ? "Passed" : "Failed"}
                />
              )}
              <M.Label
                title="Last Execution Result"
                text={
                  !service.result ||
                  (service.result === "success" &&
                    !service.startedAt &&
                    !service.finishedAt)
                    ? "Not recorded"
                    : service.result
                }
              />
              <M.Label
                title="Exit Code"
                text={
                  service.exitCode === null
                    ? "Not recorded"
                    : String(service.exitCode)
                }
              />
              <M.Label title="Last Start" text={dateLabel(service.startedAt)} />
              <M.Label
                title="Last Completion"
                text={dateLabel(service.finishedAt)}
              />
              <M.Label
                title="Restart Count"
                text={String(service.restartCount)}
              />
            </>
          ) : (
            <M.Label title="Service Status" text="Unavailable" />
          )}
          <M.Separator />
          <M.Label title="Host" text={snapshot.host} />
          <M.Label title="Snapshot" text={dateLabel(snapshot.collectedAt)} />
        </M>
      }
    />
  );
}

function ConfiguredServices({ connectionKey }: { connectionKey: string }) {
  const [snapshot, setSnapshot] = useCachedState<ServicesSnapshot | null>(
    `services-snapshot-v1-${connectionKey}`,
    null,
  );
  const [isLoading, setIsLoading] = useState(true);
  const [verified, setVerified] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [search, setSearch] = useState("");
  const [filter, setFilter] = useState("all:all");
  const mounted = useRef(false);
  const inFlight = useRef(false);

  const refresh = useCallback(async () => {
    if (!mounted.current || inFlight.current) return;
    inFlight.current = true;
    setIsLoading(true);
    try {
      const next = await loadServices();
      if (mounted.current) {
        setSnapshot(next);
        setVerified(true);
        setError(null);
      }
    } catch (failure) {
      if (mounted.current) {
        setError(failure instanceof Error ? failure.message : String(failure));
      }
    } finally {
      inFlight.current = false;
      if (mounted.current) setIsLoading(false);
    }
  }, [setSnapshot]);

  useEffect(() => {
    mounted.current = true;
    void refresh();
    const timer = setInterval(() => {
      void refresh();
    }, POLL_MS);
    return () => {
      mounted.current = false;
      clearInterval(timer);
    };
  }, [refresh]);

  const stale =
    !verified ||
    Boolean(error) ||
    Boolean(
      snapshot &&
      Date.now() - new Date(snapshot.collectedAt).getTime() > POLL_MS * 3,
    );
  const [scope, view] = filter.split(":");
  const tokens = search.trim().toLowerCase().split(/\s+/).filter(Boolean);
  const timerServices = new Set(
    (snapshot?.timers ?? [])
      .filter((timer) => timer.service)
      .map((timer) => `${timer.scope}:${timer.service}`),
  );
  const matches = (unit: UnitState, health: UnitHealth, extra = "") => {
    const text =
      `${unit.unit} ${unit.description} ${unit.scope} ${health.label} ${extra}`.toLowerCase();
    return (
      (scope === "all" || unit.scope === scope) &&
      (view !== "attention" || health.attention) &&
      tokens.every((token) => text.includes(token))
    );
  };
  const sortUnits = <T extends { unit: UnitState; health: UnitHealth }>(
    a: T,
    b: T,
  ) =>
    HEALTH_ORDER[a.health.level] - HEALTH_ORDER[b.health.level] ||
    a.unit.unit.localeCompare(b.unit.unit) ||
    a.unit.scope.localeCompare(b.unit.scope);
  const services =
    view === "jobs"
      ? []
      : (snapshot?.services ?? [])
          .filter(
            (unit) =>
              !timerServices.has(`${unit.scope}:${unit.unit}`) &&
              !unit.triggeredBy.some((trigger) => trigger.endsWith(".timer")),
          )
          .map((unit) => ({ unit, health: serviceHealth(unit) }))
          .filter(({ unit, health }) => matches(unit, health))
          .sort(sortUnits);
  const jobs =
    view === "services"
      ? []
      : (snapshot?.timers ?? [])
          .map((unit) => ({
            unit,
            health: timerHealth(
              unit,
              snapshot ? Date.parse(snapshot.collectedAt) : Date.now(),
            ),
          }))
          .filter(({ unit, health }) =>
            matches(unit, health, unit.service ?? ""),
          )
          .sort(sortUnits);
  const attention: {
    unit: ServiceUnit | TimerUnit;
    health: UnitHealth;
    timer?: TimerUnit;
  }[] = [...services, ...jobs.map((item) => ({ ...item, timer: item.unit }))]
    .filter(({ health }) => health.attention)
    .sort(sortUnits);
  const otherServices = services.filter(({ health }) => !health.attention);
  const otherJobs = jobs.filter(({ health }) => !health.attention);
  const partial = Boolean(snapshot?.errors.length);
  const status = error
    ? snapshot
      ? "Connection Failed — Showing Last Snapshot"
      : "Connection Failed"
    : !snapshot
      ? "Connecting…"
      : !verified
        ? "Cached Snapshot — Checking Connection…"
        : stale
          ? "Snapshot Is Out of Date"
          : partial
            ? "Connected — Some Data Is Unavailable"
            : "Connected";
  const statusColor = error
    ? Color.Red
    : stale || partial
      ? Color.Orange
      : Color.Green;
  const statusMarkdown = [
    `## ${status}`,
    error
      ? markdownText(error)
      : "Refreshes automatically every 30 seconds while this view is open.",
    snapshot
      ? `Snapshot from **${markdownText(snapshot.host)}**, collected **${markdownText(dateLabel(snapshot.collectedAt))}**.`
      : "Waiting for a server snapshot.",
    stale && snapshot
      ? "**The displayed snapshot has not been verified as current.**"
      : "",
    ...(snapshot?.errors ?? []).map(
      (failure) =>
        `**${scopeLabel(failure.scope)} data:** ${markdownText(failure.error)}`,
    ),
  ]
    .filter(Boolean)
    .join("\n\n");

  function unitItem(
    unit: ServiceUnit | TimerUnit,
    health: UnitHealth,
    timer?: TimerUnit,
  ) {
    const logUnit = timer?.service || unit.unit;
    return (
      <List.Item
        key={`${unit.scope}:${unit.unit}`}
        id={`${unit.scope}:${unit.unit}`}
        icon={{
          source: timer ? Icon.Clock : Icon.Gear,
          tintColor: HEALTH_COLORS[health.level],
        }}
        title={unit.unit}
        accessories={[
          { text: scopeLabel(unit.scope) },
          { tag: { value: health.label, color: HEALTH_COLORS[health.level] } },
        ]}
        detail={
          snapshot ? (
            <UnitDetail
              unit={unit}
              health={health}
              snapshot={snapshot}
              stale={stale}
              timer={timer}
            />
          ) : undefined
        }
        actions={
          <ActionPanel>
            <Action.Push
              title="View Recent Logs"
              icon={Icon.Document}
              target={<RecentLogs scope={unit.scope} unit={logUnit} />}
            />
            {timer?.service && (
              <Action.Push
                title="View Timer Logs"
                icon={Icon.Clock}
                target={<RecentLogs scope={unit.scope} unit={unit.unit} />}
              />
            )}
            <Action.CopyToClipboard
              title="Copy Unit Name"
              content={unit.unit}
            />
            <CommonActions refresh={refresh} />
          </ActionPanel>
        }
      />
    );
  }

  return (
    <List
      isLoading={isLoading}
      isShowingDetail
      filtering={false}
      onSearchTextChange={setSearch}
      searchBarPlaceholder="Search units, descriptions, or scope…"
      searchBarAccessory={
        <List.Dropdown
          tooltip="View and Scope"
          value={filter}
          onChange={setFilter}
        >
          {(["all", "user", "system"] as const).map((unitScope) => (
            <List.Dropdown.Section
              key={unitScope}
              title={unitScope === "all" ? "All Scopes" : scopeLabel(unitScope)}
            >
              {VIEWS.map(([value, label]) => (
                <List.Dropdown.Item
                  key={`${unitScope}:${value}`}
                  title={`${label}${unitScope === "all" ? "" : ` · ${scopeLabel(unitScope)}`}`}
                  value={`${unitScope}:${value}`}
                />
              ))}
            </List.Dropdown.Section>
          ))}
        </List.Dropdown>
      }
    >
      <List.Section title="Connection">
        <List.Item
          id="connection"
          title={status}
          icon={{
            source: error || partial || stale ? Icon.Warning : Icon.CheckCircle,
            tintColor: statusColor,
          }}
          accessories={
            snapshot ? [{ text: dateLabel(snapshot.collectedAt) }] : []
          }
          detail={<List.Item.Detail markdown={statusMarkdown} />}
          actions={
            <ActionPanel>
              <CommonActions refresh={refresh} />
            </ActionPanel>
          }
        />
      </List.Section>
      {attention.length > 0 && (
        <List.Section
          title="Needs Attention"
          subtitle={`${attention.length} units`}
        >
          {attention.map(({ unit, health, timer }) =>
            unitItem(unit, health, timer),
          )}
        </List.Section>
      )}
      {otherServices.length > 0 && (
        <List.Section
          title="Services"
          subtitle={`${otherServices.length} units`}
        >
          {otherServices.map(({ unit, health }) => unitItem(unit, health))}
        </List.Section>
      )}
      {otherJobs.length > 0 && (
        <List.Section title="Jobs" subtitle={`${otherJobs.length} timers`}>
          {otherJobs.map(({ unit, health }) => unitItem(unit, health, unit))}
        </List.Section>
      )}
      {snapshot && !services.length && !jobs.length && (
        <List.Item
          title={
            view === "attention" && !search && !stale && !partial
              ? "No Units Need Attention"
              : "No Matching Units in This Snapshot"
          }
          icon={Icon.MagnifyingGlass}
          detail={
            <List.Item.Detail markdown="Change the view, scope, or search text to see other units. Timer-backed services appear under Jobs." />
          }
          actions={
            <ActionPanel>
              <CommonActions refresh={refresh} />
            </ActionPanel>
          }
        />
      )}
    </List>
  );
}

export default function Services() {
  if (!hasServicesHost()) {
    return (
      <List>
        <NotConfigured service="Services & Jobs" needs="SSH host" />
      </List>
    );
  }
  const connectionKey = servicesConnectionKey();
  return (
    <ConfiguredServices key={connectionKey} connectionKey={connectionKey} />
  );
}
