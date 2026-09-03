import { getPreferenceValues } from "@raycast/api";
import { FIREFLY_URLS } from "./firefly-api";

interface Preferences {
  fireflyToken?: string;
}

const SUBSCRIPTIONS_URL = "https://home.bjelke.org/images/subscriptions.json";
const TIMEOUT_MS = 10000;

export interface Subscriptions {
  due30d: string;
  count30d: number;
  next: string;
  items: { name: string; detail: string }[];
}

// published by ~/ops/firefly-sub-publish.py for the Homepage widget
export async function loadSubscriptions(): Promise<Subscriptions> {
  const res = await fetch(SUBSCRIPTIONS_URL, { signal: AbortSignal.timeout(TIMEOUT_MS) });
  if (!res.ok) throw new Error(`subscriptions.json → HTTP ${res.status}`);
  const d = (await res.json()) as { due_30d: string; count_30d: number; next: string; items: { name: string; detail: string }[] };
  return { due30d: d.due_30d, count30d: d.count_30d, next: d.next, items: d.items };
}

export interface MonthSpend {
  spent: number;
  currency: string;
  from: string;
  to: string;
}

export async function loadMonthSpend(): Promise<MonthSpend | undefined> {
  const token = getPreferenceValues<Preferences>().fireflyToken;
  if (!token) return undefined;
  const now = new Date();
  const from = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-01`;
  const to = now.toISOString().slice(0, 10);
  const res = await fetch(`${FIREFLY_URLS.core}/api/v1/insight/expense/total?start=${from}&end=${to}`, {
    headers: { Authorization: `Bearer ${token}`, Accept: "application/json" },
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`Firefly insight → HTTP ${res.status}`);
  const rows = (await res.json()) as { difference_float: number; currency_code: string }[];
  // primary currency row (largest absolute amount)
  const row = rows.sort((a, b) => Math.abs(b.difference_float) - Math.abs(a.difference_float))[0];
  if (!row) return { spent: 0, currency: "", from, to };
  return { spent: Math.abs(row.difference_float), currency: row.currency_code, from, to };
}
