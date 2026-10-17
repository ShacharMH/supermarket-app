import { useEffect, useRef, useState } from "react";
import { supabase } from "../supabase";
import { loadSettings } from "../settings";
import ShoppingList from "./ShoppingList";
import ListEditor, { rememberTerms } from "./ListEditor";
import CompareTable from "./CompareTable";
import { errorText } from "../lib/errors";
import {
  bestSplits, maker, normName, parseList, rankStores, resolveItem,
  type BranchRow, type BuyMode, type ListItem, type Product, type ResolvedItem, type SplitOption, type StoreOption,
} from "../lib/basket";

type Result = {
  strict: Set<string>;
  pinned: Set<string>; // terms with a product the user picked (vs. inferred from receipts)
  excluded: Map<string, string[]>; // term -> product names marked "not this"
  items: ResolvedItem[];
  results: Map<string, Product[]>;
  stores: StoreOption[];
  splits: SplitOption[];
};

const money = (n: number) => `₪${n.toFixed(2)}`;

const kgLabel = (q: number) => (q < 1 ? `${Math.round(q * 1000)} גרם` : `${+q.toFixed(2)} ק"ג`);

function navUrl(b: BranchRow) {
  const q = [b.address, b.city].filter(Boolean).join(", ");
  return b.lat && b.lon
    ? `https://www.google.com/maps/search/?api=1&query=${b.lat},${b.lon}`
    : `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(`${b.chain_name} ${q}`)}`;
}

function storeTitle(b: BranchRow) {
  return b.is_online ? `${b.chain_name} · 🚚 אונליין (משלוח)` : `${b.chain_name} · ${b.branch_name ?? ""}`;
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
  const [editing, setEditing] = useState<string | null>(null);
  const [showAll, setShowAll] = useState(false);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
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
    rememberTerms(items.map((i) => i.key));
    setBusy(true);
    setError(null);
    try {
      const [prefs, history, clubs, termSettings] = await Promise.all([
        supabase.from("product_preferences").select("term, barcode, strict"),
        supabase.from("purchase_history").select("barcode, times_bought"),
        supabase.from("user_clubs").select("chain_id"),
        supabase.from("term_settings").select("term, mode, weight_kg, excluded"),
      ]);
      const termOpts = new Map<string, { mode?: BuyMode; weightKg?: number; excluded?: string[] }>(
        (termSettings.data ?? []).map((t) => [
          t.term,
          { mode: t.mode ?? undefined, weightKg: t.weight_kg ?? undefined, excluded: t.excluded ?? [] },
        ]),
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
          preferred: r.preferred,
        }));

      const { data, error } = await supabase.rpc("price_basket", {
        items: payload,
        penalty: settings.penalty / 100,
        clubs: (clubs.data ?? []).map((c) => c.chain_id),
      });
      if (error) throw error;
      const rows = ((data ?? []) as BranchRow[]).filter((r) => settings.includeOnline || !r.is_online);
      const keys = resolved.map((r) => r.key);
      const stores = rankStores(rows, keys, { deliveryFee: settings.deliveryFee });
      const splits = bestSplits(rows, keys, stores[0], { minSaving: settings.minSplitSaving, deliveryFee: settings.deliveryFee });
      setResult({
        items: resolved, results, stores, splits, strict, pinned: new Set(pinned.keys()),
        excluded: new Map([...termOpts].map(([k, v]) => [k, v.excluded ?? []])),
      });
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

  function setExcluded(term: string, names: string[], label: string) {
    return recalc(label, async () => {
      await supabase.from("term_settings").upsert({ term, excluded: names, updated_at: new Date().toISOString() });
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
      <ListEditor text={text} onChange={onText} />
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
              <div className="best-row">
                <div className="big">{money(best.total)}</div>
                {(() => {
                  // compare with stores that carry the same number of list items
                  const peers = result.stores.filter((o) => o.missing.length === best.missing.length);
                  const avg = peers.reduce((t, o) => t + o.total, 0) / peers.length;
                  return peers.length > 1 && avg - best.total >= 0.5 ? (
                    <div className="save-badge">חוסך {money(avg - best.total)} מהממוצע</div>
                  ) : null;
                })()}
              </div>
              {best.deliveryFee > 0 && <div className="muted small">כולל משלוח {money(best.deliveryFee)}</div>}
              {best.missing.length > 0 && <div className="warn">אין כאן: {best.missing.join(", ")}</div>}
              {!best.branch.is_online && (
                <a className="nav-link" href={navUrl(best.branch)} target="_blank" rel="noreferrer">
                  📍 {[best.branch.address, best.branch.city].filter(Boolean).join(", ")} · ניווט
                </a>
              )}
              <details className="shop-details" open>
                <summary>
                  <span className="shop-title">🛒 מה לקנות ({best.branch.lines.length})</span>
                </summary>
                <ShoppingList id={`b${best.branch.branch_id}`} title={storeTitle(best.branch)} lines={best.branch.lines} weighted={weighted} products={products} />
              </details>
            </section>
          ) : (
            <p className="note">לא נמצאו מחירים. בדקו שיש אזור בהגדרות ושהאיסוף הלילי רץ.</p>
          )}

          {best && result.stores.length > 1 && (
            <CompareTable stores={result.stores} keys={result.items.map((i) => i.key)} weighted={weighted} />
          )}

          <section className="card">
            <div className="sec-head">
              <h3>המוצרים ברשימה</h3>
              <details className="help">
                <summary aria-label="איך זה עובד">?</summary>
                <p className="muted small">
                  האפליקציה מנחשת אם קונים במשקל (ירקות, קצביה, מעדנייה) או ארוז, ובאיזו כמות. "שינוי" מאפשר לבחור מוצר
                  מסוים או אופן קנייה, והבחירה נשמרת לפעם הבאה. מוצר אחר ייבחר רק אם הוא זול ביותר מהסף שבהגדרות, אלא אם
                  מסמנים "בלי תחליפים". כל שינוי מחשב את הסל מחדש.
                </p>
              </details>
            </div>
            <ul className="items">
              {result.items.map((it) => {
                const rs = result.results.get(it.key) ?? [];
                const chosen = rs.find((p) => p.barcode === it.preferred[0]);
                const pinned = result.pinned.has(it.key);
                const both = rs.some((r) => r.is_weighted) && rs.some((r) => !r.is_weighted);
                const open = editing === it.key;
                return (
                  <li key={it.key} className={`item ${open ? "open" : ""}`}>
                    <div className="item-row">
                      <div className="item-main">
                        <div className="ikey">{it.key}</div>
                        <div className="item-sum">
                          {!rs.length ? (
                            <span className="warn">לא נמצא מוצר תואם</span>
                          ) : (
                            <>
                              <span className="chip">{it.weighted ? `⚖️ ${kgLabel(it.qty)}` : `📦 ${+it.qty.toFixed(2)} יח'`}</span>
                              <span className="muted">
                                {chosen
                                  ? pinned
                                    ? `${chosen.name}${result.strict.has(it.key) ? " בלבד" : ""}`
                                    : `כמו בקבלות: ${chosen.name}`
                                  : (() => {
                                      const l = best?.branch.lines.find((x) => x.key === it.key);
                                      return l ? `הכי זול מבין הדומים · בסל: ${l.name}` : "הכי זול מבין הדומים";
                                    })()}
                              </span>
                            </>
                          )}
                        </div>
                      </div>
                      {rs.length > 0 && (
                        <button className="edit-btn" aria-expanded={open} onClick={() => setEditing(open ? null : it.key)}>
                          {open ? "סגירה" : "שינוי"}
                        </button>
                      )}
                    </div>
                    {open && (
                      <div className="item-edit">
                        {both && (
                          <div className="seg" role="group" aria-label="אופן קנייה">
                            <button className={it.weighted ? "on" : ""} onClick={() => !it.weighted && setTerm(it.key, { mode: "weight" })}>
                              ⚖️ במשקל
                            </button>
                            <button className={!it.weighted ? "on" : ""} onClick={() => it.weighted && setTerm(it.key, { mode: "pack" })}>
                              📦 ארוז
                            </button>
                          </div>
                        )}
                        {it.weighted && (
                          <label className="grams">
                            כמות:
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
                        <select aria-label={`איזה מוצר עבור ${it.key}`} value={pinned ? it.preferred[0] : ""} onChange={(e) => pin(it.key, e.target.value)}>
                          <option value="">כל מוצר דומה (הכי זול)</option>
                          {rs.map((p) => (
                            <option key={p.barcode} value={p.barcode}>
                              {p.name}
                              {maker(p) ? ` · ${maker(p)}` : ""} · {money(p.min_price)}
                              {p.max_price !== p.min_price ? `-${money(p.max_price)}` : ""}
                              {p.is_weighted ? ' לק"ג' : ""}
                            </option>
                          ))}
                        </select>
                        {(() => {
                          // the distinct products that count as this item: the ones in the
                          // recommended basket first, then cheapest first
                          const inBasket = new Set(
                            (best?.branch.lines ?? []).filter((l) => l.key === it.key).map((l) => normName(l.name)),
                          );
                          for (const l of best?.branch.lines ?? [])
                            if (l.key === it.key) {
                              const c = it.candidates.find((x) => x.barcode === l.barcode);
                              if (c) inBasket.add(normName(c.name));
                            }
                          const seen = new Map<string, Product>();
                          for (const c of [...it.candidates].sort((a, b) => a.min_price - b.min_price))
                            if (!seen.has(normName(c.name))) seen.set(normName(c.name), c);
                          const all = [...seen].sort(([a], [b]) => Number(inBasket.has(b)) - Number(inBasket.has(a)));
                          const showAllMatches = expanded.has(it.key);
                          const shown = showAllMatches ? all : all.slice(0, 8);
                          const ex = result.excluded.get(it.key) ?? [];
                          return (
                            <div className="matches">
                              <div className="muted small">נחשבים "{it.key}" ({all.length}):</div>
                              <ul>
                                {shown.map(([n, c]) => (
                                  <li key={n} className={inBasket.has(n) ? "in-basket" : ""}>
                                    <span>
                                      {c.name}{" "}
                                      {inBasket.has(n) && <span className="tag promo">בסל המומלץ</span>}{" "}
                                      <span className="muted small">מ-{money(c.min_price)}{c.is_weighted ? ' לק"ג' : ""}</span>
                                    </span>
                                    <button
                                      className="link not-this"
                                      aria-label={`לא מתאים: ${c.name}`}
                                      onClick={() => setExcluded(it.key, [...ex, n], `"${c.name}" לא ייחשב יותר "${it.key}"`)}
                                    >
                                      ✕ לא מתאים
                                    </button>
                                  </li>
                                ))}
                              </ul>
                              {all.length > shown.length || showAllMatches ? (
                                <button
                                  className="link"
                                  onClick={() => {
                                    const next = new Set(expanded);
                                    if (showAllMatches) next.delete(it.key);
                                    else next.add(it.key);
                                    setExpanded(next);
                                  }}
                                >
                                  {showAllMatches ? "פחות" : `הצגת כל ${all.length}`}
                                </button>
                              ) : null}
                              {ex.length > 0 && (
                                <button className="link" onClick={() => setExcluded(it.key, [], `ההסרות עבור "${it.key}" בוטלו`)}>
                                  החזרת {ex.length} מוצרים שהוסרו
                                </button>
                              )}
                            </div>
                          );
                        })()}
                        {pinned && (
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
                    )}
                  </li>
                );
              })}
            </ul>
            <button disabled={busy} onClick={() => recalc("הסל חושב מחדש", async () => {})}>
              {busy ? "מחשב..." : "🔄 חשב שוב את הסל"}
            </button>
          </section>

          {result.splits.length > 0 && (
            <section className="card">
              <h3>אפשר לחסוך עוד בשני סופרים</h3>
              {result.splits.map((s) => (
                <details key={`${s.a.branch_id}-${s.b.branch_id}`} className="store">
                  <summary>
                    <span className="store-name">{s.a.chain_name} {s.a.branch_name} + {s.b.chain_name} {s.b.branch_name}</span>
                    <span className="store-price">
                      {money(s.total)} <span className="save">−{money(s.saving)}</span>
                    </span>
                  </summary>
                  <h4>{storeTitle(s.a)}</h4>
                  <ShoppingList id={`s${s.a.branch_id}-${s.b.branch_id}a`} title={storeTitle(s.a)} lines={s.linesA} weighted={weighted} products={products} />
                  <h4>{storeTitle(s.b)}</h4>
                  <ShoppingList id={`s${s.a.branch_id}-${s.b.branch_id}b`} title={storeTitle(s.b)} lines={s.linesB} weighted={weighted} products={products} />
                </details>
              ))}
            </section>
          )}

          {result.stores.length > 1 && best && (() => {
            const others = result.stores.slice(1);
            const complete = others.filter((o) => o.missing.length === best.missing.length);
            const partial = others.filter((o) => o.missing.length !== best.missing.length);
            const shown = showAll ? complete : complete.slice(0, 5);
            const row = (o: StoreOption) => (
              <details key={o.branch.branch_id} className="store">
                <summary>
                  <span className="store-name">
                    {storeTitle(o.branch)}
                    {o.branch.city && !o.branch.is_online && <span className="muted small"> · {o.branch.city}</span>}
                  </span>
                  <span className="store-price">
                    {o.missing.length === best.missing.length ? (
                      <span className="diff">+{money(o.total - best.total)}</span>
                    ) : (
                      <>
                        {money(o.total)} <span className="tag miss">חסרים {o.missing.length}</span>
                      </>
                    )}
                  </span>
                </summary>
                {!o.branch.is_online && (
                  <a className="nav-link" href={navUrl(o.branch)} target="_blank" rel="noreferrer">
                    📍 {[o.branch.address, o.branch.city].filter(Boolean).join(", ")} · ניווט
                  </a>
                )}
                <ShoppingList id={`b${o.branch.branch_id}`} title={storeTitle(o.branch)} lines={o.branch.lines} weighted={weighted} products={products} />
                {o.missing.length > 0 && <div className="warn">אין כאן: {o.missing.join(", ")}</div>}
              </details>
            );
            return (
              <section className="card">
                <h3>סניפים נוספים</h3>
                <p className="muted small">כמה יותר יעלה אותו סל בכל סניף</p>
                <div className="stores">{shown.map(row)}</div>
                {complete.length > 5 && (
                  <button className="link" onClick={() => setShowAll(!showAll)}>
                    {showAll ? "פחות" : `הצגת כל ${complete.length} הסניפים`}
                  </button>
                )}
                {partial.length > 0 && (
                  <details className="partial">
                    <summary className="muted">{partial.length} סניפים שחסרים בהם מוצרים מהרשימה</summary>
                    <div className="stores">{partial.map(row)}</div>
                  </details>
                )}
              </section>
            );
          })()}
        </>
      )}
    </div>
  );
}
