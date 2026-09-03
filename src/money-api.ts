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

function fireflyHeaders(): Record<string, string> {
  const token = getPreferenceValues<Preferences>().fireflyToken ?? "";
  return { Authorization: `Bearer ${token}`, Accept: "application/json" };
}

export interface MonthTransaction {
  id: string;
  date: string;
  description: string;
  amount: number;
  currency: string;
  category?: string;
  destination?: string;
  foreign?: string; // "20.00 EUR"
}

export async function loadMonthTransactions(): Promise<MonthTransaction[]> {
  const now = new Date();
  const from = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-01`;
  const to = now.toISOString().slice(0, 10);
  const out: MonthTransaction[] = [];
  for (let page = 1; page <= 5; page++) {
    const res = await fetch(
      `${FIREFLY_URLS.core}/api/v1/transactions?type=withdrawal&start=${from}&end=${to}&limit=100&page=${page}`,
      { headers: fireflyHeaders(), signal: AbortSignal.timeout(TIMEOUT_MS) },
    );
    if (!res.ok) throw new Error(`Firefly transactions → HTTP ${res.status}`);
    const body = (await res.json()) as {
      data: {
        id: string;
        attributes: {
          transactions: {
            date: string;
            description: string;
            amount: string;
            currency_code: string;
            category_name?: string | null;
            destination_name?: string | null;
            foreign_amount?: string | null;
            foreign_currency_code?: string | null;
          }[];
        };
      }[];
      meta?: { pagination?: { total_pages?: number } };
    };
    for (const t of body.data) {
      for (const s of t.attributes.transactions) {
        out.push({
          id: `${t.id}-${out.length}`,
          date: s.date.slice(0, 10),
          description: s.description,
          amount: Number(s.amount),
          currency: s.currency_code,
          category: s.category_name ?? undefined,
          destination: s.destination_name ?? undefined,
          foreign: s.foreign_amount ? `${Number(s.foreign_amount).toFixed(2)} ${s.foreign_currency_code}` : undefined,
        });
      }
    }
    if ((body.meta?.pagination?.total_pages ?? 1) <= page) break;
  }
  return out.sort((a, b) => b.date.localeCompare(a.date));
}

export interface Bill {
  id: string;
  name: string;
  amountMin: number;
  amountMax: number;
  currency: string;
  frequency: string;
  nextDate?: string;
  active: boolean;
}

export async function loadBills(): Promise<Bill[]> {
  const from = new Date().toISOString().slice(0, 10);
  const to = new Date(Date.now() + 60 * 86400000).toISOString().slice(0, 10);
  const res = await fetch(`${FIREFLY_URLS.core}/api/v1/bills?start=${from}&end=${to}&limit=100`, {
    headers: fireflyHeaders(),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`Firefly bills → HTTP ${res.status}`);
  const body = (await res.json()) as {
    data: {
      id: string;
      attributes: {
        name: string;
        amount_min: string;
        amount_max: string;
        currency_code: string;
        repeat_freq: string;
        active: boolean;
        next_expected_match?: string | null;
        pay_dates?: string[];
      };
    }[];
  };
  return body.data
    .map((b) => ({
      id: b.id,
      name: b.attributes.name,
      amountMin: Number(b.attributes.amount_min),
      amountMax: Number(b.attributes.amount_max),
      currency: b.attributes.currency_code,
      frequency: b.attributes.repeat_freq,
      nextDate: (b.attributes.next_expected_match ?? b.attributes.pay_dates?.[0])?.slice(0, 10),
      active: b.attributes.active,
    }))
    .sort((a, b) => (a.nextDate ?? "9999").localeCompare(b.nextDate ?? "9999"));
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
