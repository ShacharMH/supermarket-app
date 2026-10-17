// Pure shopping-basket logic (no I/O) so it can be unit-tested.
import { categoryOf } from "./categories";

/** key: what to search for (and pin preferences by); qty: count, or kg for weighed items. */
export type ListItem = {
  key: string;
  qty: number;
  weightKg?: number;
  volumeL?: number;
  byWeight?: boolean;
  raw?: string; // the line before a leading count was taken off ("7 אפ"), to retry as a name
  counted?: boolean; // the line gives a number of units ("3 עגבניות", "ביצים 2 חבילות")
};

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
  qtys?: Record<string, number>; // packs of each candidate that fill a requested size
  factors?: Record<string, number>; // per-gram/ml comparison factor for similar packs
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
  // a promotion this line doesn't reach yet ("2 ב-10" when buying 1)
  hint?: string;
  hint_qty?: number;
  hint_unit?: number;
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

// "5 ליטר", "1.5 ל'", "750 מ\"ל" - a pack size (liquids are never sold by weight)
const VOLUME_RE = /(\d+(?:[.,]\d+)?)\s*(ליטרים|ליטר|ל'|ל׳|מ"ל|מ״ל|מל|מיליליטר|ml|lt|l)(?=\s|$)/i;

// "5 יחידות", "3 יח'", "4 בקבוקים", "2 חבילות" anywhere in the line
const COUNT_RE = /(\d+)\s*(יחידות|יחידה|יח'|יח׳|יח|פריטים|חבילות|חבילה|אריזות|קופסאות|בקבוקים|שקיות|פחיות)(?=\s|$)/;

function toLitres(amount: number, unit: string): number {
  return /^(ליטרים|ליטר|ל'|ל׳|lt|l)$/i.test(unit) ? amount : amount / 1000;
}

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
    let volumeL: number | undefined;
    const v = weightKg ? null : line.match(VOLUME_RE);
    if (v) {
      volumeL = toLitres(parseFloat(v[1].replace(",", ".")), v[2]);
      line = (line.slice(0, v.index) + line.slice((v.index ?? 0) + v[0].length)).replace(/\s+/g, " ").trim();
    }
    let byWeight = false;
    if (line.match(BY_WEIGHT_RE)) {
      byWeight = true;
      line = line.replace(BY_WEIGHT_RE, " ").replace(/\s+/g, " ").trim();
    }
    let qty = 1;
    let counted = false;
    const c = line.match(COUNT_RE);
    if (c) {
      qty = parseInt(c[1], 10);
      counted = true;
      line = (line.slice(0, c.index) + line.slice((c.index ?? 0) + c[0].length)).replace(/\s+/g, " ").trim();
    }
    const beforeCount = line;
    // a leading number is a count ("5 קוטג") unless it is part of a name ("3 ב-1 שמפו")
    const lead = counted ? null : line.match(/^(\d+(?:\.\d+)?)\s*(?:x|×|\*)?\s+(?!ב-?\s*\d)(?!%)(.+)$/i);
    const trail = counted ? null : line.match(/^(.+?)\s*(?:x|×|\*)\s*(\d+(?:\.\d+)?)$/i);
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
    if (volumeL) item.volumeL = volumeL;
    if (byWeight) item.byWeight = true;
    if (lead) item.raw = beforeCount;
    if (lead || trail || counted) item.counted = true;
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

// pack size written in a product name: "4 ל'", "1.5ל", "250ג'", "750 מ\"ל", "1 ליט"
const NAME_SIZE_RE = /(\d+(?:\.\d+)?)\s*(ק"ג|ק״ג|קג|קילו|גרם|גר|ג|ליטר|ליט|ל|מ"ל|מ״ל|מל)(?=[\s'"׳״.,)\-]|$)/g;

function nameAmount(name: string): [string, number] | null {
  const all = [...name.matchAll(NAME_SIZE_RE)];
  const m = all[all.length - 1];
  if (!m) return null;
  const n = parseFloat(m[1]);
  const u = m[2].replace(/["״]/g, "");
  if (/^(קג|קילו)$/.test(u)) return ["g", n * 1000];
  if (/^(גרם|גר|ג)$/.test(u)) return ["g", n];
  if (/^(ליטר|ליט|ל)$/.test(u)) return ["ml", n * 1000];
  return ["ml", n];
}

function baseAmount(p: Product): [string, number] | null {
  // the name is more reliable than the published unit, which is often wrong
  // ("גרם" for a 4-litre bottle) or missing ("לא ידוע")
  const fromName = nameAmount(p.name);
  if (fromName) return fromName;
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

/** The product whose pack size is closest to the requested one (same unit), if any. */
function closestPack(pool: Product[], [unit, amount]: [string, number]): Product | null {
  let best: Product | null = null;
  let bestRatio = Infinity;
  for (const p of pool) {
    const a = baseAmount(p);
    if (!a || a[0] !== unit) continue;
    const ratio = Math.max(a[1], amount) / Math.min(a[1], amount);
    if (ratio < bestRatio) {
      best = p;
      bestRatio = ratio;
    }
  }
  return best;
}

const NAME_NOISE = /^(\d+%?|\(?\d+\)?|ק"ג|קג|גרם|גר|שקיל|במשקל|מס|של|עם|ב|ו|ל|-)$/;

/**
 * Words that describe what kind of product this is beyond the list term
 * ("בשר בקר טחון טרי" for "בשר טחון" -> בקר, טרי). Returns a matcher for products
 * of the same kind, or null when the name adds nothing.
 */
export function sameKind(p: Product | null, term: string): ((r: Product) => boolean) | null {
  if (!p) return null;
  const norm = (x: string) => x.replace(/["'`׳״()]/g, "").toLowerCase();
  const termWords = new Set(norm(term).split(/\s+/));
  const words = norm(p.name)
    .split(/\s+/)
    .filter((w) => w.length >= 2 && !termWords.has(w) && !NAME_NOISE.test(w));
  if (!words.length) return null;
  return (r) => {
    const name = ` ${norm(r.name)} `;
    return r.barcode === p.barcode || words.every((w) => name.includes(` ${w}`));
  };
}

export type BuyMode = "weight" | "pack";

// What people usually buy by weight, with a sensible default amount (kg).
const WEIGHED_HINTS: [RegExp, number][] = [
  // produce
  [/^(עגבני|מלפפו|פלפל|גזר|בצל|שום|תפוח|תפו"א|תפוא|בטטה|קישוא|חציל|כרוב|כרובית|ברוקולי|סלק|לפת|קולורבי|דלעת|דלורית|תירס|אבוקדו|לימו|תפוז|קלמנטינ|מנדרינ|אשכולית|בננ|אגס|ענב|אפרסק|נקטרינ|שזיף|משמש|מנגו|קיווי|רימו|אבטיח|מלון|תמר|פטריות|ג'ינג'ר|גינגר)/, 1],
  // butcher
  [/(בשר|טחון|אנטריקוט|סינטה|פילה|צלעות|אסאדו|שייטל|כתף|צוואר|כבד|לבבות|פרגית|כנפיים|שוקיים|חזה עוף|עוף שלם|כרעיים|קבב|המבורגר טרי)/, 0.5],
  // fish counter
  [/(סלמו|דג |^דג$|דגים|אמנו|דניס|לברק|מוסר|בורי|טונה טרי|פילה דג)/, 0.5],
  // deli counter
  [/(גבינה צהובה|גבינה בולגרית|גבינה מלוחה|פסטרמה|נקניק|סלמי|הודו פרוס|זיתים|חלבה|חמוצים במשקל)/, 0.2],
  // nuts & bulk
  [/(אגוז|שקדים|קשיו|פיסטוק|בוטנים|גרעינים|פיצוחים|צימוקים|פירות יבשים|תמרים)/, 0.2],
];

// Rough weight of one piece of produce (kg), for "3 עגבניות" when sold by weight.
const UNIT_WEIGHTS: [RegExp, number][] = [
  [/^(עגבני|מלפפו|בצל|אפרסק|נקטרינ|בננ)/, 0.15], [/^(פלפל|תפוח|אגס|קישוא|אבוקדו)/, 0.2], [/^גזר/, 0.1],
  [/^(בטטה|תפוז|רימו)/, 0.3], [/^(חציל|מנגו)/, 0.35], [/^(לימו)/, 0.12], [/^(קלמנטינ|מנדרינ)/, 0.1],
  [/^(שזיף|משמש)/, 0.07], [/^קיווי/, 0.08], [/^(כרובית|ברוקולי)/, 0.7], [/^כרוב/, 1], [/^מלון/, 1.5],
  [/^אבטיח/, 5], [/^(דלעת|דלורית)/, 1.5],
];

/** Approximate kg per piece, or null when unknown. */
export function unitWeight(term: string): number | null {
  const t = term.trim();
  for (const [re, kg] of UNIT_WEIGHTS) if (re.test(t)) return kg;
  return null;
}

export function weighedHint(term: string): number | null {
  const t = term.replace(/[׳']/g, "'").trim();
  for (const [re, kg] of WEIGHED_HINTS) if (re.test(t)) return kg;
  return null;
}

/** The usual amount of a weighed item: a kilo of produce, half a kilo of meat, 200g from the deli. */
export function defaultKg(term: string): number {
  const hint = weighedHint(term);
  if (hint !== null) return hint;
  const cat = categoryOf(term).id;
  return cat === "produce" ? 1 : cat === "meat" ? 0.5 : 0.2;
}

/**
 * What the shelves say about a term (from term_kinds): "weight" - mostly sold by
 * weight (the deli's "גאודה עיזים"), "either" - some weighed products exist,
 * "pack" - only packaged.
 */
export type TermKind = "weight" | "either" | "pack";
export type TermCounts = { weighed_start: number; packed_start: number; weighed_all: number; packed_all: number };

export function termKind(c: TermCounts): TermKind {
  const [w, p] = c.weighed_start + c.packed_start > 0 ? [c.weighed_start, c.packed_start] : [c.weighed_all, c.packed_all];
  if (w + p > 0 && w / (w + p) >= 0.5) return "weight";
  return c.weighed_all > 0 ? "either" : "pack";
}

// same normalisation as the database: no quotes, final letters as regular letters
export const normName = (s: string) =>
  s.replace(/["'`׳״]/g, "").toLowerCase().replace(/[ךםןףץ]/g, (c) => "כמנפצ"["ךםןףץ".indexOf(c)]).replace(/\s+/g, " ").trim();

/** Hebrew stem for matching words: מלפפונים -> מלפפונ, עגבניות -> עגבנ (as he_stem in SQL). */
export function heStem(w: string): string {
  if (w.length < 5 || !/^[א-ת]+$/.test(w)) return w;
  return w.replace(/(ימ|ות|יה|ה)$/, "").replace(/י$/, "");
}

// Processed, premium or "contains it" products: never chosen for a plain term like
// "מלפפונים" or "עגבניות" unless the line asks for them ("מלפפונים חמוצים").
const SPECIAL_WORDS = [
  "אורגני", "שרי", "מרוסק", "כבוש", "חמוצ", "חמוצים", "במלח", "בחומצ", "חומצ", "משומר", "שימורימ", "קפוא", "מקפוא",
  "מיובש", "רסק", "ממרח", "סלט", "ברוטב", "רוטב", "גאודה", "גבינ", "זיתימ", "ירקות", "מארז", "פרימיומ", "קלוי",
  "מטוגנ", "מבושל", "מעושנ", "ממולא", "צלוי", "טחינ", "ממתק", "סוכריות",
].map((w) => normName(w));

function isSpecialFor(name: string, term: string): boolean {
  const termStems = normName(term).split(" ").map(heStem);
  // the line already asks for something special ("מלפפונים במלח") - don't second-guess it
  if (termStems.some((t) => SPECIAL_WORDS.some((sw) => t.startsWith(heStem(sw))))) return false;
  return normName(name)
    .split(/[\s/,\-()]+/)
    .some((w) => SPECIAL_WORDS.some((sw) => w.startsWith(heStem(sw))) && !termStems.some((t) => w.startsWith(t)));
}

export type ResolveOptions = {
  strict?: boolean; // pinned product only, no substitutes
  mode?: BuyMode; // the user's explicit choice for this term
  weightKg?: number; // the user's saved amount for this term
  excluded?: string[]; // normalised product names the user marked "not this"
};

/**
 * Decide which products may fill a list item, and whether it is bought by weight.
 * Order of evidence for by-weight vs packaged: the user's explicit choice, words in
 * the line ("מהקצביה"), the pinned product, what receipts show was bought, a
 * built-in category hint, and finally what the matching products on the shelf are.
 */
export function resolveItem(
  item: ListItem,
  results: Product[],
  pinned: string[],
  bought: Map<string, number>,
  opts: ResolveOptions = {},
): ResolvedItem {
  // what the user ruled out, then processed/premium variants unless asked for (or all that's left)
  const excluded = new Set(opts.excluded ?? []);
  results = results.filter((r) => pinned.includes(r.barcode) || !excluded.has(normName(r.name)));
  const plain = results.filter((r) => pinned.includes(r.barcode) || !isSpecialFor(r.name, item.key));
  if (plain.length) results = plain;
  if (results.length === 0) return { ...item, weighted: false, candidates: [], preferred: [], reference: null };
  const weighed = results.filter((r) => r.is_weighted);
  const packed = results.filter((r) => !r.is_weighted);

  let preferred = pinned.filter((b) => results.some((r) => r.barcode === b));
  const isPinned = preferred.length > 0;
  const boughtHere = results
    .filter((r) => bought.has(r.barcode))
    .sort((a, b) => (bought.get(b.barcode) ?? 0) - (bought.get(a.barcode) ?? 0));
  if (!isPinned) preferred = boughtHere.map((r) => r.barcode);

  const hintKg = weighedHint(item.key);
  let mode: BuyMode | undefined = opts.mode ?? (item.byWeight ? "weight" : undefined);
  // nobody said how it is bought: deli and packaged products may compete on price per gram
  const auto = !mode && !isPinned && !boughtHere.length;
  if (!mode && isPinned) mode = results.find((r) => r.barcode === preferred[0])!.is_weighted ? "weight" : "pack";
  if (!mode && boughtHere.length) mode = boughtHere[0].is_weighted ? "weight" : "pack";
  if (!mode && hintKg !== null && weighed.length) mode = "weight";
  // "2 גאודה עיזים" / "גאודה עיזים 1 יח'": whole packages, unless pieces of produce
  if (!mode && hintKg === null && item.counted && unitWeight(item.key) === null && packed.length) mode = "pack";
  if (!mode) {
    // what the shelf says: among products whose name starts with the term, are most weighed?
    const key = normName(item.key);
    const starts = results.filter((r) => normName(r.name).startsWith(key));
    const pool = starts.length ? starts : results.slice(0, 10);
    mode = pool.filter((r) => r.is_weighted).length / pool.length >= 0.5 ? "weight" : "pack";
  }
  if (mode === "weight" && !weighed.length) mode = "pack";
  if (mode === "pack" && !packed.length) mode = "weight";

  const pool = mode === "weight" ? weighed : packed;
  const wanted: [string, number] | null =
    mode === "pack" && item.volumeL ? ["ml", item.volumeL * 1000]
    : mode === "pack" && item.weightKg ? ["g", item.weightKg * 1000]
    : null;
  let reference = pool.find((r) => r.barcode === preferred[0]) ?? null;
  if (!reference && wanted) reference = closestPack(pool, wanted); // "אקונומיקה 5 ליטר"
  reference ??= pool[0];
  const weighted = mode === "weight";
  // Weighed goods: every chain has its own code for "בשר בקר טחון טרי", so a picked or
  // bought product stands for all products with the same describing words.
  if (weighted && preferred.length) {
    const like = sameKind(results.find((r) => r.barcode === preferred[0]) ?? null, item.key);
    if (like) preferred = weighed.filter(like).map((r) => r.barcode);
  }
  let candidates: Product[];
  const qtys: Record<string, number> = {};
  const factors: Record<string, number> = {};
  if (opts.strict && isPinned) {
    candidates = results.filter((r) => preferred.includes(r.barcode));
  } else if (wanted) {
    // a size was asked for: any pack of that kind from 20% to 200% of it, bought in
    // as many packs as it takes (5 litres = 1 x 4L or 5 x 1L), compared on the total
    const [unit, amount] = wanted;
    candidates = pool.filter((r) => {
      const a = baseAmount(r);
      return preferred.includes(r.barcode) || (a && a[0] === unit && a[1] >= amount * 0.2 && a[1] <= amount * 2);
    });
  } else {
    candidates = results.filter((r) => preferred.includes(r.barcode) || similarSize(r, reference));
  }
  const ref = baseAmount(reference);
  for (const r of candidates) {
    const a = baseAmount(r);
    if (weighted || !a) continue;
    if (wanted && a[0] === wanted[0]) {
      qtys[r.barcode] = Math.max(1, Math.round(wanted[1] / a[1])) * item.qty;
    } else if (!wanted && ref && a[0] === ref[0] && a[1] !== ref[1]) {
      // similar packs compared per gram/ml: 300g for 7 beats 250g for 6.50
      factors[r.barcode] = Math.round((ref[1] / a[1]) * 1000) / 1000;
    }
  }
  // weighed goods: qty is kilograms; packaged goods: qty is a count
  // "3 עגבניות" is three tomatoes (~150g each); "בשר טחון" alone is the usual amount
  const kgEach =
    item.weightKg ??
    (item.counted ? unitWeight(item.key) : null) ??
    opts.weightKg ?? defaultKg(item.key);
  const qty = weighted ? Math.round(kgEach * item.qty * 1000) / 1000 : item.qty;
  // deli-type items only: produce and fresh meat aren't swapped for packed ones
  const deliLike = hintKg !== null ? hintKg < 0.5 : !["produce", "meat"].includes(categoryOf(item.key).id);
  if (weighted && auto && !opts.strict && deliLike) {
    // 200g of goat gouda: the deli at ₪98/kg (₪19.60) vs a 160g pack at ₪20.90,
    // compared per gram; packs only when 1-3 of them come close to the amount
    const wantG = qty * 1000;
    for (const r of packed) {
      const a = baseAmount(r);
      if (!a || a[0] !== "g") continue;
      const packs = Math.max(1, Math.round(wantG / a[1]));
      const got = packs * a[1];
      if (packs > 3 || got < wantG * 0.5 || got > wantG * 2) continue;
      candidates.push(r);
      qtys[r.barcode] = packs;
      factors[r.barcode] = Math.round((wantG / got) * 1000) / 1000;
    }
  }
  const out: ResolvedItem = { ...item, qty, weighted, candidates, preferred, reference };
  if (Object.keys(qtys).length) out.qtys = qtys;
  if (Object.keys(factors).length) out.factors = factors;
  return out;
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

// ---------------------------------------------------------------- shopping list

const fmtKg = (q: number) => (q < 1 ? `${Math.round(q * 1000)} גרם` : `${+q.toFixed(2)} ק"ג`);

export function packSize(p: Product | undefined): string | null {
  if (!p || p.is_weighted || !p.quantity || p.quantity <= 0) return null;
  const u = normUnit(p.unit_of_measure);
  const label: Record<string, string> = { g: "גרם", kg: 'ק"ג', ml: 'מ"ל', l: "ליטר" };
  return label[u] ? `${+p.quantity.toFixed(2)} ${label[u]}` : null;
}

/** Whether a basket line is bought by weight: by its product, as deli and packs can mix. */
export function lineWeighed(l: Line, weighted: Set<string>, products: Map<string, Product>): boolean {
  return products.get(l.barcode)?.is_weighted ?? weighted.has(l.key);
}

/** How much to put in the cart, in words: "2 יח'" or "500 גרם". */
export function howMuch(l: Line, weighted: boolean): string {
  return weighted ? fmtKg(l.qty) : `${+l.qty.toFixed(2)} יח'`;
}

const UNKNOWN_MAKER = /^(לא ידוע|כללי|tbd|unknown|,|-|0)?$/i;

/** The manufacturer, unless the chain published a placeholder. */
export function maker(p: Product | undefined): string | null {
  const m = p?.manufacturer?.trim();
  return m && !UNKNOWN_MAKER.test(m) ? m : null;
}

/** "Buy 2 and pay ₪5.00 each instead of ₪6.50 (save ₪3.00)" - or null when not worth saying. */
export function promoHint(l: Line): { text: string; saving: number } | null {
  if (!l.hint || !l.hint_qty || l.hint_unit == null || l.hint_qty <= l.qty) return null;
  const saving = Math.round((l.price - l.hint_unit) * l.hint_qty * 100) / 100;
  if (saving < 0.5) return null;
  const extra = l.hint_qty - l.qty;
  return {
    text: `מבצע "${l.hint}": עוד ${extra === 1 ? "יחידה אחת" : `${extra} יחידות`} ותשלמו ₪${l.hint_unit.toFixed(2)} ליחידה במקום ₪${l.price.toFixed(2)}`,
    saving,
  };
}

/** A real barcode worth showing (chain-internal codes are "chain:code"). */
export function shelfBarcode(code: string): string | null {
  return code.includes(":") ? null : code;
}

/** Plain-text list for sharing (WhatsApp, notes...). */
export function shoppingText(
  title: string,
  lines: Line[],
  weighted: Set<string>,
  products: Map<string, Product>,
): string {
  const rows = lines.map((l) => {
    const p = products.get(l.barcode);
    const bits = [`☐ ${howMuch(l, lineWeighed(l, weighted, products))} · ${l.name}`];
    const size = packSize(p);
    const m = maker(p);
    if (m) bits.push(m);
    if (size) bits.push(size);
    let row = bits.join(" · ") + ` - ₪${l.total.toFixed(2)}`;
    if (l.promo) row += ` (מבצע: ${l.promo})`;
    if (!l.preferred) row += " (תחליף)";
    return row;
  });
  const total = lines.reduce((s, l) => s + l.total, 0);
  return [`🛒 ${title}`, ...rows, `סה"כ משוער: ₪${total.toFixed(2)}`].join("\n");
}

// ---------------------------------------------------------------- list editing

/** Change how many of a list line to buy, keeping the rest of what was written. */
export function setLineQty(line: string, qty: number): string {
  let rest = line.trim();
  const counted = rest.match(COUNT_RE);
  if (counted) {
    // "ביצים 2 חבילות" keeps its unit word
    return qty > 0 ? rest.replace(COUNT_RE, `${qty} ${counted[2]}`) : rest;
  }
  const parsed = parseList(rest)[0];
  if (parsed?.raw) rest = rest.replace(/^\d+(?:\.\d+)?\s*(?:x|×|\*)?\s+/i, "");
  else rest = rest.replace(/\s*(?:x|×|\*)\s*\d+(?:\.\d+)?$/i, "");
  return qty > 1 ? `${qty} ${rest}` : rest;
}

const fmtWeight = (kg: number) => (kg < 1 ? `${Math.round(kg * 1000)} גרם` : `${+kg.toFixed(2)} ק"ג`);

export type LineAmount =
  | { mode: "kg"; kg: number; step: number; canUnits: boolean }
  | { mode: "unit"; count: number; approxKg: number | null; canKg: boolean };

/**
 * How a list line is bought, for the editor: by weight (kg) or a number of units.
 * `kind` is what the shelves say about terms the built-in hints don't know.
 */
export function lineAmount(line: string, kind?: TermKind): LineAmount | null {
  const it = parseList(line)[0];
  if (!it) return null;
  let hint = weighedHint(it.key);
  if (hint === null && kind === "either" && !it.weightKg) {
    // packaged by default, a weight can be asked for
    return { mode: "unit", count: it.qty, approxKg: null, canKg: true };
  }
  if (hint === null && kind && kind !== "pack") hint = defaultKg(it.key);
  const step = hint === null ? 0.25 : hint >= 1 ? 0.5 : hint >= 0.5 ? 0.25 : 0.1;
  if (it.weightKg) return { mode: "kg", kg: Math.round(it.weightKg * it.qty * 1000) / 1000, step, canUnits: hint !== null };
  if (hint !== null && !it.counted && !it.volumeL) return { mode: "kg", kg: hint, step, canUnits: true };
  const per = hint !== null ? unitWeight(it.key) : null;
  return { mode: "unit", count: it.qty, approxKg: per ? Math.round(per * it.qty * 1000) / 1000 : null, canKg: hint !== null };
}

/** The line text without amounts: "3 עגבניות", "עגבניות 2 ק\"ג" -> "עגבניות". */
function lineName(line: string): string {
  let rest = line.replace(WEIGHT_RE, " ").replace(COUNT_RE, " ").replace(/\s+/g, " ").trim();
  rest = rest.replace(/\s*(?:x|×|\*)\s*\d+(?:\.\d+)?$/i, "");
  if (parseList(rest)[0]?.raw) rest = rest.replace(/^\d+(?:\.\d+)?\s*(?:x|×|\*)?\s+/i, "");
  return rest.trim();
}

/** Set a by-weight amount: "עגבניות" -> "עגבניות 1.5 ק\"ג". */
export function setLineWeight(line: string, kg: number): string {
  return `${lineName(line)} ${fmtWeight(Math.round(kg * 1000) / 1000)}`;
}

/** Set a number of pieces explicitly: "עגבניות 3 יח'" (so it isn't read as the default weight). */
export function setLineUnits(line: string, count: number): string {
  return `${lineName(line)} ${count} יח'`;
}
