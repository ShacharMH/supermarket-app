import { useEffect, useRef, useState } from "react";
import { supabase } from "../supabase";
import { loadSettings } from "../settings";
import {
  bestSplits, parseList, rankStores, resolveItem,
  type BranchRow, type Line, type Product, type ResolvedItem, type SplitOption, type StoreOption,
} from "../lib/basket";

type Result = {
  items: ResolvedItem[];
  results: Map<string, Product[]>;
  stores: StoreOption[];
  splits: SplitOption[];
};

const money = (n: number) => `₪${n.toFixed(2)}`;

function storeTitle(b: BranchRow) {
  return `${b.chain_name} · ${b.branch_name ?? ""}${b.is_online ? " (אונליין)" : ""}`;
}

function Lines({ lines }: { lines: Line[] }) {
  return (
    <ul className="lines">
      {lines.map((l) => (
        <li key={l.key}>
          <span className="lname">
            {l.qty !== 1 && <b>{l.qty}× </b>}
            {l.name}
            {!l.preferred && <span className="tag alt">חלופה</span>}
            {l.promo && <span className="tag promo">{l.promo}</span>}
          </span>
          <span className="lprice">{money(l.total)}</span>
        </li>
      ))}
    </ul>
  );
}

export default function ListPage() {
  const [text, setText] = useState("");
  const [listId, setListId] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<Result | null>(null);
  const [lastRun, setLastRun] = useState<string | null>(null);
  const [tracked, setTracked] = useState<number | null>(null);
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

  function onText(v: string) {
    setText(v);
    window.clearTimeout(saveTimer.current);
    saveTimer.current = window.setTimeout(async () => {
      if (listId) await supabase.from("shopping_lists").update({ items: { text: v }, updated_at: new Date().toISOString() }).eq("id", listId);
      else {
        const { data } = await supabase.from("shopping_lists").insert({ items: { text: v } }).select("id").single();
        if (data) setListId(data.id);
      }
    }, 800);
  }

  async function compare() {
    const settings = loadSettings();
    const items = parseList(text);
    if (items.length === 0) return;
    setBusy(true);
    setError(null);
    try {
      const [prefs, history, clubs] = await Promise.all([
        supabase.from("product_preferences").select("term, barcode"),
        supabase.from("purchase_history").select("barcode, times_bought"),
        supabase.from("user_clubs").select("chain_id"),
      ]);
      const pinned = new Map<string, string[]>();
      for (const p of prefs.data ?? []) pinned.set(p.term, [...(pinned.get(p.term) ?? []), p.barcode]);
      const bought = new Map<string, number>((history.data ?? []).map((h) => [h.barcode, h.times_bought]));

      const results = new Map<string, Product[]>();
      await Promise.all(
        items.map(async (it) => {
          // "בשר טחון מהקצביה" -> "בשר טחון" -> "בשר": drop trailing words until something matches
          const words = it.key.split(/\s+/);
          for (let n = words.length; n >= 1; n--) {
            const { data, error } = await supabase.rpc("search_products", { term: words.slice(0, n).join(" "), max_results: 25 });
            if (error) throw error;
            if (data?.length || n === 1) {
              results.set(it.key, (data ?? []) as Product[]);
              break;
            }
          }
        }),
      );
      const resolved = items.map((it) => resolveItem(it, results.get(it.key) ?? [], pinned.get(it.key) ?? [], bought));
      const payload = resolved
        .filter((r) => r.candidates.length)
        .map((r) => ({ key: r.key, qty: r.qty, candidates: r.candidates.map((c) => c.barcode), preferred: r.preferred }));

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
      setResult({ items: resolved, results, stores, splits });
    } catch (e) {
      // Supabase errors are plain objects with a message, not Error instances
      const msg = e instanceof Error ? e.message : (e as { message?: string })?.message ?? String(e);
      setError(`משהו השתבש: ${msg}`);
    } finally {
      setBusy(false);
    }
  }

  async function pin(term: string, barcode: string) {
    await supabase.from("product_preferences").delete().eq("term", term);
    if (barcode) await supabase.from("product_preferences").insert({ term, barcode });
    await compare();
  }

  const best = result?.stores[0];

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
              <details>
                <summary>פירוט</summary>
                <Lines lines={best.branch.lines} />
              </details>
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
                  <Lines lines={s.linesA} />
                  <h4>{storeTitle(s.b)}</h4>
                  <Lines lines={s.linesB} />
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
                    <Lines lines={o.branch.lines} />
                    {o.missing.length > 0 && <div className="warn">חסר: {o.missing.join(", ")}</div>}
                  </details>
                </li>
              ))}
            </ol>
          </section>

          <section className="card">
            <h3>איך הבנתי את הרשימה</h3>
            <p className="muted small">
              בחירה של מוצר ספציפי הופכת אותו למועדף. מוצר אחר ייבחר רק אם הוא זול ממנו ביותר מהסף שבהגדרות.
            </p>
            {result.items.map((it) => (
              <div key={it.key} className="item">
                <div className="ikey">{it.key}</div>
                {(result.results.get(it.key) ?? []).length === 0 ? (
                  <div className="warn">לא נמצא מוצר תואם</div>
                ) : (
                  <select value={it.preferred[0] ?? ""} onChange={(e) => pin(it.key, e.target.value)}>
                    <option value="">כל מוצר דומה (הכי זול)</option>
                    {(result.results.get(it.key) ?? []).map((p) => (
                      <option key={p.barcode} value={p.barcode}>
                        {p.name}
                        {p.manufacturer ? ` · ${p.manufacturer}` : ""} · {money(p.min_price)}-{money(p.max_price)}
                      </option>
                    ))}
                  </select>
                )}
              </div>
            ))}
          </section>
        </>
      )}
    </div>
  );
}
