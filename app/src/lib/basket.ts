// Pure shopping-basket logic (no I/O) so it can be unit-tested.

export type ListItem = { key: string; qty: number };

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
export function parseList(text: string): ListItem[] {
  const out: ListItem[] = [];
  for (const raw of text.split(/\n|,/)) {
    let line = raw.replace(/^[\s\-•*·]+/, "").trim();
    if (!line) continue;
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
    out.push({ key: line.trim(), qty: qty > 0 ? qty : 1 });
  }
  // merge duplicates
  const merged = new Map<string, ListItem>();
  for (const it of out) {
    const prev = merged.get(it.key);
    merged.set(it.key, prev ? { key: it.key, qty: prev.qty + it.qty } : it);
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
): ResolvedItem {
  if (results.length === 0) return { ...item, candidates: [], preferred: [], reference: null };

  let preferred = pinned.filter((b) => results.some((r) => r.barcode === b));
  if (preferred.length === 0) {
    preferred = results
      .filter((r) => bought.has(r.barcode))
      .sort((a, b) => (bought.get(b.barcode) ?? 0) - (bought.get(a.barcode) ?? 0))
      .map((r) => r.barcode);
  }
  const reference = results.find((r) => r.barcode === preferred[0]) ?? results[0];
  const candidates = results.filter(
    (r) => preferred.includes(r.barcode) || similarSize(r, reference),
  );
  return { ...item, candidates, preferred, reference };
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
      else row[h] = v as never;
    });
    return row;
  }).filter((r) => r.name);
}
