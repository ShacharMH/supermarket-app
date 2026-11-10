import { useEffect, useState } from "react";
import { supabase } from "../supabase";
import { errorText } from "../lib/errors";
import { disablePush, enablePush, pushState, type PushState } from "../lib/push";

type Prefs = { alerts_on: boolean; alert_pct: number; alert_min_saving: number; alert_muted: string[] };
type Watched = { barcode: string; name: string; starred: boolean; receipts: number };

const DEFAULTS: Prefs = { alerts_on: true, alert_pct: 15, alert_min_saving: 3, alert_muted: [] };

const STATE_TEXT: Record<PushState, string> = {
  on: "🔔 התראות פעילות במכשיר הזה",
  off: "ההתראות כבויות במכשיר הזה",
  denied: "הדפדפן חוסם התראות מהאפליקציה. אפשר לאשר אותן בהגדרות האתר בדפדפן.",
  unsupported: "הדפדפן הזה לא תומך בהתראות. ירידות מחיר יופיעו בראש עמוד הרשימה.",
  "ios-install": "באייפון התראות עובדות רק מהאפליקציה שעל מסך הבית: בספארי לוחצים על ״שיתוף״ ← ״הוספה למסך הבית״, ופותחים משם.",
};

/** "Tell me when something I like gets cheaper": the device, the threshold, which products. */
export default function AlertsSettings() {
  const [prefs, setPrefs] = useState<Prefs>(DEFAULTS);
  const [watched, setWatched] = useState<Watched[]>([]);
  const [state, setState] = useState<PushState | null>(null);
  const [msg, setMsg] = useState<string | null>(null);

  useEffect(() => {
    pushState().then(setState).catch(() => setState("unsupported"));
    (async () => {
      const [p, w] = await Promise.all([
        supabase.from("user_profile").select("alerts_on, alert_pct, alert_min_saving, alert_muted").maybeSingle(),
        supabase.from("watched_products").select("barcode, starred, receipts"),
      ]);
      const got = (p.data ?? {}) as Partial<Prefs>;
      setPrefs({
        alerts_on: got.alerts_on ?? DEFAULTS.alerts_on, alert_pct: Number(got.alert_pct ?? DEFAULTS.alert_pct),
        alert_min_saving: Number(got.alert_min_saving ?? DEFAULTS.alert_min_saving), alert_muted: got.alert_muted ?? [],
      });
      const rows = (w.data ?? []) as Omit<Watched, "name">[];
      if (!rows.length) return setWatched([]);
      const names = await supabase.from("products").select("barcode, name").in("barcode", rows.map((r) => r.barcode));
      const byCode = new Map(((names.data ?? []) as { barcode: string; name: string }[]).map((n) => [n.barcode, n.name]));
      setWatched(rows.map((r) => ({ ...r, name: byCode.get(r.barcode) ?? r.barcode })).sort((a, b) => a.name.localeCompare(b.name, "he")));
    })();
  }, []);

  async function save(patch: Partial<Prefs>) {
    const next = { ...prefs, ...patch };
    setPrefs(next);
    const { error } = await supabase.from("user_profile").upsert({ ...next, updated_at: new Date().toISOString() });
    setMsg(error ? errorText(error) : null);
  }

  async function toggleDevice() {
    setMsg(null);
    try {
      setState(state === "on" ? await disablePush() : await enablePush());
    } catch (e) {
      setMsg(errorText(e));
    }
  }

  const muted = new Set(prefs.alert_muted);
  return (
    <section className="card">
      <h3>התראות על ירידות מחיר</h3>
      <p className="muted small">
        כשמוצר שאת אוהבת (מסומן בכוכב, או שקנית בשתי קבלות ויותר) זול משמעותית מהמחיר הרגיל שלו באזור "קונה עכשיו ב",
        תגיע התראה, ופעם ביום לכל היותר. ירידות מחיר מופיעות גם בראש עמוד הרשימה.
      </p>
      <label className="check-row">
        <input type="checkbox" checked={prefs.alerts_on} onChange={(e) => save({ alerts_on: e.target.checked })} />
        לחפש ירידות מחיר
      </label>
      {prefs.alerts_on && (
        <>
          {state && <p className="small">{STATE_TEXT[state]}</p>}
          {(state === "on" || state === "off") && (
            <button onClick={toggleDevice}>{state === "on" ? "🔕 כיבוי התראות במכשיר הזה" : "🔔 הפעלת התראות במכשיר הזה"}</button>
          )}
          <label className="lbl">
            ירידה של לפחות {prefs.alert_pct}% מהמחיר הרגיל
            <input type="range" min={5} max={50} step={5} value={prefs.alert_pct} onChange={(e) => setPrefs({ ...prefs, alert_pct: Number(e.target.value) })}
              onPointerUp={() => save({})} onKeyUp={() => save({})} />
          </label>
          <label className="lbl">
            ולפחות חיסכון של (₪ ליחידה)
            <input type="number" min={0} step={0.5} value={prefs.alert_min_saving} onChange={(e) => save({ alert_min_saving: Number(e.target.value) })} />
          </label>
          <h4>מוצרים במעקב ({watched.filter((w) => !muted.has(w.barcode)).length})</h4>
          {watched.length === 0 ? (
            <p className="muted small">עדיין אין. סמני מוצרים בכוכב בעמוד הקבלות, או בחרי "מוצר מסוים" ברשימה.</p>
          ) : (
            <ul className="plain watched">
              {watched.map((w) => (
                <li key={w.barcode}>
                  <label className="check-row">
                    <input type="checkbox" checked={!muted.has(w.barcode)}
                      onChange={(e) => save({ alert_muted: e.target.checked ? prefs.alert_muted.filter((b) => b !== w.barcode) : [...prefs.alert_muted, w.barcode] })} />
                    <span>
                      {w.name}
                      <span className="muted small"> · {w.starred ? "⭐ מועדף" : `נקנה ב-${w.receipts} קבלות`}</span>
                    </span>
                  </label>
                </li>
              ))}
            </ul>
          )}
        </>
      )}
      {msg && <p className="note">{msg}</p>}
    </section>
  );
}
