import { Action, ActionPanel, Color, Icon, List } from "@raycast/api";
import { useCachedPromise } from "@raycast/utils";
import { FIREFLY_URLS } from "./firefly-api";
import { loadMonthSpend, loadSubscriptions } from "./money-api";

export default function Bills() {
  const subs = useCachedPromise(loadSubscriptions, [], { keepPreviousData: true });
  const spend = useCachedPromise(loadMonthSpend, [], { keepPreviousData: true });

  const actions = (
    <ActionPanel>
      <Action.OpenInBrowser title="Open Firefly III" url={FIREFLY_URLS.core} />
      <Action.OpenInBrowser title="Open Firefly Pico" url={FIREFLY_URLS.pico} />
    </ActionPanel>
  );

  return (
    <List isLoading={subs.isLoading || spend.isLoading} searchBarPlaceholder="Filter bills…">
      <List.Section title="This Month">
        {spend.data && (
          <List.Item
            icon={{ source: Icon.Coins, tintColor: Color.Red }}
            title={`Spent ${spend.data.spent.toFixed(2)} ${spend.data.currency}`}
            subtitle={`${spend.data.from} → ${spend.data.to}`}
            actions={actions}
          />
        )}
        {subs.data && (
          <List.Item
            icon={{ source: Icon.Calendar, tintColor: Color.Orange }}
            title={`${subs.data.due30d} due in the next 30 days`}
            subtitle={`${subs.data.count30d} payments · next: ${subs.data.next}`}
            actions={actions}
          />
        )}
      </List.Section>
      <List.Section title="Upcoming Subscriptions">
        {subs.data?.items.map((i, idx) => (
          <List.Item key={idx} icon={Icon.CreditCard} title={i.name} accessories={[{ text: i.detail }]} actions={actions} />
        ))}
      </List.Section>
    </List>
  );
}
