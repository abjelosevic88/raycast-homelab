import {
  Action,
  ActionPanel,
  Color,
  Icon,
  List,
  showToast,
  Toast,
  Keyboard,
} from "@raycast/api";
import { useCachedPromise } from "@raycast/utils";
import { fetchError } from "./fetch-error";
import { useState } from "react";
import {
  AssistantData,
  convertAmount,
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
  const { data, isLoading } = useCachedPromise(
    async (ok: boolean) => (ok ? await loadAssistantData() : undefined),
    [hasToken],
    { onError: fetchError("Firefly") },
  );

  const parsed = data ? parseAssistant(query, data.templates) : null;

  async function create(p: ParsedInput, d: AssistantData) {
    const toast = await showToast({
      style: Toast.Style.Animated,
      title: `Adding ${p.description}…`,
    });
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

  function summarize(
    p: ParsedInput,
    d: AssistantData,
  ): { title: string; accessories: List.Item.Accessory[] } {
    const t = p.template;
    const account = t.sourceId ? d.accounts[t.sourceId] : undefined;
    let amountText = "no amount";
    if (p.amount !== undefined) {
      const cur = p.currency ?? account?.currency;
      amountText = `${p.amount}${cur ? ` ${cur}` : ""}`;
      if (p.currency && account && p.currency !== account.currency) {
        const converted = convertAmount(
          p.amount,
          p.currency,
          account.currency,
          d.rates,
        );
        amountText +=
          converted !== undefined
            ? ` ≈ ${converted.toFixed(2)} ${account.currency}`
            : ` (no ${p.currency}→${account.currency} rate!)`;
      }
    }
    const when =
      p.dayOffset === 0
        ? "today"
        : `${p.dayOffset > 0 ? "+" : ""}${p.dayOffset}d`;
    return {
      title: `${p.description} — ${amountText}`,
      accessories: [
        ...(t.categoryId && d.categoryNames[t.categoryId]
          ? [{ tag: d.categoryNames[t.categoryId] }]
          : []),
        ...(account ? [{ text: account.name }] : []),
        { text: when },
        {
          tag: {
            value: t.type,
            color: TYPE_STYLE[t.type]?.color ?? Color.SecondaryText,
          },
        },
      ],
    };
  }

  const templates = data?.templates ?? [];
  const shown =
    query.trim().length > 0 && !parsed
      ? templates.filter((t) =>
          t.name.toLowerCase().includes(query.trim().toLowerCase()),
        )
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
          description="⌘K → Configure Extension → set the Firefly III URL and a personal access token"
        />
      )}
      {parsed && data && (
        <List.Section title="Assistant">
          <List.Item
            icon={{ source: Icon.PlusCircle, tintColor: Color.Green }}
            {...summarize(parsed, data)}
            actions={
              <ActionPanel>
                <Action
                  title="Add Transaction"
                  icon={Icon.Check}
                  onAction={() => create(parsed, data)}
                />
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
                  ...(t.amount
                    ? [
                        {
                          text: `${t.amount} ${t.defaultCurrency ?? account?.currency ?? ""}`,
                        },
                      ]
                    : t.defaultCurrency
                      ? [{ tag: t.defaultCurrency }]
                      : []),
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
                      shortcut={Keyboard.Shortcut.Common.Open}
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
