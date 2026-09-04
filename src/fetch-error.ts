import { environment, LaunchType, showToast, Toast } from "@raycast/api";

// One toast per (service, message) per minute, never from background launches
// (the menu bar refreshes every 30s and must not nag on a transient blip).
const MUTE_MS = 60_000;
const lastShown = new Map<string, number>();

/** onError handler for useCachedPromise: names the service instead of Raycast's generic toast. */
export function fetchError(service: string, opts?: { silent?: boolean }) {
  return (e: Error) => {
    console.error(`[${service}] ${e.message}`);
    if (opts?.silent || environment.launchType === LaunchType.Background)
      return;
    const key = `${service}:${e.message}`;
    const now = Date.now();
    if ((lastShown.get(key) ?? 0) > now - MUTE_MS) return;
    lastShown.set(key, now);
    void showToast({
      style: Toast.Style.Failure,
      title: `${service}: could not refresh`,
      message: e.message,
    });
  };
}

/** Aggregating views (Home, menu bar): log only, keep the last good data on screen. */
export const silentError = (service: string) =>
  fetchError(service, { silent: true });
