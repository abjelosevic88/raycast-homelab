import { Action, ActionPanel, Icon, showToast, Toast } from "@raycast/api";
import { useState } from "react";
import { getProfiles, requestMedia, SeasonInfo, ServiceProfiles } from "./jellyseerr-api";

export interface RequestTarget {
  mediaType: "movie" | "tv";
  id: number;
  title: string;
}

export async function doRequest(
  target: RequestTarget,
  opts: { profileId?: number; seasons?: number[]; onDone?: () => void } = {},
): Promise<void> {
  const what =
    opts.seasons && opts.seasons.length === 1 ? `${target.title} S${opts.seasons[0]}` : target.title;
  const toast = await showToast({ style: Toast.Style.Animated, title: `Requesting ${what}…` });
  try {
    await requestMedia(target, opts.profileId, opts.seasons);
    toast.style = Toast.Style.Success;
    toast.title = `Requested ${what}`;
    toast.message = target.mediaType === "tv" && !opts.seasons ? "all seasons" : undefined;
    opts.onDone?.();
  } catch (e) {
    toast.style = Toast.Style.Failure;
    toast.title = "Request failed";
    toast.message = String(e instanceof Error ? e.message : e);
  }
}

export function ProfileSubmenu(props: { target: RequestTarget; onDone?: () => void }) {
  const [profiles, setProfiles] = useState<ServiceProfiles | null>(null);
  return (
    <ActionPanel.Submenu
      title="Request with Profile…"
      icon={Icon.Gear}
      shortcut={{ modifiers: ["cmd"], key: "p" }}
      isLoading={profiles === null}
      onOpen={() => {
        getProfiles(props.target.mediaType)
          .then(setProfiles)
          .catch(async (e) => {
            await showToast({ style: Toast.Style.Failure, title: "Couldn't load profiles", message: String(e) });
          });
      }}
    >
      {profiles?.profiles.map((p) => (
        <Action
          key={p.id}
          title={p.id === profiles.activeProfileId ? `${p.name} (default)` : p.name}
          icon={p.id === profiles.activeProfileId ? Icon.Star : Icon.Circle}
          onAction={() => doRequest(props.target, { profileId: p.id, onDone: props.onDone })}
        />
      ))}
    </ActionPanel.Submenu>
  );
}

export function SeasonSubmenu(props: { target: RequestTarget; seasons: SeasonInfo[]; onDone?: () => void }) {
  if (props.target.mediaType !== "tv" || props.seasons.length === 0) return null;
  return (
    <ActionPanel.Submenu title="Request Season…" icon={Icon.List} shortcut={{ modifiers: ["cmd"], key: "s" }}>
      {props.seasons.map((s) => (
        <Action
          key={s.seasonNumber}
          title={`Season ${s.seasonNumber} (${s.episodeCount} episodes)`}
          icon={Icon.Play}
          onAction={() => doRequest(props.target, { seasons: [s.seasonNumber], onDone: props.onDone })}
        />
      ))}
    </ActionPanel.Submenu>
  );
}
