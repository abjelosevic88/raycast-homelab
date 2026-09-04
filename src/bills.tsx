import { Action, ActionPanel, Color, Icon, List } from "@raycast/api";
import { useCachedPromise } from "@raycast/utils";
import { FIREFLY_URLS } from "./firefly-api";
import {
  loadBills,
  loadMonthSpend,
  loadMonthTransactions,
  loadSubscriptions,
} from "./money-api";

const openActions = (
  <ActionPanel>
    <Action.OpenInBrowser title="Open Firefly III" url={FIREFLY_URLS.core} />
    {FIREFLY_URLS.pico && (
      <Action.OpenInBrowser title="Open Firefly Pico" url={FIREFLY_URLS.pico} />
    )}
  </ActionPanel>
);

export function MonthTransactions() {
  const { data, isLoading } = useCachedPromise(loadMonthTransactions, [], {
    keepPreviousData: true,
  });
  const total = (data ?? []).reduce((s, t) => s + t.amount, 0);
  const currency = data?.[0]?.currency ?? "";

  const byDay = new Map<string, typeof data>();
  for (const t of data ?? []) {
    if (!byDay.has(t.date)) byDay.set(t.date, []);
    byDay.get(t.date)?.push(t);
  }

  return (
    <List
      isLoading={isLoading}
      navigationTitle={`This Month — ${total.toFixed(2)} ${currency}`}
      searchBarPlaceholder="Filter transactions…"
    >
      {[...byDay.keys()].map((day) => {
        const items = byDay.get(day) ?? [];
        const dayTotal = items.reduce((s, t) => s + t.amount, 0);
        return (
          <List.Section
            key={day}
            title={day}
            subtitle={`${dayTotal.toFixed(2)} ${currency}`}
          >
            {items.map((t) => (
              <List.Item
                key={t.id}
                icon={{ source: Icon.ArrowDownCircle, tintColor: Color.Red }}
                title={t.description}
                subtitle={
                  t.destination !== "Cash account" ? t.destination : undefined
                }
                accessories={[
                  ...(t.category ? [{ tag: t.category }] : []),
                  ...(t.foreign
                    ? [{ text: t.foreign, tooltip: "foreign amount" }]
                    : []),
                  { text: `${t.amount.toFixed(2)} ${t.currency}` },
                ]}
                actions={
                  <ActionPanel>
                    <Action.OpenInBrowser
                      title="Open in Firefly III"
                      url={`${FIREFLY_URLS.core}/transactions/show/${t.id.split("-")[0]}`}
                    />
                    <Action.CopyToClipboard
                      title="Copy Description"
                      content={t.description}
                    />
                  </ActionPanel>
                }
              />
            ))}
          </List.Section>
        );
      })}
    </List>
  );
}

export function BillsList() {
  const { data, isLoading } = useCachedPromise(loadBills, [], {
    keepPreviousData: true,
  });
  const active = (data ?? []).filter((b) => b.active);
  const inactive = (data ?? []).filter((b) => !b.active);

  function billItem(b: (typeof active)[number]) {
    const amount =
      b.amountMin === b.amountMax
        ? b.amountMax.toFixed(2)
        : `${b.amountMin.toFixed(0)}–${b.amountMax.toFixed(0)}`;
    const daysAway = b.nextDate
      ? Math.round((new Date(b.nextDate).getTime() - Date.now()) / 86400000)
      : undefined;
    return (
      <List.Item
        key={b.id}
        icon={{
          source: Icon.CreditCard,
          tintColor: b.active ? Color.Orange : Color.SecondaryText,
        }}
        title={b.name}
        subtitle={b.frequency}
        accessories={[
          ...(b.nextDate
            ? [
                { text: b.nextDate, tooltip: "next expected" },
                {
                  tag:
                    daysAway !== undefined && daysAway <= 7
                      ? { value: `in ${daysAway}d`, color: Color.Orange }
                      : `in ${daysAway}d`,
                },
              ]
            : []),
          { text: `${amount} ${b.currency}` },
        ]}
        actions={
          <ActionPanel>
            <Action.OpenInBrowser
              title="Open Bill in Firefly III"
              url={`${FIREFLY_URLS.core}/bills/show/${b.id}`}
            />
            <Action.OpenInBrowser
              title="Open Firefly III"
              url={FIREFLY_URLS.core}
            />
          </ActionPanel>
        }
      />
    );
  }

  return (
    <List
      isLoading={isLoading}
      navigationTitle="Subscriptions & Bills"
      searchBarPlaceholder="Filter bills…"
    >
      <List.Section title={`Active (${active.length})`}>
        {active.map(billItem)}
      </List.Section>
      {inactive.length > 0 && (
        <List.Section title={`Inactive (${inactive.length})`}>
          {inactive.map(billItem)}
        </List.Section>
      )}
    </List>
  );
}

export default function Bills() {
  const subs = useCachedPromise(loadSubscriptions, [], {
    keepPreviousData: true,
  });
  const spend = useCachedPromise(loadMonthSpend, [], {
    keepPreviousData: true,
  });

  return (
    <List
      isLoading={subs.isLoading || spend.isLoading}
      searchBarPlaceholder="Filter bills…"
    >
      <List.Section title="This Month">
        {spend.data && (
          <List.Item
            icon={{ source: Icon.Coins, tintColor: Color.Red }}
            title={`Spent ${spend.data.spent.toFixed(2)} ${spend.data.currency}`}
            subtitle={`${spend.data.from} → ${spend.data.to}`}
            accessories={[{ text: "all transactions →" }]}
            actions={
              <ActionPanel>
                <Action.Push
                  title="Show This Month's Transactions"
                  icon={Icon.List}
                  target={<MonthTransactions />}
                />
                <Action.OpenInBrowser
                  title="Open Firefly III"
                  url={FIREFLY_URLS.core}
                />
              </ActionPanel>
            }
          />
        )}
        {subs.data && (
          <List.Item
            icon={{ source: Icon.Calendar, tintColor: Color.Orange }}
            title={`${subs.data.due30d} due in the next 30 days`}
            subtitle={`${subs.data.count30d} payments · next: ${subs.data.next}`}
            accessories={[{ text: "all bills →" }]}
            actions={
              <ActionPanel>
                <Action.Push
                  title="Show All Subscriptions & Bills"
                  icon={Icon.List}
                  target={<BillsList />}
                />
                <Action.OpenInBrowser
                  title="Open Firefly III"
                  url={FIREFLY_URLS.core}
                />
              </ActionPanel>
            }
          />
        )}
      </List.Section>
      <List.Section title="Upcoming Subscriptions">
        {subs.data?.items.map((i, idx) => (
          <List.Item
            key={idx}
            icon={Icon.CreditCard}
            title={i.name}
            accessories={[{ text: i.detail }]}
            actions={openActions}
          />
        ))}
      </List.Section>
    </List>
  );
}
