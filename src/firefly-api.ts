import { getPreferenceValues } from "@raycast/api";

interface Preferences {
  fireflyUrl?: string;
  picoUrl?: string;
  fireflyToken?: string;
}

export const FIREFLY_URLS = {
  core: "https://firefly.bjelke.org",
  pico: "https://pico.bjelke.org",
};

const TIMEOUT_MS = 10000;

function prefs() {
  const p = getPreferenceValues<Preferences>();
  const pick = (v: string | undefined, fb: string) => (!v || v.includes(".ts.net") ? fb : v.replace(/\/+$/, ""));
  return {
    core: pick(p.fireflyUrl, FIREFLY_URLS.core),
    pico: pick(p.picoUrl, FIREFLY_URLS.pico),
    token: p.fireflyToken ?? "",
  };
}

export function hasFireflyToken(): boolean {
  return Boolean(prefs().token);
}

async function apiFetch<T>(base: "core" | "pico", path: string, init?: RequestInit): Promise<T> {
  const { core, pico, token } = prefs();
  const res = await fetch(`${base === "core" ? core : pico}${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/json",
      "Content-Type": "application/json",
      ...(init?.headers ?? {}),
    },
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (!res.ok) {
    let msg = `HTTP ${res.status}`;
    try {
      const body = (await res.json()) as { message?: string };
      if (body.message) msg = body.message;
    } catch {
      // keep status message
    }
    throw new Error(msg);
  }
  return (await res.json()) as T;
}

export interface PicoTemplate {
  id: number;
  name: string;
  amount?: number;
  sourceId?: number;
  destId?: number;
  categoryId?: number;
  type: "withdrawal" | "deposit" | "transfer";
  description: string;
  notes?: string;
  tagIds: number[];
  // house convention: "[currency:EUR]" in template notes = amounts are entered in that currency
  defaultCurrency?: string;
}

export interface AssistantData {
  templates: PicoTemplate[];
  tagNames: Record<number, string>;
  categoryNames: Record<number, string>;
  accounts: Record<number, { name: string; currency: string }>;
  rates: Record<string, number>; // "EUR->BAM": 1.9558
}

interface RawPicoTemplate {
  id: number;
  name: string;
  amount?: number | null;
  account_source_id?: number | null;
  account_destination_id?: number | null;
  category_id?: number | null;
  type?: string;
  description?: string | null;
  notes?: string | null;
  tags?: { tag_id: number }[];
}

export async function loadAssistantData(): Promise<AssistantData> {
  const [tpl, tags, cats, accts, ratesRaw] = await Promise.all([
    apiFetch<{ data: RawPicoTemplate[] }>("pico", "/api/transaction-templates?limit=200"),
    apiFetch<{ data: { id: string; attributes: { tag: string } }[] }>("core", "/api/v1/tags?limit=200"),
    apiFetch<{ data: { id: string; attributes: { name: string } }[] }>("core", "/api/v1/categories?limit=200"),
    apiFetch<{ data: { id: string; attributes: { name: string; currency_code: string } }[] }>(
      "core",
      "/api/v1/accounts?type=asset&limit=100",
    ),
    apiFetch<{ data: RawRate[] }>("core", "/api/v1/exchange-rates?limit=200").catch(() => ({ data: [] as RawRate[] })),
  ]);

  const rates: Record<string, number> = {};
  for (const r of ratesRaw.data) {
    const a = r.attributes;
    const rate = Number(a.rate);
    if (!rate) continue;
    rates[`${a.from_currency_code}->${a.to_currency_code}`] = rate;
    rates[`${a.to_currency_code}->${a.from_currency_code}`] = 1 / rate;
  }

  const tagNames: Record<number, string> = {};
  for (const t of tags.data) tagNames[Number(t.id)] = t.attributes.tag;
  const categoryNames: Record<number, string> = {};
  for (const c of cats.data) categoryNames[Number(c.id)] = c.attributes.name;
  const accounts: Record<number, { name: string; currency: string }> = {};
  for (const a of accts.data) accounts[Number(a.id)] = { name: a.attributes.name, currency: a.attributes.currency_code };

  return {
    templates: tpl.data.map((t) => ({
      id: t.id,
      name: t.name,
      amount: t.amount ?? undefined,
      sourceId: t.account_source_id ?? undefined,
      destId: t.account_destination_id ?? undefined,
      categoryId: t.category_id ?? undefined,
      type: (t.type as PicoTemplate["type"]) ?? "withdrawal",
      description: t.description || t.name,
      notes: t.notes ?? undefined,
      tagIds: (t.tags ?? []).map((x) => x.tag_id),
      defaultCurrency: t.notes?.match(/\[currency:([A-Za-z]{3})\]/)?.[1]?.toUpperCase(),
    })),
    tagNames,
    categoryNames,
    accounts,
    rates,
  };
}

// ---------- assistant input parsing:  [template] [amount][currency?] [description?] [±Nd?] ----------

export interface ParsedInput {
  template: PicoTemplate;
  amount?: number;
  currency?: string;
  description: string;
  dayOffset: number;
}

const CURRENCY_ALIASES: Record<string, string> = { km: "BAM", eur: "EUR", euro: "EUR", usd: "USD", bam: "BAM", rsd: "RSD" };

export function parseAssistant(input: string, templates: PicoTemplate[]): ParsedInput | null {
  const raw = input.trim();
  if (!raw) return null;
  const allTokens = raw.split(/\s+/);

  // Take the longest run of leading tokens that is a prefix of exactly one
  // template name ("cg h" → "cg hrana"); an exact full-name match always wins
  // even when other templates share the prefix ("Hrana" vs "Hrana extra").
  let template: PicoTemplate | undefined;
  let consumed = 0;
  for (let k = allTokens.length; k >= 1; k--) {
    const prefix = allTokens.slice(0, k).join(" ").toLowerCase();
    const cands = templates.filter((t) => t.name.toLowerCase().startsWith(prefix));
    const exact = cands.find((t) => t.name.toLowerCase() === prefix);
    if (exact) {
      template = exact;
      consumed = k;
      break;
    }
    if (cands.length === 1) {
      template = cands[0];
      consumed = k;
      break;
    }
  }
  if (!template) return null;

  let tokens = allTokens.slice(consumed);
  let dayOffset = 0;
  const last = tokens[tokens.length - 1];
  const dm = last?.match(/^([+-])(\d+)d$/i);
  if (dm) {
    dayOffset = (dm[1] === "-" ? -1 : 1) * Number(dm[2]);
    tokens = tokens.slice(0, -1);
  }

  let amount: number | undefined;
  let currency: string | undefined;
  if (tokens.length > 0) {
    const am = tokens[0].match(/^(\d+(?:[.,]\d+)?)([a-zA-Z]{2,4})?$/);
    if (am) {
      amount = Number(am[1].replace(",", "."));
      if (am[2]) currency = am[2].toLowerCase();
      tokens = tokens.slice(1);
      if (!currency && tokens[0] && CURRENCY_ALIASES[tokens[0].toLowerCase()]) {
        currency = tokens[0].toLowerCase();
        tokens = tokens.slice(1);
      }
    }
  }

  return {
    template,
    amount: amount ?? template.amount,
    // explicit currency beats the template's [currency:XXX] default
    currency: currency ? (CURRENCY_ALIASES[currency] ?? currency.toUpperCase()) : template.defaultCurrency,
    description: tokens.join(" ") || template.description,
    dayOffset,
  };
}

// ---------- creation ----------

interface RawRate {
  attributes: { from_currency_code: string; to_currency_code: string; rate: string };
}

export function convertAmount(amount: number, from: string, to: string, rates: Record<string, number>): number | undefined {
  if (from === to) return amount;
  const r = rates[`${from}->${to}`];
  return r ? amount * r : undefined;
}

export async function createTransaction(p: ParsedInput, data: AssistantData): Promise<string> {
  const t = p.template;
  if (p.amount === undefined) throw new Error("No amount — type one or set a default on the template");
  const account = t.sourceId ? data.accounts[t.sourceId] : undefined;
  const accCurrency = account?.currency;

  let amount = p.amount;
  let foreign: { foreign_amount: string; foreign_currency_code: string } | undefined;
  if (p.currency && accCurrency && p.currency !== accCurrency) {
    const converted = convertAmount(p.amount, p.currency, accCurrency, data.rates);
    if (converted === undefined) throw new Error(`No exchange rate ${p.currency}→${accCurrency} in Firefly`);
    foreign = { foreign_amount: p.amount.toFixed(2), foreign_currency_code: p.currency };
    amount = converted;
  }

  const date = new Date(Date.now() + p.dayOffset * 86400000).toISOString().slice(0, 10);
  const tx = {
    type: t.type,
    date,
    amount: amount.toFixed(2),
    description: p.description,
    source_id: t.sourceId ? String(t.sourceId) : undefined,
    destination_id: t.destId ? String(t.destId) : undefined,
    category_id: t.categoryId ? String(t.categoryId) : undefined,
    tags: t.tagIds.map((id) => data.tagNames[id]).filter(Boolean),
    notes: t.notes,
    ...(foreign ?? {}),
  };
  await apiFetch("core", "/api/v1/transactions", {
    method: "POST",
    body: JSON.stringify({ error_if_duplicate_hash: false, apply_rules: true, fire_webhooks: true, transactions: [tx] }),
  });
  return `${amount.toFixed(2)} ${accCurrency ?? ""} · ${date}`;
}
