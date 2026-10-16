// Pure shopping-basket logic (no I/O) so it can be unit-tested.

/** key: what to search for (and pin preferences by); qty: count, or kg for weighed items. */
export type ListItem = { key: string; qty: number; weightKg?: number; byWeight?: boolean };

// Words that say "from the counter, sold by weight" - they never appear in product names.
const BY_WEIGHT_RE = /(^|\s)(מה?קצביה|מה?אטליז|מה?מעדניה|מה?מעדנייה|מהדלפק|במשקל|שקילה?)(?=\s|$)/g;

export type Product = {
  barcode: string;
  name: string;
  manufacturer: string | null;
  quantity: number | null;
  unit_of_measure: string | null;
  is_weighted: boolean;
  branches: number;
  min_price: number;
  max_price: number;
};

export type ResolvedItem = ListItem & {
  weighted: boolean; // sold by weight: qty is kilograms and prices are per kg
  candidates: Product[];
  preferred: string[]; // barcodes; empty = no preference, any candidate is fine
  reference: Product | null;
};

export type Line = {
  key: string;
  qty: number;
  barcode: string;
  name: string;
  price: number;
  total: number;
  promo: string | null;
  promo_min_qty: number | null;
  preferred: boolean;
};

export type BranchRow = {
  branch_id: number;
  chain_id: string;
  chain_name: string;
  branch_name: string;
  city: string | null;
  address: string | null;
  is_online: boolean;
  lat: number | null;
  lon: number | null;
  lines: Line[];
};

export type StoreOption = {
  branch: BranchRow;
  total: number; // what you pay (incl. delivery fee for online)
  estimated: number; // total + estimate for missing items, used for ranking
  missing: string[];
  deliveryFee: number;
};

export type SplitOption = {
  a: BranchRow;
  b: BranchRow;
  linesA: Line[];
  linesB: Line[];
  total: number;
  missing: string[];
  saving: number;
};

// "2 קוטג", "קוטג x2", "קוטג ×2", "קוטג *2". A trailing bare number is NOT a
// quantity ("חלב 3", "קוטג 5%") to avoid eating product attributes.
// "500 גרם", "1.5 ק"ג", "300ג'", "2 קילו" anywhere in the line
const WEIGHT_RE = /(\d+(?:[.,]\d+)?)\s*(ק"ג|ק״ג|קג|קילוגרם|קילו|kg|גרם|גר'?|ג'|ג׳|gr|g)(?=\s|$)/i;

function toKg(amount: number, unit: string): number {
  return /^(ק"ג|ק״ג|קג|קילוגרם|קילו|kg)$/i.test(unit) ? amount : amount / 1000;
}

// "2 קוטג", "קוטג x2", "קוטג ×2", "קוטג *2", "בשר טחון 500 גרם". A trailing bare
// number is NOT a quantity ("חלב 3", "קוטג 5%") to avoid eating product attributes.
export function parseList(text: string): ListItem[] {
  const out: ListItem[] = [];
  for (const raw of text.split(/\n|,(?!\d)/)) {
    let line = raw.replace(/^[\s\-•*·]+/, "").trim();
    if (!line) continue;
    let weightKg: number | undefined;
    const w = line.match(WEIGHT_RE);
    if (w) {
      weightKg = toKg(parseFloat(w[1].replace(",", ".")), w[2]);
      line = (line.slice(0, w.index) + line.slice((w.index ?? 0) + w[0].length)).replace(/\s+/g, " ").trim();
    }
    let byWeight = false;
    if (line.match(BY_WEIGHT_RE)) {
      byWeight = true;
      line = line.replace(BY_WEIGHT_RE, " ").replace(/\s+/g, " ").trim();
    }
    let qty = 1;
    const lead = line.match(/^(\d+(?:\.\d+)?)\s*(?:x|×|\*)?\s+(.+)$/i);
    const trail = line.match(/^(.+?)\s*(?:x|×|\*)\s*(\d+(?:\.\d+)?)$/i);
    if (lead) {
      qty = parseFloat(lead[1]);
      line = lead[2];
    } else if (trail) {
      qty = parseFloat(trail[2]);
      line = trail[1];
    }
    if (!line) continue;
    const item: ListItem = { key: line.trim(), qty: qty > 0 ? qty : 1 };
    if (weightKg) item.weightKg = weightKg;
    if (byWeight) item.byWeight = true;
    out.push(item);
  }
  // merge duplicates
  const merged = new Map<string, ListItem>();
  for (const it of out) {
    const prev = merged.get(it.key);
    merged.set(it.key, prev ? { ...prev, qty: prev.qty + it.qty } : it);
  }
  return [...merged.values()];
}

function normUnit(u: string | null): string {
  if (!u) return "";
  const s = u.replace(/[.'"׳]/g, "").trim();
  if (/^(גרם|גר|ג|gr|g)$/i.test(s)) return "g";
  if (/^(קג|קילו|קילוגרם|kg)$/i.test(s)) return "kg";
  if (/^(מל|מיליליטר|ml)$/i.test(s)) return "ml";
  if (/^(ליטר|ל|l|lt)$/i.test(s)) return "l";
  return s;
}

function baseAmount(p: Product): [string, number] | null {
  if (p.quantity == null || p.quantity <= 0) return null;
  const u = normUnit(p.unit_of_measure);
  if (u === "kg") return ["g", p.quantity * 1000];
  if (u === "l") return ["ml", p.quantity * 1000];
  return [u, p.quantity];
}

/** Are two products comparable substitutes (same unit, size within ±25%)? */
export function similarSize(a: Product, b: Product): boolean {
  if (a.is_weighted || b.is_weighted) return a.is_weighted === b.is_weighted; // per-kg vs per-kg only
  const x = baseAmount(a);
  const y = baseAmount(b);
  if (!x || !y) return true;
  if (x[0] !== y[0]) return false;
  const ratio = x[1] / y[1];
  return ratio >= 0.75 && ratio <= 1.334;
}

/**
 * Decide which products may fill a list item.
 * - pinned: barcodes the user explicitly chose for this term
 * - bought: barcodes from receipt history (barcode -> times bought)
 */
export function resolveItem(
  item: ListItem,
  results: Product[],
  pinned: string[],
  bought: Map<string, number>,
  strict = false,
): ResolvedItem {
  if (results.length === 0) return { ...item, weighted: false, candidates: [], preferred: [], reference: null };

  let preferred = pinned.filter((b) => results.some((r) => r.barcode === b));
  const isPinned = preferred.length > 0;
  if (!isPinned) {
    preferred = results
      .filter((r) => bought.has(r.barcode))
      .sort((a, b) => (bought.get(b.barcode) ?? 0) - (bought.get(a.barcode) ?? 0))
      .map((r) => r.barcode);
  }
  let reference = results.find((r) => r.barcode === preferred[0]) ?? null;
  if (!reference && item.byWeight) reference = results.find((r) => r.is_weighted) ?? null;
  if (!reference && item.weightKg) {
    // "קוטג 250 גרם": a packaged product of about that size, or anything sold by weight
    const target: Product = { ...results[0], is_weighted: false, quantity: item.weightKg * 1000, unit_of_measure: "גרם" };
    reference = results.find((r) => !r.is_weighted && similarSize(r, target)) ?? results.find((r) => r.is_weighted) ?? null;
  }
  reference ??= results[0];
  const weighted = reference.is_weighted;
  const candidates =
    strict && isPinned
      ? results.filter((r) => preferred.includes(r.barcode))
      : results.filter((r) => preferred.includes(r.barcode) || similarSize(r, reference));
  // weighed goods: qty is kilograms (default 1kg); packaged goods: qty is a count
  const qty = weighted ? (item.weightKg ?? 1) * item.qty : item.qty;
  return { ...item, qty, weighted, candidates, preferred, reference };
}

function sum(xs: number[]): number {
  return Math.round(xs.reduce((a, b) => a + b, 0) * 100) / 100;
}

function median(xs: number[]): number {
  if (xs.length === 0) return 0;
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

/** Typical cost of each item across branches - used to price missing items when ranking. */
export function typicalCosts(rows: BranchRow[]): Map<string, number> {
  const per = new Map<string, number[]>();
  for (const r of rows) for (const l of r.lines) per.set(l.key, [...(per.get(l.key) ?? []), l.total]);
  const out = new Map<string, number>();
  for (const [k, v] of per) out.set(k, median(v));
  return out;
}

export function rankStores(
  rows: BranchRow[],
  keys: string[],
  opts: { deliveryFee: number; missingPenalty?: number },
): StoreOption[] {
  const typical = typicalCosts(rows);
  const penalty = opts.missingPenalty ?? 1.25;
  return rows
    .map((branch) => {
      const have = new Set(branch.lines.map((l) => l.key));
      const missing = keys.filter((k) => !have.has(k));
      const deliveryFee = branch.is_online ? opts.deliveryFee : 0;
      const total = sum([...branch.lines.map((l) => l.total), deliveryFee]);
      const estimated = sum([total, ...missing.map((k) => (typical.get(k) ?? 0) * penalty)]);
      return { branch, total, estimated, missing, deliveryFee };
    })
    .filter((o) => o.branch.lines.length > 0)
    .sort((a, b) => a.missing.length - b.missing.length || a.estimated - b.estimated);
}

/** Best two-store splits that beat the best single store by at least `minSaving`. */
export function bestSplits(
  rows: BranchRow[],
  keys: string[],
  best: StoreOption | undefined,
  opts: { minSaving: number; maxPairs?: number; deliveryFee: number },
): SplitOption[] {
  if (!best) return [];
  const physical = rows.filter((r) => !r.is_online && r.lines.length > 0);
  const out: SplitOption[] = [];
  for (let i = 0; i < physical.length; i++) {
    for (let j = i + 1; j < physical.length; j++) {
      const a = physical[i];
      const b = physical[j];
      const la = new Map(a.lines.map((l) => [l.key, l]));
      const lb = new Map(b.lines.map((l) => [l.key, l]));
      const linesA: Line[] = [];
      const linesB: Line[] = [];
      const missing: string[] = [];
      for (const k of keys) {
        const x = la.get(k);
        const y = lb.get(k);
        if (x && (!y || x.total <= y.total)) linesA.push(x);
        else if (y) linesB.push(y);
        else missing.push(k);
      }
      if (linesA.length === 0 || linesB.length === 0) continue;
      if (missing.length > best.missing.length) continue;
      const total = sum([...linesA, ...linesB].map((l) => l.total));
      const saving = Math.round((best.total - total) * 100) / 100;
      if (saving >= opts.minSaving) out.push({ a, b, linesA, linesB, total, missing, saving });
    }
  }
  return out.sort((x, y) => y.saving - x.saving).slice(0, opts.maxPairs ?? 3);
}

// ---------------------------------------------------------------- receipts CSV

export type ReceiptRow = { date: string | null; store: string | null; name: string; barcode: string | null; qty: number; price: number | null };

const HEADERS: Record<string, keyof ReceiptRow> = {
  date: "date", תאריך: "date",
  store: "store", סניף: "store", חנות: "store", סופר: "store",
  name: "name", item: "name", product: "name", מוצר: "name", פריט: "name", שם: "name", תיאור: "name",
  barcode: "barcode", ברקוד: "barcode", code: "barcode", "קוד": "barcode",
  quantity: "qty", qty: "qty", כמות: "qty",
  price: "price", total: "price", מחיר: "price", סכום: "price",
};

function splitCsvLine(line: string, sep: string): string[] {
  const out: string[] = [];
  let cur = "";
  let q = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (c === '"') {
      if (q && line[i + 1] === '"') { cur += '"'; i++; } else q = !q;
    } else if (c === sep && !q) { out.push(cur); cur = ""; }
    else cur += c;
  }
  out.push(cur);
  return out.map((s) => s.trim());
}

/** Accepts 2026-10-15, 15/10/2026, 15.10.26 etc. Returns YYYY-MM-DD or null. */
export function normDate(v: string): string | null {
  const iso = v.match(/^(\d{4})-(\d{1,2})-(\d{1,2})/);
  if (iso) return `${iso[1]}-${iso[2].padStart(2, "0")}-${iso[3].padStart(2, "0")}`;
  const dmy = v.match(/^(\d{1,2})[./-](\d{1,2})[./-](\d{2,4})$/);
  if (dmy) {
    const y = dmy[3].length === 2 ? `20${dmy[3]}` : dmy[3];
    return `${y}-${dmy[2].padStart(2, "0")}-${dmy[1].padStart(2, "0")}`;
  }
  return null;
}

export function parseReceiptCsv(text: string): ReceiptRow[] {
  const lines = text.replace(/^﻿/, "").split(/\r?\n/).filter((l) => l.trim());
  if (lines.length < 2) return [];
  const sep = [",", "\t", ";"].sort((a, b) => lines[0].split(b).length - lines[0].split(a).length)[0];
  const header = splitCsvLine(lines[0], sep).map((h) => HEADERS[h.toLowerCase()] ?? null);
  if (!header.includes("name")) throw new Error("חסרה עמודת שם מוצר (name / מוצר)");
  return lines.slice(1).map((l) => {
    const cells = splitCsvLine(l, sep);
    const row: ReceiptRow = { date: null, store: null, name: "", barcode: null, qty: 1, price: null };
    header.forEach((h, i) => {
      const v = cells[i] ?? "";
      if (!h || !v) return;
      if (h === "qty") row.qty = parseFloat(v.replace(",", ".")) || 1;
      else if (h === "price") row.price = parseFloat(v.replace(/[^\d.\-]/g, "")) || null;
      else if (h === "date") row.date = normDate(v);
      else row[h] = v as never;
    });
    return row;
  }).filter((r) => r.name);
}
