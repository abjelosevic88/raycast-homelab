import { getPreferenceValues } from "@raycast/api";
import { existsSync, readFileSync } from "fs";
import { homedir } from "os";
import { join } from "path";

/**
 * Single source of truth for every URL and credential the extension uses.
 *
 * Resolution order for a setting named e.g. `jellyfinApiKey`:
 *   1. the Raycast preference of the same name (⌘K → Configure Extension)
 *   2. the key `JELLYFIN_API_KEY` in the env file (default ~/.config/raycast-homelab/.env)
 *   3. empty → the feature is treated as "not configured" and hidden
 *
 * Nothing in the source code carries a default URL; every host comes from the user.
 */

export const DEFAULT_ENV_FILE = "~/.config/raycast-homelab/.env";

export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConfigError";
  }
}

let envCache: { path: string; values: Record<string, string> } | null = null;

function expandHome(p: string): string {
  return p.startsWith("~/") ? join(homedir(), p.slice(2)) : p;
}

function parseEnv(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const raw of text.split("\n")) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq < 0) continue;
    const key = line
      .slice(0, eq)
      .trim()
      .replace(/^export\s+/, "");
    let value = line.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    } else {
      value = value.replace(/\s+#.*$/, "");
    }
    out[key] = value;
  }
  return out;
}

function envFile(): Record<string, string> {
  const prefs = getPreferenceValues<Record<string, string | undefined>>();
  const path = expandHome((prefs.configFile || DEFAULT_ENV_FILE).trim());
  if (envCache && envCache.path === path) return envCache.values;
  let values: Record<string, string> = {};
  try {
    if (existsSync(path)) values = parseEnv(readFileSync(path, "utf8"));
  } catch {
    values = {};
  }
  envCache = { path, values };
  return values;
}

/** camelCase preference name → UPPER_SNAKE env key: `sabnzbdApiKey` → `SABNZBD_API_KEY` */
export function envKey(name: string): string {
  return name.replace(/([a-z0-9])([A-Z])/g, "$1_$2").toUpperCase();
}

/** Raw setting value: Raycast preference first, then the env file, else "". */
export function setting(name: string): string {
  const prefs =
    getPreferenceValues<Record<string, string | boolean | undefined>>();
  const ui = prefs[name];
  if (typeof ui === "string" && ui.trim()) return ui.trim();
  return (envFile()[envKey(name)] ?? "").trim();
}

/** Where a setting's value came from — for diagnostics in auth error messages. */
export function settingSource(
  name: string,
): "preference" | "env file" | "unset" {
  const prefs =
    getPreferenceValues<Record<string, string | boolean | undefined>>();
  const ui = prefs[name];
  if (typeof ui === "string" && ui.trim()) return "preference";
  if ((envFile()[envKey(name)] ?? "").trim()) return "env file";
  return "unset";
}

/** Safe one-line description of a secret: source, length and first characters. Never the value. */
export function describeSetting(name: string): string {
  const src = settingSource(name);
  if (src === "unset") return `${name} is unset`;
  const v = setting(name);
  return `${name} from ${src}: ${v.length} chars, starts "${v.slice(0, 3)}…"`;
}

/** True when every named setting is non-empty. */
export function has(...names: string[]): boolean {
  return names.every((n) => setting(n));
}

/** A base URL with the trailing slash removed, or "" when unset. Never throws. */
export function optionalUrl(name: string): string {
  const v = setting(name);
  return v ? v.replace(/\/+$/, "") : "";
}

/** A base URL that must be set; throws a ConfigError naming the preference otherwise. */
export function requireUrl(name: string, label: string): string {
  const v = optionalUrl(name);
  if (!v)
    throw new ConfigError(
      `${label} URL is not set — ⌘K → Configure Extension (or ${envKey(name)} in the env file)`,
    );
  return v;
}

/**
 * Lazily-resolved group of URLs, so modules can export e.g. `ARR_URLS.radarr`
 * and views read the current preference at access time.
 */
export function urlGroup<K extends string>(
  map: Record<K, string>,
): Record<K, string> {
  const out = {} as Record<K, string>;
  for (const key of Object.keys(map) as K[]) {
    Object.defineProperty(out, key, {
      enumerable: true,
      get: () => optionalUrl(map[key]),
    });
  }
  return out;
}
