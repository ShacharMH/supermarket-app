import { useEffect, useRef, useState } from "react";
import { supabase } from "../supabase";
import { loadSettings } from "../settings";
import ShoppingList from "./ShoppingList";
import ListEditor, { rememberTerms } from "./ListEditor";
import CompareTable from "./CompareTable";
import ItemSheet, { type ItemDraft, type ItemSetting } from "./ItemSheet";
import { errorText } from "../lib/errors";
import { saveKinds } from "../lib/termKinds";
import {
  bestSplits, hahishookSplit, HAHISHOOK, HAHISHOOK_FEE, nameFits, normName, parseList, rankStores, resolveItem, weighedHint,
  type BranchRow, type BuyMode, type Choice, type Point, type ListItem, type Product, type ResolvedItem, type SplitOption, type StoreOption,
} from "../lib/basket";

type Result = {
  strict: Set<string>;
  pinned: Set<string>; // terms with a product the user picked (vs. inferred from receipts)
  excluded: Map<string, string[]>; // term -> product names marked "not this"
  settings: Map<string, ItemSetting>; // what was chosen in the item sheet
  items: ResolvedItem[];
  results: Map<string, Product[]>;
  stores: StoreOption[];
  splits: SplitOption[];
  withHahishook: SplitOption | null; // part of the best basket from החישוק, if it saves anything
};

const money = (n: number) => `₪${n.toFixed(2)}`;

const kgLabel = (q: number) => (q < 1 ? `${Math.round(q * 1000)} גרם` : `${+q.toFixed(2)} ק"ג`);

function navUrl(b: BranchRow) {
  const q = [b.address, b.city].filter(Boolean).join(", ");
  // a town-centre point would navigate to the wrong place: search the address instead
  return b.geo_exact && b.lat && b.lon
    ? `https://www.google.com/maps/search/?api=1&query=${b.lat},${b.lon}`
    : `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(`${b.chain_name} ${q}`)}`;
}

/** "2.1 ק\"מ" from home; "≈" when the store is only placed by its town. */
function distLabel(o: StoreOption): string | null {
  if (o.distanceKm == null) return null;
  const km = o.distanceKm < 10 ? o.distanceKm.toFixed(1) : Math.round(o.distanceKm).toString();
  return `${o.branch.geo_exact ? "" : "≈"}${km} ק"מ`;
}

/** At the bottom of a long open box: close it and go back to its title. */
function CloseBox() {
  return (
    <button
      type="button"
      className="link close-box"
      onClick={(e) => {
        const box = e.currentTarget.closest("details");
        if (!box) return;
        box.open = false;
        box.querySelector("summary")?.scrollIntoView({ block: "nearest", behavior: "smooth" });
      }}
    >
      ▴ סגירה
    </button>
  );
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
      const [prefs, history, clubs, termSettings, profile, areas, located, boughtProducts, boughtNames] = await Promise.all([
        supabase.from("product_preferences").select("term, barcode, strict"),
        supabase.from("purchase_history").select("barcode, times_bought"),
        supabase.from("user_clubs").select("chain_id"),
        supabase.from("term_settings").select("term, mode, weight_kg, excluded, choice, brands"),
        supabase.from("user_profile").select("home_lat, home_lon").maybeSingle(),
        supabase.from("user_areas").select("lat, lon").not("lat", "is", null).order("id").limit(1),
        supabase.from("branches").select("id").eq("tracked", true).eq("geo_exact", true),
        supabase.rpc("bought_products"),
        supabase.rpc("bought_product_names"),
      ]);
      // starred purchases with all their shelf names: the catalogue name is often generic
      const shelfNames = new Map<string, string[]>();
      for (const r of (boughtNames.data ?? []) as { barcode: string; item_name: string }[])
        shelfNames.set(r.barcode, [...(shelfNames.get(r.barcode) ?? []), r.item_name]);
      const boughtFor = (term: string) =>
        ((boughtProducts.data ?? []) as Product[]).flatMap((p) => {
          if (nameFits(term, p.name)) return [p];
          const shelf = shelfNames.get(p.barcode)?.find((n) => nameFits(term, n));
          return shelf ? [{ ...p, name: shelf }] : [];
        });
      // distances are from home, or else from the centre of the first area
      const area = areas.data?.[0];
      const home: Point | null =
        profile.data?.home_lat != null ? { lat: profile.data.home_lat, lon: profile.data.home_lon }
        : area ? { lat: area.lat, lon: area.lon } : null;
      const exact = new Set((located.data ?? []).map((b) => b.id as number));
      const termOpts = new Map<string, { mode?: BuyMode; weightKg?: number; excluded?: string[]; choice?: Choice; brands?: string[] }>(
        (termSettings.data ?? []).map((t) => [
          t.term,
          {
            mode: t.mode ?? undefined, weightKg: t.weight_kg ?? undefined, excluded: t.excluded ?? [],
            choice: t.choice ?? undefined, brands: t.brands ?? [],
          },
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
        const found = [...packaged, ...weighed.filter((p) => !seen.has(p.barcode))];
        // what you bought counts even when the shelf name is shortened beyond search
        for (const p of found) seen.add(p.barcode);
        return [...found, ...boughtFor(it.key).filter((p) => !seen.has(p.barcode))];
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
      const rows = ((data ?? []) as BranchRow[])
        .filter((r) => settings.includeOnline || !r.is_online)
        .map((r) => ({ ...r, geo_exact: exact.has(r.branch_id) }));
      const keys = resolved.map((r) => r.key);
      // החישוק carries a few hundred pantry items: never a whole basket, only a split
      const shops = rows.filter((r) => r.chain_id !== HAHISHOOK);
      const stores = rankStores(shops, keys, { deliveryFee: settings.deliveryFee, home });
      const splits = bestSplits(shops, keys, stores[0], { minSaving: settings.minSplitSaving, deliveryFee: settings.deliveryFee, home });
      const withHahishook = hahishookSplit(rows, keys, stores[0]);
      setResult({
        items: resolved, results, stores, splits, withHahishook, strict, pinned: new Set(pinned.keys()),
        excluded: new Map([...termOpts].map(([k, v]) => [k, v.excluded ?? []])),
        settings: new Map(
          items.map((it) => {
            const o = termOpts.get(it.key);
            return [it.key, {
              choice: o?.choice, brands: o?.brands ?? [], excluded: o?.excluded ?? [],
              pinned: pinned.get(it.key)?.[0], strict: strict.has(it.key),
            }];
          }),
        ),
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


  /** Everything chosen in the item sheet, saved at once, then one recalculation. */
  function saveItem(it: ResolvedItem, d: ItemDraft) {
    setEditing(null);
    const kg = d.grams / 1000;
    return recalc(`"${it.key}" עודכן`, async () => {
      await supabase.from("term_settings").upsert({
        term: it.key, choice: d.choice, brands: d.choice === "brands" ? d.brands : [], excluded: d.excluded,
        mode: d.buy, weight_kg: d.buy === "weight" && Math.abs(kg - it.qty) > 0.001 ? kg : undefined,
        updated_at: new Date().toISOString(),
      });
      await supabase.from("product_preferences").delete().eq("term", it.key);
      if (d.choice === "product" && d.product)
        await supabase.from("product_preferences").insert({ term: it.key, barcode: d.product, strict: !d.swap });
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
                  📍 {[best.branch.address, best.branch.city, distLabel(best)].filter(Boolean).join(", ")} · ניווט
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

          {result.withHahishook && (() => {
            const h = result.withHahishook;
            return (
              <section className="card hahishook">
                <h3>🌱 להזמין חלק מהחישוק?</h3>
                <p className="small">
                  {h.linesB.length} מוצרים מהחישוק והשאר ב{h.a.chain_name}: <b>{money(h.total)}</b>{" "}
                  <span className="save">חוסך {money(h.saving)}</span>
                </p>
                <p className="muted small">
                  כולל {money(HAHISHOOK_FEE)} לנקודת איסוף (עד 7 ק"ג, מעל זה חינם). המשלוחים שלהם עדיין בפיילוט, ההחלטה שלך.
                </p>
                <details className="store">
                  <summary><span className="store-name">מה לקנות איפה</span></summary>
                  <h4>{storeTitle(h.a)}</h4>
                  <ShoppingList id={`h${h.a.branch_id}a`} title={storeTitle(h.a)} lines={h.linesA} weighted={weighted} products={products} />
                  <h4>🌱 החישוק</h4>
                  <ShoppingList id={`h${h.a.branch_id}b`} title="החישוק" lines={h.linesB} weighted={weighted} products={products} />
                  <CloseBox />
                </details>
              </section>
            );
          })()}

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
                const st = result.settings.get(it.key);
                const line = best?.branch.lines.find((x) => x.key === it.key);
                const named = (b: string) => rs.find((p) => p.barcode === b)?.name ?? "";
                const summary = !rs.length
                  ? null
                  : st?.pinned
                    ? `⭐ ${named(st.pinned)}${st.strict ? " בלבד" : ""}`
                    : st?.choice === "brands" && st.brands.length
                      ? `🏷️ ${st.brands.join(", ")}`
                      : st?.choice !== "cheapest" && it.preferred.length
                        ? `⭐ כמו בקבלות: ${named(it.preferred[0])}`
                        : "💰 הכי זול";
                return (
                  <li key={it.key} className="item">
                    <div className="item-row">
                      <div className="item-main">
                        <div className="ikey">
                          {it.key}{" "}
                          {rs.length > 0 && <span className="chip">{it.weighted ? `⚖️ ${kgLabel(it.qty)}` : `📦 ${+it.qty.toFixed(2)} יח'`}</span>}
                        </div>
                        {!rs.length ? (
                          <div className="warn">לא נמצא מוצר תואם</div>
                        ) : (
                          <>
                            <div className="item-sum muted">{summary}</div>
                            {line && (
                              <div className="item-pick small">
                                בסל: {line.name}
                                {(() => {
                                  // the catalogue name when the store calls it something else
                                  const p = rs.find((x) => x.barcode === line.barcode);
                                  return p && normName(p.name) !== normName(line.name) ? <span className="muted"> ({p.name})</span> : null;
                                })()}
                                {!line.preferred && <span className="tag alt">תחליף</span>}
                              </div>
                            )}
                          </>
                        )}
                      </div>
                      {rs.length > 0 && (
                        <button className="edit-btn" aria-haspopup="dialog" aria-label={`שינוי ${it.key}`} onClick={() => setEditing(it.key)}>
                          שינוי
                        </button>
                      )}
                    </div>
                  </li>
                );
              })}
            </ul>
            {(() => {
              const it = result.items.find((x) => x.key === editing);
              if (!it) return null;
              return (
                <ItemSheet
                  item={it}
                  results={result.results.get(it.key) ?? []}
                  setting={result.settings.get(it.key) ?? { brands: [], strict: false, excluded: [] }}
                  line={best?.branch.lines.find((x) => x.key === it.key)}
                  penalty={loadSettings().penalty}
                  onClose={() => setEditing(null)}
                  onDone={(d, changed) => (changed ? saveItem(it, d) : setEditing(null))}
                />
              );
            })()}
          </section>

          {result.splits.length > 0 && (
            <section className="card">
              <h3>אפשר לחסוך עוד בפיצול הקנייה</h3>
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
                  <h4>{storeTitle(s.b)}{s.deliveryFee > 0 && <span className="muted small"> · כולל משלוח {money(s.deliveryFee)}</span>}</h4>
                  <ShoppingList id={`s${s.a.branch_id}-${s.b.branch_id}b`} title={storeTitle(s.b)} lines={s.linesB} weighted={weighted} products={products} />
                  <CloseBox />
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
                    {o.branch.city && !o.branch.is_online && (
                      <span className="muted small"> · {[o.branch.city, distLabel(o)].filter(Boolean).join(" · ")}</span>
                    )}
                  </span>
                  <span className="store-price">
                    {o.missing.length === best.missing.length ? (
                      <span className="diff">{o.total - best.total < 0.005 ? "אותו מחיר" : `+${money(o.total - best.total)}`}</span>
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
                <CloseBox />
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
