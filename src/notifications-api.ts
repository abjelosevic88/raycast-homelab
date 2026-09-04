import { has, optionalUrl, requireUrl, setting } from "./config";

export const NTFY_URL = optionalUrl("ntfyUrl");
const TIMEOUT_MS = 10000;

export function hasNtfy(): boolean {
  return has("ntfyUrl", "ntfyTopics");
}

export function ntfyPrefs() {
  return {
    url: requireUrl("ntfyUrl", "ntfy"),
    topics: setting("ntfyTopics")
      .split(",")
      .map((t) => t.trim())
      .filter(Boolean),
  };
}

export interface Notification {
  id: string;
  time: number; // unix seconds
  topic: string;
  title: string;
  message: string;
  priority?: number;
  kind: "success" | "failure" | "info";
}

interface RawNtfyMessage {
  id: string;
  time: number;
  event: string;
  topic: string;
  title?: string;
  message?: string;
  priority?: number;
  icon?: string;
}

function classify(m: RawNtfyMessage): Notification["kind"] {
  const hay = `${m.icon ?? ""} ${m.title ?? ""}`;
  if (
    hay.includes("failure") ||
    hay.includes("⚠️") ||
    hay.includes("❌") ||
    (m.priority ?? 3) >= 4
  )
    return "failure";
  if (hay.includes("success") || hay.includes("✅")) return "success";
  return "info";
}

export async function loadNotifications(
  since = "168h",
): Promise<Notification[]> {
  const { url, topics } = ntfyPrefs();
  const res = await fetch(
    `${url}/${topics.join(",")}/json?poll=1&since=${since}`,
    {
      signal: AbortSignal.timeout(TIMEOUT_MS),
    },
  );
  if (!res.ok) throw new Error(`ntfy → HTTP ${res.status}`);
  // ntfy streams line-delimited JSON, one message object per line
  const text = await res.text();
  const out: Notification[] = [];
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    let m: RawNtfyMessage;
    try {
      m = JSON.parse(line) as RawNtfyMessage;
    } catch {
      continue;
    }
    if (m.event !== "message") continue;
    out.push({
      id: m.id,
      time: m.time,
      topic: m.topic,
      title: m.title || (m.message ?? "").split("\n")[0].slice(0, 80),
      message: m.message ?? "",
      priority: m.priority,
      kind: classify(m),
    });
  }
  return out.sort((a, b) => b.time - a.time);
}

export function timeAgo(unixSeconds: number): string {
  const s = Math.max(0, Math.floor(Date.now() / 1000 - unixSeconds));
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
}
