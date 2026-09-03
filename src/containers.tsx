import { Action, ActionPanel, Alert, Color, confirmAlert, getPreferenceValues, Icon, List, showToast, Toast, Keyboard } from "@raycast/api";
import { useCachedPromise } from "@raycast/utils";

interface Preferences {
  komodoApiKey?: string;
  komodoApiSecret?: string;
}

const KOMODO_URL = "https://komodo.bjelke.org";
const TIMEOUT_MS = 15000;

function creds() {
  const p = getPreferenceValues<Preferences>();
  return { key: p.komodoApiKey ?? "", secret: p.komodoApiSecret ?? "" };
}

async function komodo<T>(kind: "read" | "execute", type: string, params: Record<string, unknown> = {}): Promise<T> {
  const { key, secret } = creds();
  const res = await fetch(`${KOMODO_URL}/${kind}`, {
    method: "POST",
    headers: { "X-Api-Key": key, "X-Api-Secret": secret, "Content-Type": "application/json" },
    signal: AbortSignal.timeout(TIMEOUT_MS),
    body: JSON.stringify({ type, params }),
  });
  if (!res.ok) {
    let msg = `HTTP ${res.status}`;
    try {
      const b = (await res.json()) as { error?: string };
      if (b.error) msg = b.error;
    } catch {
      // keep status message
    }
    throw new Error(`Komodo ${type} → ${msg}`);
  }
  return (await res.json()) as T;
}

interface StackListItem {
  id: string;
  name: string;
  info?: { state?: string; status?: string; services?: unknown[] };
}

const STATE_COLOR: Record<string, Color> = {
  running: Color.Green,
  down: Color.SecondaryText,
  stopped: Color.SecondaryText,
  unhealthy: Color.Red,
  restarting: Color.Orange,
  dead: Color.Red,
  created: Color.Orange,
  paused: Color.Orange,
  unknown: Color.Orange,
};

export default function Containers() {
  const { key, secret } = creds();
  const hasCreds = Boolean(key && secret);
  const { data, isLoading, revalidate } = useCachedPromise(
    async (ok: boolean) => (ok ? await komodo<StackListItem[]>("read", "ListStacks") : []),
    [hasCreds],
    { keepPreviousData: true },
  );

  async function act(stack: StackListItem, action: "RestartStack" | "StartStack" | "StopStack") {
    const verb = action.replace("Stack", "").toLowerCase();
    if (
      !(await confirmAlert({
        title: `${verb} stack "${stack.name}"?`,
        primaryAction: { title: verb, style: action === "StopStack" ? Alert.ActionStyle.Destructive : Alert.ActionStyle.Default },
      }))
    )
      return;
    const toast = await showToast({ style: Toast.Style.Animated, title: `${verb}ing ${stack.name}…` });
    try {
      await komodo("execute", action, { stack: stack.name });
      toast.style = Toast.Style.Success;
      toast.title = `${verb} requested: ${stack.name}`;
      toast.message = "Komodo is applying it — state updates shortly";
      setTimeout(revalidate, 4000);
    } catch (e) {
      toast.style = Toast.Style.Failure;
      toast.title = `Failed to ${verb} ${stack.name}`;
      toast.message = String(e instanceof Error ? e.message : e);
    }
  }

  const stacks = [...(data ?? [])].sort((a, b) => a.name.localeCompare(b.name));
  const running = stacks.filter((s) => (s.info?.state ?? "unknown") === "running");
  const rest = stacks.filter((s) => (s.info?.state ?? "unknown") !== "running");

  function stackItem(s: StackListItem) {
    const state = s.info?.state ?? s.info?.status ?? "unknown";
    const color = STATE_COLOR[state] ?? Color.Orange;
    return (
      <List.Item
        key={s.id}
        icon={{ source: Icon.Box, tintColor: color }}
        title={s.name}
        accessories={[{ tag: { value: state, color } }]}
        actions={
          <ActionPanel>
            <Action title="Restart Stack" icon={Icon.ArrowClockwise} onAction={() => act(s, "RestartStack")} />
            {state !== "running" && <Action title="Start Stack" icon={Icon.Play} onAction={() => act(s, "StartStack")} />}
            <Action.OpenInBrowser title="Open Komodo" url={KOMODO_URL} shortcut={Keyboard.Shortcut.Common.Open} />
            <Action
              title="Refresh"
              icon={Icon.ArrowClockwise}
              shortcut={Keyboard.Shortcut.Common.Refresh}
              onAction={revalidate}
            />
            <Action
              title="Stop Stack"
              icon={Icon.Stop}
              style={Action.Style.Destructive}
              shortcut={{ modifiers: ["ctrl"], key: "x" }}
              onAction={() => act(s, "StopStack")}
            />
          </ActionPanel>
        }
      />
    );
  }

  return (
    <List isLoading={isLoading} searchBarPlaceholder={`Filter ${stacks.length} stacks…`}>
      {!hasCreds && (
        <List.EmptyView
          icon={{ source: Icon.Key, tintColor: Color.Orange }}
          title="Komodo API key not set"
          description="Komodo → Settings → Api Keys → create one, then ⌘K → Configure Extension (key + secret)"
        />
      )}
      {rest.length > 0 && <List.Section title={`Not Running (${rest.length})`}>{rest.map(stackItem)}</List.Section>}
      <List.Section title={`Running (${running.length})`}>{running.map(stackItem)}</List.Section>
    </List>
  );
}
