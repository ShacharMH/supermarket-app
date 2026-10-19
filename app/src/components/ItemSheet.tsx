import { useEffect, useRef, useState } from "react";
import { brandOf, normName, type BuyMode, type Choice, type Line, type Product, type ResolvedItem } from "../lib/basket";

const money = (n: number) => `₪${n.toFixed(2)}`;

/** What is saved for a list term. */
export type ItemSetting = {
  choice?: Choice;
  brands: string[];
  pinned?: string; // barcode picked by hand
  strict: boolean; // pinned only, no substitutes
  excluded: string[]; // normalised names marked "not this"
};

export type ItemDraft = {
  choice: Choice;
  brands: string[];
  product: string | null;
  swap: boolean;
  excluded: string[];
  buy: BuyMode;
  grams: number;
};

/**
 * "What matters to you in X?" - one question with three answers (cheapest / brands I
 * like / one product), in a bottom sheet. Nothing is saved until "סיום".
 */
export default function ItemSheet({
  item, results, setting, line, penalty, onDone, onClose,
}: {
  item: ResolvedItem;
  results: Product[];
  setting: ItemSetting;
  line?: Line; // what the recommended basket has now
  penalty: number; // %: a substitute must be this much cheaper
  onDone: (draft: ItemDraft, changed: boolean) => void;
  onClose: () => void;
}) {
  const fromReceipts = !setting.pinned && item.preferred.length > 0 && setting.choice !== "cheapest";
  const initial: ItemDraft = {
    choice: setting.choice ?? (setting.pinned || fromReceipts ? "product" : "cheapest"),
    brands: setting.brands,
    product: setting.pinned ?? (fromReceipts ? item.preferred[0] : null),
    swap: !setting.strict,
    excluded: setting.excluded,
    buy: item.weighted ? "weight" : "pack",
    grams: Math.round(item.qty * 1000),
  };
  const [d, setD] = useState<ItemDraft>(initial);
  const finish = useRef<() => void>(onClose);
  const [showMatches, setShowMatches] = useState(false);
  const [allProducts, setAllProducts] = useState(false);
  const set = (patch: Partial<ItemDraft>) => setD({ ...d, ...patch });

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && finish.current();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const both = results.some((r) => r.is_weighted) && results.some((r) => !r.is_weighted);
  const pool = results.filter(
    (r) => !d.excluded.includes(normName(r.name)) && (!both || r.is_weighted === (d.buy === "weight")),
  );
  // one entry per name, cheapest first
  const distinct = new Map<string, Product>();
  for (const r of [...pool].sort((a, b) => a.min_price - b.min_price)) if (!distinct.has(normName(r.name))) distinct.set(normName(r.name), r);
  const products = [...distinct.values()];
  const brands = new Map<string, number>();
  for (const r of pool) {
    const b = brandOf(r);
    if (b) brands.set(b, Math.min(brands.get(b) ?? Infinity, r.min_price));
  }
  // saved brands stay on the list even when none of their products came back in this search
  for (const b of setting.brands) if (!brands.has(b)) brands.set(b, Infinity);
  const saved = (b: string) => (setting.brands.includes(b) ? 0 : 1);
  const brandList = [...brands].sort((a, b) => saved(a[0]) - saved(b[0]) || a[1] - b[1]);

  // what would be picked, from the lowest price seen (the basket decides per store)
  const cheapest = products[0];
  let pick: Product | undefined = cheapest;
  let swapped: Product | undefined;
  if (d.choice === "brands" && d.brands.length) pick = products.find((p) => d.brands.includes(brandOf(p) ?? "")) ?? cheapest;
  if (d.choice === "product" && d.product) {
    const fav = results.find((p) => p.barcode === d.product);
    if (fav && d.swap && cheapest && cheapest.min_price < fav.min_price * (1 - penalty / 100)) {
      pick = cheapest;
      swapped = fav;
    } else pick = fav ?? cheapest;
  }
  const changed = JSON.stringify(d) !== JSON.stringify(initial);
  // however the sheet is closed (סיום, סגירה, outside, Escape), what was chosen is kept
  finish.current = () => onDone(d, changed);
  const shownProducts = allProducts ? products : products.slice(0, 6);
  const selected = d.product ? results.find((p) => p.barcode === d.product) : undefined;
  if (selected && !shownProducts.some((p) => p.barcode === selected.barcode)) shownProducts.unshift(selected);
  const unit = (p: Product) => (p.is_weighted ? ' לק"ג' : "");

  const option = (choice: Choice, title: string, sub: string, body?: React.ReactNode) => (
    <div className={`opt ${d.choice === choice ? "on" : ""}`}>
      <button type="button" className="opt-head" role="radio" aria-checked={d.choice === choice} onClick={() => set({ choice, product: choice === "product" ? d.product ?? cheapest?.barcode ?? null : d.product })}>
        <span className="dot" aria-hidden />
        <span>
          <span className="opt-title">{title}</span>
          <span className="opt-sub">{sub}</span>
        </span>
      </button>
      {d.choice === choice && body}
    </div>
  );

  return (
    <>
      <div className="scrim" onClick={() => finish.current()} />
      <div className="sheet" role="dialog" aria-modal="true" aria-labelledby="sheet-title">
        <div className="sheet-in">
          <div className="grab" aria-hidden />
          <div className="sheet-head">
            <h3 id="sheet-title">{item.key}</h3>
            <button type="button" className="link" onClick={() => finish.current()}>סגירה</button>
          </div>

          {both && (
            <div className="seg" role="group" aria-label="אופן קנייה">
              <button type="button" className={d.buy === "weight" ? "on" : ""} onClick={() => set({ buy: "weight", product: null })}>⚖️ במשקל</button>
              <button type="button" className={d.buy === "pack" ? "on" : ""} onClick={() => set({ buy: "pack", product: null })}>📦 ארוז</button>
            </div>
          )}
          {d.buy === "weight" && (results.some((r) => r.is_weighted)) && (
            <label className="grams">
              כמות:
              <input type="number" inputMode="numeric" min={50} step={50} value={d.grams} onChange={(e) => set({ grams: Number(e.target.value) })} />
              גרם
            </label>
          )}

          <p className="q" id="q">מה חשוב לך ב"{item.key}"?</p>
          <div role="radiogroup" aria-labelledby="q" className="opts">
            {option("cheapest", "💰 הכי זול", "כל מוצר דומה. בכל סניף נבחר הזול ביותר.")}
            {brandList.length > 1 &&
              option(
                "brands",
                "🏷️ מותגים שאני אוהבת",
                "אחד או יותר. נבחר הזול מביניהם.",
                <div className="chips">
                  {brandList.map(([b, min]) => {
                    const on = d.brands.includes(b);
                    return (
                      <button type="button" key={b} className={`bchip ${on ? "on" : ""}`} aria-pressed={on}
                        onClick={() => set({ brands: on ? d.brands.filter((x) => x !== b) : [...d.brands, b] })}>
                        {b} {Number.isFinite(min) && <small>מ-{money(min)}</small>}
                      </button>
                    );
                  })}
                </div>,
              )}
            {option(
              "product",
              "⭐ מוצר מסוים",
              fromReceipts && d.product === item.preferred[0] ? "לפי הקבלות שלך. אפשר לבחור אחר." : "המוצר שאת רוצה, בכל סניף שבו הוא נמכר.",
              <>
                <div className="prods">
                  {shownProducts.map((p) => (
                    <button type="button" key={p.barcode} className={`prod ${d.product === p.barcode ? "on" : ""}`} aria-pressed={d.product === p.barcode} onClick={() => set({ product: p.barcode })}>
                      <span>{p.name}{brandOf(p) ? <span className="muted small"> · {brandOf(p)}</span> : null}</span>
                      <span className="price">{money(p.min_price)}{unit(p)}</span>
                    </button>
                  ))}
                </div>
                {products.length > 6 && (
                  <button type="button" className="link" onClick={() => setAllProducts(!allProducts)}>
                    {allProducts ? "פחות" : `עוד ${products.length - 6} מוצרים`}
                  </button>
                )}
                <label className="switch">
                  <span>להחליף אם יש משהו זול ממנו ביותר מ-{penalty}%</span>
                  <input type="checkbox" checked={d.swap} onChange={(e) => set({ swap: e.target.checked })} />
                </label>
              </>,
            )}
          </div>

          <div className="result">
            {changed ? "ייבחר" : "בסל"}:{" "}
            <b>{!changed && line ? results.find((r) => r.barcode === line.barcode)?.name ?? line.name : pick ? pick.name : "אין מוצר מתאים"}</b>
            {!changed && line ? <> · <b>{money(line.total)}</b></> : pick ? <span className="muted"> · מ-{money(pick.min_price)}{unit(pick)}</span> : null}
            {swapped && <div className="muted small">{swapped.name} יקר ממנו ביותר מ-{penalty}%, לכן נבחר תחליף.</div>}
          </div>

          <button type="button" className="link" aria-expanded={showMatches} onClick={() => setShowMatches(!showMatches)}>
            {showMatches ? "הסתרה" : `מה נחשב "${item.key}"? (${new Set(results.map((r) => normName(r.name))).size})`}
          </button>
          {showMatches && (
            <div className="matches">
              {(() => {
                // one row per name, the basket's product first (under its catalogue name;
                // the store may call it something else: "אטריות אסם תלתלים")
                const byName = new Map<string, Product>();
                const inBasket = results.find((r) => r.barcode === line?.barcode);
                if (inBasket) byName.set(normName(inBasket.name), inBasket);
                for (const r of results) if (!byName.has(normName(r.name))) byName.set(normName(r.name), r);
                return [...byName.entries()];
              })().map(([n, r]) => {
                const out = d.excluded.includes(n);
                const here = r.barcode === line?.barcode;
                return (
                  <div key={n} className={out ? "x" : ""}>
                    <span>
                      {r.name}
                      {here && <span className="tag promo">בסל</span>}
                    </span>
                    <button type="button" className="link not-this" aria-label={`${out ? "החזרה" : "לא מתאים"}: ${r.name}`}
                      onClick={() => set({ excluded: out ? d.excluded.filter((x) => x !== n) : [...d.excluded, n] })}>
                      {out ? "↩ החזרה" : "✕ לא מתאים"}
                    </button>
                  </div>
                );
              })}
            </div>
          )}

          <button type="button" className="primary done" onClick={() => onDone(d, changed)}>סיום</button>
        </div>
      </div>
    </>
  );
}
