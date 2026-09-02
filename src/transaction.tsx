import { Action, ActionPanel, Color, Icon, List, showToast, Toast } from "@raycast/api";
import { useCachedPromise } from "@raycast/utils";
import { useState } from "react";
import {
  AssistantData,
  createTransaction,
  FIREFLY_URLS,
  hasFireflyToken,
  loadAssistantData,
  ParsedInput,
  parseAssistant,
  PicoTemplate,
} from "./firefly-api";

const TYPE_STYLE: Record<string, { icon: Icon; color: Color }> = {
  withdrawal: { icon: Icon.ArrowDownCircle, color: Color.Red },
  deposit: { icon: Icon.ArrowUpCircle, color: Color.Green },
  transfer: { icon: Icon.Switch, color: Color.Blue },
};

export default function Transaction() {
  const [query, setQuery] = useState("");
  const hasToken = hasFireflyToken();
  const { data, isLoading } = useCachedPromise(async (ok: boolean) => (ok ? await loadAssistantData() : undefined), [
    hasToken,
  ]);

  const parsed = data ? parseAssistant(query, data.templates) : null;

  async function create(p: ParsedInput, d: AssistantData) {
    const toast = await showToast({ style: Toast.Style.Animated, title: `Adding ${p.description}…` });
    try {
      const summary = await createTransaction(p, d);
      toast.style = Toast.Style.Success;
      toast.title = `Added: ${p.description}`;
      toast.message = summary;
      setQuery("");
    } catch (e) {
      toast.style = Toast.Style.Failure;
      toast.title = "Failed to add transaction";
      toast.message = String(e instanceof Error ? e.message : e);
    }
  }

  function summarize(p: ParsedInput, d: AssistantData): { title: string; accessories: List.Item.Accessory[] } {
    const t = p.template;
    const account = t.sourceId ? d.accounts[t.sourceId] : undefined;
    const amountText =
      p.amount !== undefined
        ? `${p.amount}${p.currency ? ` ${p.currency}` : account ? ` ${account.currency}` : ""}`
        : "no amount";
    const when = p.dayOffset === 0 ? "today" : `${p.dayOffset > 0 ? "+" : ""}${p.dayOffset}d`;
    return {
      title: `${p.description} — ${amountText}`,
      accessories: [
        ...(t.categoryId && d.categoryNames[t.categoryId] ? [{ tag: d.categoryNames[t.categoryId] }] : []),
        ...(account ? [{ text: account.name }] : []),
        { text: when },
        { tag: { value: t.type, color: TYPE_STYLE[t.type]?.color ?? Color.SecondaryText } },
      ],
    };
  }

  const templates = data?.templates ?? [];
  const shown =
    query.trim().length > 0 && !parsed
      ? templates.filter((t) => t.name.toLowerCase().includes(query.trim().toLowerCase()))
      : templates;

  return (
    <List
      isLoading={isLoading}
      filtering={false}
      searchText={query}
      onSearchTextChange={setQuery}
      searchBarPlaceholder="template  amount(currency)  description  ±Nd — e.g. gorivo 50 full tank -1d"
    >
      {!hasToken && (
        <List.EmptyView
          icon={{ source: Icon.Key, tintColor: Color.Orange }}
          title="Firefly token not set"
          description="⌘K → Configure Extension → paste a Firefly III personal access token"
        />
      )}
      {parsed && data && (
        <List.Section title="Assistant">
          <List.Item
            icon={{ source: Icon.PlusCircle, tintColor: Color.Green }}
            {...summarize(parsed, data)}
            actions={
              <ActionPanel>
                <Action title="Add Transaction" icon={Icon.Check} onAction={() => create(parsed, data)} />
              </ActionPanel>
            }
          />
        </List.Section>
      )}
      {query.trim().length > 0 && !parsed && data && (
        <List.Section title="Assistant">
          <List.Item
            icon={{ source: Icon.QuestionMark, tintColor: Color.Orange }}
            title={`No template matches "${query.trim().split(/\s+/)[0]}"`}
            subtitle="format: template amount(currency) description ±Nd"
          />
        </List.Section>
      )}
      <List.Section title="Templates">
        {data &&
          shown.map((t: PicoTemplate) => {
            const style = TYPE_STYLE[t.type] ?? TYPE_STYLE.withdrawal;
            const account = t.sourceId ? data.accounts[t.sourceId] : undefined;
            const defaults = parseAssistant(t.name, data.templates);
            return (
              <List.Item
                key={t.id}
                icon={{ source: style.icon, tintColor: style.color }}
                title={t.name}
                subtitle={t.description !== t.name ? t.description : undefined}
                accessories={[
                  ...(t.categoryId && data.categoryNames[t.categoryId]
                    ? [{ tag: data.categoryNames[t.categoryId] }]
                    : []),
                  ...(t.amount ? [{ text: `${t.amount} ${account?.currency ?? ""}` }] : []),
                  ...(account ? [{ text: account.name }] : []),
                ]}
                actions={
                  <ActionPanel>
                    <Action
                      title="Use in Assistant"
                      icon={Icon.Pencil}
                      onAction={() => setQuery(`${t.name} `)}
                    />
                    {t.amount !== undefined && defaults && (
                      <Action
                        title={`Add with Defaults (${t.amount})`}
                        icon={Icon.Check}
                        onAction={() => create(defaults, data)}
                      />
                    )}
                    <Action.OpenInBrowser
                      title="Open Firefly Pico"
                      url={FIREFLY_URLS.pico}
                      shortcut={{ modifiers: ["cmd"], key: "o" }}
                    />
                  </ActionPanel>
                }
              />
            );
          })}
      </List.Section>
    </List>
  );
}
