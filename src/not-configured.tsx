import {
  Action,
  ActionPanel,
  Grid,
  Icon,
  List,
  openExtensionPreferences,
} from "@raycast/api";

interface Props {
  service: string;
  /** Human names of the preferences to fill, e.g. "URL and API key" */
  needs: string;
  grid?: boolean;
}

/** Empty state shown by a view whose service has no URL / credentials yet. */
export default function NotConfigured({ service, needs, grid }: Props) {
  const props = {
    icon: Icon.Gear,
    title: `${service} is not configured`,
    description: `⌘K → Configure Extension → set the ${service} ${needs}. Or put them in the env file (see README).`,
    actions: (
      <ActionPanel>
        <Action
          title="Configure Extension"
          icon={Icon.Gear}
          onAction={openExtensionPreferences}
        />
      </ActionPanel>
    ),
  };
  return grid ? <Grid.EmptyView {...props} /> : <List.EmptyView {...props} />;
}
