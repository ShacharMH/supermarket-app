import { useEffect, useRef, useState } from "react";
import { supabase } from "../supabase";

type Alert = {
  id: number; name: string; unit_price: number; usual_price: number; promo: string | null;
  min_qty: number | null; ends_at: string | null; created_at: string; branch_id: number | null;
  store?: string;
};

const money = (n: number) => `₪${Number(n).toFixed(2)}`;
const day = (iso: string) => new Date(iso).toLocaleDateString("he-IL", { day: "numeric", month: "numeric" });

/** The week's price drops on products the user likes, at the top of the list page. */
export default function PriceDrops({ onAdd }: { onAdd: (name: string) => void }) {
  const [alerts, setAlerts] = useState<Alert[]>([]);
  const ref = useRef<HTMLElement>(null);
  // opened from a notification: "./?alerts=1"
  const fromPush = new URLSearchParams(location.search).has("alerts");

  useEffect(() => {
    (async () => {
      const since = new Date(Date.now() - 7 * 86400_000).toISOString();
      const { data } = await supabase.from("price_alerts")
        .select("id, name, unit_price, usual_price, promo, min_qty, ends_at, created_at, branch_id")
        .eq("dismissed", false).gte("created_at", since).order("created_at", { ascending: false });
      const rows = (data ?? []) as Alert[];
      const ids = [...new Set(rows.map((r) => r.branch_id).filter((x): x is number => x != null))];
      if (ids.length) {
        const b = await supabase.from("branches").select("id, name, chains(name)").in("id", ids);
        const names = new Map(((b.data ?? []) as unknown as { id: number; name: string; chains: { name: string } | null }[])
          .map((x) => [x.id, `${x.chains?.name ?? ""} ${x.name}`.trim()]));
        for (const r of rows) r.store = r.branch_id != null ? names.get(r.branch_id) : undefined;
      }
      setAlerts(rows);
    })();
  }, []);

  useEffect(() => {
    if (fromPush && alerts.length) ref.current?.scrollIntoView({ behavior: "smooth", block: "start" });
  }, [fromPush, alerts.length]);

  async function dismiss(id: number) {
    setAlerts((a) => a.filter((x) => x.id !== id));
    await supabase.from("price_alerts").update({ dismissed: true }).eq("id", id);
  }

  if (!alerts.length) return null;
  return (
    <section className="card drops" ref={ref} aria-label="ירידות מחיר">
      <h3>🔔 ירידות מחיר על מוצרים שאת אוהבת</h3>
      <ul className="plain">
        {alerts.map((a) => {
          const off = Math.round((1 - a.unit_price / a.usual_price) * 100);
          return (
            <li key={a.id}>
              <div>
                <b>{a.name}</b>
                <div className="small">
                  <b className="ok-text">{money(a.unit_price)}</b> במקום {money(a.usual_price)} <span className="tag promo">-{off}%</span>
                  {a.min_qty && a.min_qty > 1 && <> · בקנייה של {a.min_qty}</>}
                </div>
                <div className="muted small">
                  {a.store}
                  {a.promo && <> · {a.promo}</>}
                  {a.ends_at ? <> · עד {day(a.ends_at)}</> : <> · נמצא ב-{day(a.created_at)}</>}
                </div>
              </div>
              <div className="drop-actions">
                <button className="link" onClick={() => { onAdd(a.name); dismiss(a.id); }}>➕ לרשימה</button>
                <button className="link" aria-label={`הסרה: ${a.name}`} onClick={() => dismiss(a.id)}>✕</button>
              </div>
            </li>
          );
        })}
      </ul>
    </section>
  );
}
