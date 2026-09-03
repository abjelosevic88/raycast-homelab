import { Action, ActionPanel, Color, Icon, Keyboard, List, showToast, Toast } from "@raycast/api";
import { useCachedPromise } from "@raycast/utils";
import { useEffect } from "react";
import {
  ADGUARD_URL,
  AdguardStats,
  fmtCount,
  hasAdguardCreds,
  loadAdguard,
  loadFilters,
  loadQueryLog,
  setProtection,
} from "./adguard-api";

const POLL_MS = 15000;

export const TOGGLE_SHORTCUT: Keyboard.Shortcut = { modifiers: ["cmd"], key: "t" };

// shared by the dashboard and the Home row
export async function toggleProtection(current: boolean | undefined, snoozeMinutes?: number): Promise<void> {
  const enable = current === false;
  try {
    await setProtection(enable, enable ? undefined : snoozeMinutes);
    await showToast({
      style: Toast.Style.Success,
      title: enable
        ? "AdGuard protection resumed"
        : snoozeMinutes
          ? `AdGuard paused for ${snoozeMinutes >= 60 ? `${snoozeMinutes / 60} h` : `${snoozeMinutes} min`}`
          : "AdGuard protection disabled",
    });
  } catch (e) {
    await showToast({ style: Toast.Style.Failure, title: "AdGuard", message: String(e instanceof Error ? e.message : e) });
  }
}

export function ProtectionActions(props: { stats?: AdguardStats; onDone: () => void }) {
  const on = props.stats?.protectionEnabled;
  return (
    <>
      <Action
        title={on ? "Pause Protection (10 Min)" : "Resume Protection"}
        icon={on ? Icon.Pause : Icon.Play}
        shortcut={TOGGLE_SHORTCUT}
        onAction={() => toggleProtection(on, 10).then(props.onDone)}
      />
      {on && (
        <ActionPanel.Submenu title="Pause for…" icon={Icon.Clock} shortcut={{ modifiers: ["cmd", "shift"], key: "t" }}>
          {[1, 10, 30, 60, 480].map((m) => (
            <Action
              key={m}
              title={m >= 60 ? `${m / 60} Hour${m > 60 ? "s" : ""}` : `${m} Minute${m > 1 ? "s" : ""}`}
              onAction={() => toggleProtection(true, m).then(props.onDone)}
            />
          ))}
          <Action title="Until Resumed Manually" icon={Icon.Stop} onAction={() => toggleProtection(true).then(props.onDone)} />
        </ActionPanel.Submenu>
      )}
    </>
  );
}

export default function AdGuard() {
  const hasCreds = hasAdguardCreds();
  const onError = (e: Error) => {
    void showToast({ style: Toast.Style.Failure, title: "AdGuard", message: e.message });
  };
  const stats = useCachedPromise(async (ok: boolean) => (ok ? await loadAdguard() : undefined), [hasCreds], {
    keepPreviousData: true,
    onError,
  });
  const log = useCachedPromise(async (ok: boolean) => (ok ? await loadQueryLog(30, true) : []), [hasCreds], {
    keepPreviousData: true,
    onError,
  });
  const filters = useCachedPromise(async (ok: boolean) => (ok ? await loadFilters() : undefined), [hasCreds], {
    keepPreviousData: true,
  });

  const refresh = () => {
    stats.revalidate();
    log.revalidate();
  };
  useEffect(() => {
    const t = setInterval(refresh, POLL_MS);
    return () => clearInterval(t);
  }, []);

  const s = stats.data;
  const actions = (
    <ActionPanel>
      <ProtectionActions stats={s} onDone={refresh} />
      <Action.OpenInBrowser title="Open AdGuard Home" url={ADGUARD_URL} shortcut={Keyboard.Shortcut.Common.Open} />
      <Action title="Refresh" icon={Icon.ArrowClockwise} shortcut={Keyboard.Shortcut.Common.Refresh} onAction={refresh} />
    </ActionPanel>
  );

  const pausedUntil =
    s?.disabledUntil && s.disabledUntil > Date.now()
      ? ` until ${new Date(s.disabledUntil).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}`
      : "";

  return (
    <List
      isLoading={stats.isLoading || log.isLoading}
      navigationTitle={s ? `AdGuard — ${s.protectionEnabled ? "ON" : "PAUSED"}` : "AdGuard"}
      searchBarPlaceholder="Filter…"
    >
      {!hasCreds && (
        <List.EmptyView
          icon={{ source: Icon.Key, tintColor: Color.Orange }}
          title="AdGuard login not set"
          description="⌘K → Configure Extension → AdGuard username + password"
        />
      )}
      {s && (
        <List.Section title="Protection">
          <List.Item
            icon={{ source: Icon.Shield, tintColor: s.protectionEnabled ? Color.Green : Color.Orange }}
            title={s.protectionEnabled ? "Protection ON" : `Protection PAUSED${pausedUntil}`}
            subtitle={`⌘T to ${s.protectionEnabled ? "pause 10 min" : "resume"} · ⌘⇧T pause for…`}
            accessories={[
              { tag: { value: s.protectionEnabled ? "filtering" : "bypassed", color: s.protectionEnabled ? Color.Green : Color.Orange } },
              { text: `v${s.version.replace(/^v/, "")}` },
            ]}
            actions={actions}
          />
          <List.Item
            icon={{ source: Icon.Globe, tintColor: Color.SecondaryText }}
            title="DNS"
            subtitle={s.dnsAddresses.join(" · ")}
            accessories={[{ text: `${s.avgMs.toFixed(1)} ms avg` }]}
            actions={actions}
          />
        </List.Section>
      )}
      {s && (
        <List.Section title={`Last 24 ${s.timeUnits}`}>
          <List.Item
            icon={{ source: Icon.BarChart, tintColor: Color.Blue }}
            title={`${fmtCount(s.queries)} queries`}
            accessories={[{ text: `${fmtCount(s.blocked)} blocked` }, { tag: { value: `${s.blockedPct.toFixed(1)}%`, color: Color.Red } }]}
            actions={actions}
          />
          {s.safeBrowsing > 0 && (
            <List.Item icon={{ source: Icon.Bug, tintColor: Color.Red }} title={`${fmtCount(s.safeBrowsing)} safe-browsing blocks`} actions={actions} />
          )}
        </List.Section>
      )}
      {s && s.topBlocked.length > 0 && (
        <List.Section title="Top Blocked Domains">
          {s.topBlocked.slice(0, 8).map((d) => (
            <List.Item
              key={`b-${d.name}`}
              icon={{ source: Icon.XMarkCircle, tintColor: Color.Red }}
              title={d.name}
              accessories={[{ text: fmtCount(d.count) }]}
              actions={
                <ActionPanel>
                  <Action.CopyToClipboard title="Copy Domain" content={d.name} />
                  <ProtectionActions stats={s} onDone={refresh} />
                  <Action.OpenInBrowser title="Open AdGuard Home" url={ADGUARD_URL} />
                </ActionPanel>
              }
            />
          ))}
        </List.Section>
      )}
      {s && s.topClients.length > 0 && (
        <List.Section title="Top Clients">
          {s.topClients.slice(0, 6).map((c) => (
            <List.Item
              key={`c-${c.name}`}
              icon={{
                source: c.label === "docker container" ? Icon.Box : c.label ? Icon.Devices : Icon.QuestionMarkCircle,
                tintColor: c.label && c.label !== "docker container" ? Color.Blue : Color.SecondaryText,
              }}
              title={c.label ?? c.name}
              subtitle={c.label ? c.name : undefined}
              accessories={[{ text: `${fmtCount(c.count)} queries` }]}
              actions={
                <ActionPanel>
                  <Action.CopyToClipboard title="Copy IP" content={c.name} />
                  <ProtectionActions stats={s} onDone={refresh} />
                  <Action.OpenInBrowser title="Open AdGuard Clients" url={`${ADGUARD_URL}/#clients`} />
                </ActionPanel>
              }
            />
          ))}
        </List.Section>
      )}
      {s && s.topQueried.length > 0 && (
        <List.Section title="Top Queried Domains">
          {s.topQueried.slice(0, 6).map((d) => (
            <List.Item
              key={`q-${d.name}`}
              icon={{ source: Icon.Globe, tintColor: Color.SecondaryText }}
              title={d.name}
              accessories={[{ text: fmtCount(d.count) }]}
              actions={actions}
            />
          ))}
        </List.Section>
      )}
      {(log.data?.length ?? 0) > 0 && (
        <List.Section title="Recently Blocked">
          {log.data?.map((e, i) => (
            <List.Item
              key={`l-${i}-${e.time}`}
              icon={{ source: Icon.MinusCircle, tintColor: Color.Red }}
              title={e.domain}
              subtitle={e.clientName ?? e.client}
              accessories={[
                ...(e.rule ? [{ tag: e.rule.length > 28 ? `${e.rule.slice(0, 28)}…` : e.rule, tooltip: e.rule }] : []),
                { text: new Date(e.time).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" }) },
              ]}
              actions={
                <ActionPanel>
                  <Action.CopyToClipboard title="Copy Domain" content={e.domain} />
                  <ProtectionActions stats={s} onDone={refresh} />
                  <Action.OpenInBrowser title="Open Query Log" url={`${ADGUARD_URL}/#logs`} />
                </ActionPanel>
              }
            />
          ))}
        </List.Section>
      )}
      {filters.data && (
        <List.Section
          title="Blocklists"
          subtitle={`${fmtCount(filters.data.totalRules)} rules enabled · ${filters.data.userRules} custom`}
        >
          {filters.data.filters.map((f) => (
            <List.Item
              key={f.name}
              icon={{ source: f.enabled ? Icon.CheckCircle : Icon.Circle, tintColor: f.enabled ? Color.Green : Color.SecondaryText }}
              title={f.name}
              subtitle={f.lastUpdated ? `updated ${f.lastUpdated}` : undefined}
              accessories={[{ text: `${fmtCount(f.rules)} rules` }]}
              actions={actions}
            />
          ))}
        </List.Section>
      )}
    </List>
  );
}
