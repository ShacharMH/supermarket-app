import { useEffect, useRef, useState } from "react";
import { supabase } from "../supabase";
import { loadSettings } from "../settings";
import ShoppingList from "./ShoppingList";
import { errorText } from "../lib/errors";
import {
  bestSplits, maker, parseList, rankStores, resolveItem,
  type BranchRow, type BuyMode, type ListItem, type Product, type ResolvedItem, type SplitOption, type StoreOption,
} from "../lib/basket";

type Result = {
  strict: Set<string>;
  items: ResolvedItem[];
  results: Map<string, Product[]>;
  stores: StoreOption[];
  splits: SplitOption[];
};

const money = (n: number) => `₪${n.toFixed(2)}`;

function storeTitle(b: BranchRow) {
  return `${b.chain_name} · ${b.branch_name ?? ""}${b.is_online ? " (אונליין)" : ""}`;
}


export default function ListPage() {
  const [text, setText] = useState("");
  const [listId, setListId] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<Result | null>(null);
  const [lastRun, setLastRun] = useState<string | null>(null);
  const [tracked, setTracked] = useState<number | null>(null);
  // a toast pinned above the tab bar, visible wherever the user has scrolled to
  const [notice, setNotice] = useState<{ text: string; done: boolean } | null>(null);
  const noticeTimer = useRef<number | undefined>(undefined);
  const saveTimer = useRef<number | undefined>(undefined);

  useEffect(() => {
    (async () => {
      const { data } = await supabase.from("shopping_lists").select("id, items").order("id").limit(1);
      if (data?.[0]) {
        setListId(data[0].id);
        setText((data[0].items as { text?: string }).text ?? "");
      }
      const runs = await supabase.from("ingest_runs").select("finished_at, status").eq("status", "ok").order("id", { ascending: false }).limit(1);
      if (runs.data?.[0]?.finished_at) setLastRun(new Date(runs.data[0].finished_at).toLocaleString("he-IL"));
      const t = await supabase.from("branches").select("id", { count: "exact", head: true }).eq("tracked", true);
      setTracked(t.count ?? 0);
    })();
  }, []);

  const pending = useRef<string | null>(null);

  async function saveList(v: string) {
    pending.current = null;
    if (listId) await supabase.from("shopping_lists").update({ items: { text: v }, updated_at: new Date().toISOString() }).eq("id", listId);
    else {
      const { data } = await supabase.from("shopping_lists").insert({ items: { text: v } }).select("id").single();
      if (data) setListId(data.id);
    }
  }

  function onText(v: string) {
    setText(v);
    pending.current = v;
    window.clearTimeout(saveTimer.current);
    saveTimer.current = window.setTimeout(() => saveList(v), 800);
  }

  // don't lose the last keystrokes when the app is switched away or closed
  useEffect(() => {
    const flush = () => {
      if (pending.current !== null) {
        window.clearTimeout(saveTimer.current);
        saveList(pending.current);
      }
    };
    const onVisibility = () => document.visibilityState === "hidden" && flush();
    window.addEventListener("pagehide", flush);
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      window.removeEventListener("pagehide", flush);
      document.removeEventListener("visibilitychange", onVisibility);
    };
  });

  async function compare(): Promise<StoreOption | undefined> {
    const settings = loadSettings();
    const items = parseList(text);
    if (items.length === 0) return;
    setBusy(true);
    setError(null);
    try {
      const [prefs, history, clubs, termSettings] = await Promise.all([
        supabase.from("product_preferences").select("term, barcode, strict"),
        supabase.from("purchase_history").select("barcode, times_bought"),
        supabase.from("user_clubs").select("chain_id"),
        supabase.from("term_settings").select("term, mode, weight_kg"),
      ]);
      const termOpts = new Map<string, { mode?: BuyMode; weightKg?: number }>(
        (termSettings.data ?? []).map((t) => [t.term, { mode: t.mode ?? undefined, weightKg: t.weight_kg ?? undefined }]),
      );
      const pinned = new Map<string, string[]>();
      const strict = new Set<string>();
      for (const p of prefs.data ?? []) {
        pinned.set(p.term, [...(pinned.get(p.term) ?? []), p.barcode]);
        if (p.strict) strict.add(p.term);
      }
      const bought = new Map<string, number>((history.data ?? []).map((h) => [h.barcode, h.times_bought]));

      const search = async (fn: string, term: string, max: number, relax = true) => {
        // "בשר טחון בקר" -> "בשר טחון" -> "בשר": drop trailing words until something matches
        const words = term.split(/\s+/);
        for (let n = words.length; n >= (relax ? 1 : words.length); n--) {
          const { data, error } = await supabase.rpc(fn, { term: words.slice(0, n).join(" "), max_results: max });
          if (error) throw error;
          if (data?.length || n === 1) return (data ?? []) as Product[];
        }
        return [];
      };
      const results = new Map<string, Product[]>();
      const lookup = async (it: ListItem) => {
        // Weighed goods (butcher, deli, produce) use per-chain codes and are searched separately.
        const [packaged, weighed] = await Promise.all([
          it.byWeight ? Promise.resolve([]) : search("search_products", it.key, 40),
          // no relaxing here: "חלב 3%" -> "חלב" would find halva and toffees
          search("search_weighed", it.key, 40, !!it.byWeight),
        ]);
        const seen = new Set(packaged.map((p) => p.barcode));
        return [...packaged, ...weighed.filter((p) => !seen.has(p.barcode))];
      };
      await Promise.all(
        items.map(async (it, i) => {
          let found = await lookup(it);
          // "7 אפ": the leading number was part of the name, not a count
          if (it.raw && (!found.length || it.key.length <= 2)) {
            const asName: ListItem = { ...it, key: it.raw, qty: 1, raw: undefined };
            const byName = await lookup(asName);
            if (byName.length) {
              items[i] = asName;
              found = byName;
            }
          }
          results.set(items[i].key, found);
        }),
      );
      const resolved = items.map((it) =>
        resolveItem(it, results.get(it.key) ?? [], pinned.get(it.key) ?? [], bought, {
          strict: strict.has(it.key),
          ...termOpts.get(it.key),
        }),
      );
      const payload = resolved
        .filter((r) => r.candidates.length)
        .map((r) => ({
          key: r.key,
          qty: r.qty,
          candidates: r.candidates.map((c) => c.barcode),
          qtys: r.qtys,
          factors: r.factors,
          // a weighed item's code exists in one chain only, so preferring it would
          // penalise every other chain's equivalent - compare them on price alone
          preferred: r.weighted && !strict.has(r.key) ? [] : r.preferred,
        }));

      const { data, error } = await supabase.rpc("price_basket", {
        items: payload,
        penalty: settings.penalty / 100,
        clubs: (clubs.data ?? []).map((c) => c.chain_id),
      });
      if (error) throw error;
      const rows = (data ?? []) as BranchRow[];
      const keys = resolved.map((r) => r.key);
      const stores = rankStores(rows, keys, { deliveryFee: settings.deliveryFee });
      const splits = bestSplits(rows, keys, stores[0], { minSaving: settings.minSplitSaving, deliveryFee: settings.deliveryFee });
      setResult({ items: resolved, results, stores, splits, strict });
      return stores[0];
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  }

  async function recalc(label: string, change: () => Promise<unknown>) {
    window.clearTimeout(noticeTimer.current);
    setNotice({ text: "מחשב מחדש את הסל...", done: false });
    await change();
    const top = await compare();
    setNotice({
      text: top ? `✓ ${label}. הכי משתלם עכשיו: ${top.branch.chain_name} ${money(top.total)}` : `✓ ${label}`,
      done: true,
    });
    noticeTimer.current = window.setTimeout(() => setNotice(null), 6000);
  }

  function pin(term: string, barcode: string, strict = false) {
    return recalc(`הבחירה עבור "${term}" נשמרה`, async () => {
      await supabase.from("product_preferences").delete().eq("term", term);
      if (barcode) await supabase.from("product_preferences").insert({ term, barcode, strict });
    });
  }

  function setTerm(term: string, patch: { mode?: BuyMode; weight_kg?: number }) {
    return recalc(`"${term}" עודכן`, async () => {
      await supabase.from("term_settings").upsert({ term, ...patch, updated_at: new Date().toISOString() });
      // a product picked for the other buying mode no longer applies
      if (patch.weight_kg === undefined) await supabase.from("product_preferences").delete().eq("term", term);
    });
  }

  const best = result?.stores[0];
  const products = new Map<string, Product>();
  for (const rs of result?.results.values() ?? []) for (const p of rs) products.set(p.barcode, p);
  const weighted = new Set(result?.items.filter((i) => i.weighted).map((i) => i.key) ?? []);

  return (
    <div className="page">
      <label className="lbl" htmlFor="list">רשימת קניות (שורה לכל מוצר, אפשר "2 קוטג")</label>
      <textarea id="list" rows={8} value={text} onChange={(e) => onText(e.target.value)} placeholder={"2 קוטג\nחלב 3%\nלחם אחיד\nביצים L"} />
      <button className="primary" disabled={busy || !text.trim()} onClick={compare}>
        {busy ? "מחשב..." : "איפה הכי זול?"}
      </button>
      <p className="muted small">
        {tracked === 0 ? "עדיין אין סניפים במעקב - הוסיפו אזור בהגדרות. " : tracked ? `${tracked} סניפים במעקב. ` : ""}
        {lastRun && `מחירים עודכנו: ${lastRun}`}
      </p>
      {error && <p className="error">{error}</p>}
      {notice && (
        <div className={`toast ${notice.done ? "done" : ""}`} role="status">
          <span>{notice.text}</span>
          {notice.done && (
            <button className="link" onClick={() => window.scrollTo({ top: 0, behavior: "smooth" })}>
              לתוצאה ↑
            </button>
          )}
        </div>
      )}

      {result && (
        <>
          {best ? (
            <section className="card best">
              <div className="kicker">הכי משתלם</div>
              <h2>{storeTitle(best.branch)}</h2>
              <div className="muted">{best.branch.address} {best.branch.city}</div>
              <div className="big">{money(best.total)}</div>
              {best.deliveryFee > 0 && <div className="muted small">כולל משלוח {money(best.deliveryFee)}</div>}
              {best.missing.length > 0 && <div className="warn">חסר: {best.missing.join(", ")}</div>}
              {(() => {
                // compare only against stores that are equally complete
                const peers = result.stores.filter((o) => o.missing.length === best.missing.length);
                const worst = peers[peers.length - 1];
                return worst && worst !== best ? (
                  <div className="muted small">חוסך {money(worst.total - best.total)} לעומת הסניף היקר ביותר באזור</div>
                ) : null;
              })()}
              <h3 className="shop-title">🛒 מה לקנות</h3>
              <ShoppingList id={`b${best.branch.branch_id}`} title={storeTitle(best.branch)} lines={best.branch.lines} weighted={weighted} products={products} />
            </section>
          ) : (
            <p className="note">לא נמצאו מחירים. בדקו שיש אזור בהגדרות ושהאיסוף הלילי רץ.</p>
          )}

          {result.splits.length > 0 && (
            <section className="card">
              <h3>פיצול בין שני סופרים</h3>
              {result.splits.map((s) => (
                <details key={`${s.a.branch_id}-${s.b.branch_id}`}>
                  <summary>
                    {s.a.chain_name} {s.a.branch_name} + {s.b.chain_name} {s.b.branch_name}: <b>{money(s.total)}</b>{" "}
                    <span className="save">חוסך {money(s.saving)}</span>
                  </summary>
                  <h4>{storeTitle(s.a)}</h4>
                  <ShoppingList id={`s${s.a.branch_id}-${s.b.branch_id}a`} title={storeTitle(s.a)} lines={s.linesA} weighted={weighted} products={products} />
                  <h4>{storeTitle(s.b)}</h4>
                  <ShoppingList id={`s${s.a.branch_id}-${s.b.branch_id}b`} title={storeTitle(s.b)} lines={s.linesB} weighted={weighted} products={products} />
                </details>
              ))}
            </section>
          )}

          <section className="card">
            <h3>כל הסניפים</h3>
            <ol className="stores">
              {result.stores.map((o) => (
                <li key={o.branch.branch_id}>
                  <details>
                    <summary>
                      <span>{storeTitle(o.branch)}</span>
                      <span className="sprice">
                        {money(o.total)}
                        {o.missing.length > 0 && <span className="tag miss">חסרים {o.missing.length}</span>}
                      </span>
                    </summary>
                    <div className="muted small">{o.branch.address} {o.branch.city}</div>
                    <ShoppingList id={`b${o.branch.branch_id}`} title={storeTitle(o.branch)} lines={o.branch.lines} weighted={weighted} products={products} />
                    {o.missing.length > 0 && <div className="warn">חסר: {o.missing.join(", ")}</div>}
                  </details>
                </li>
              ))}
            </ol>
          </section>

          <section className="card">
            <h3>איך הבנתי את הרשימה</h3>
            <p className="muted small">
              האפליקציה מנחשת אם קונים במשקל (ירקות, קצביה, מעדנייה) או ארוז, ובאיזו כמות. אם הניחוש לא נכון, משנים כאן
              והבחירה נשמרת לפעם הבאה. בחירה של מוצר ספציפי הופכת אותו למועדף. מוצר אחר ייבחר רק אם הוא זול ממנו ביותר
              מהסף שבהגדרות, אלא אם מסמנים "בלי תחליפים". כל שינוי כאן מחשב את הסל מחדש מיד.
            </p>
            {result.items.map((it) => (
              <div key={it.key} className="item">
                <div className="ikey">{it.key}</div>
                {(() => {
                  const rs = result.results.get(it.key) ?? [];
                  if (!rs.length) return null;
                  const both = rs.some((r) => r.is_weighted) && rs.some((r) => !r.is_weighted);
                  return (
                    <div className="row mode">
                      {both ? (
                        <div className="seg" role="group" aria-label="אופן קנייה">
                          <button className={it.weighted ? "on" : ""} onClick={() => !it.weighted && setTerm(it.key, { mode: "weight" })}>
                            ⚖️ במשקל
                          </button>
                          <button className={!it.weighted ? "on" : ""} onClick={() => it.weighted && setTerm(it.key, { mode: "pack" })}>
                            📦 ארוז
                          </button>
                        </div>
                      ) : (
                        <span className="tag alt">{it.weighted ? "⚖️ נקנה במשקל" : "📦 ארוז"}</span>
                      )}
                      {it.weighted && (
                        <label className="grams">
                          <input
                            type="number"
                            inputMode="numeric"
                            min={50}
                            step={50}
                            defaultValue={Math.round(it.qty * 1000)}
                            key={`${it.key}-${it.qty}`}
                            onBlur={(e) => {
                              const g = Number(e.target.value);
                              if (g > 0 && Math.abs(g / 1000 - it.qty) > 0.001) setTerm(it.key, { mode: "weight", weight_kg: g / 1000 });
                            }}
                          />
                          גרם
                        </label>
                      )}
                    </div>
                  );
                })()}
                {(result.results.get(it.key) ?? []).length === 0 ? (
                  <div className="warn">לא נמצא מוצר תואם</div>
                ) : (
                  <select aria-label={`איזה מוצר עבור ${it.key}`} value={it.preferred[0] ?? ""} onChange={(e) => pin(it.key, e.target.value)}>
                    <option value="">כל מוצר דומה (הכי זול)</option>
                    {(result.results.get(it.key) ?? []).map((p) => (
                      <option key={p.barcode} value={p.barcode}>
                        {p.name}
                        {maker(p) ? ` · ${maker(p)}` : ""} · {money(p.min_price)}
                        {p.max_price !== p.min_price ? `-${money(p.max_price)}` : ""}
                        {p.is_weighted ? ' לק"ג' : ""}
                      </option>
                    ))}
                  </select>
                )}
                {it.preferred[0] && result.strict !== undefined && (
                  <label className="strict">
                    <input
                      type="checkbox"
                      checked={result.strict.has(it.key)}
                      onChange={(e) => pin(it.key, it.preferred[0], e.target.checked)}
                    />
                    רק המוצר הזה, בלי תחליפים
                  </label>
                )}
              </div>
            ))}
            <button className="primary" disabled={busy} onClick={() => recalc("הסל חושב מחדש", async () => {})}>
              {busy ? "מחשב..." : "🔄 חשב שוב את הסל"}
            </button>
          </section>
        </>
      )}
    </div>
  );
}
