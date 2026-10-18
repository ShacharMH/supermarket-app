import { useEffect, useState } from "react";
import { supabase } from "../supabase";
import type { BuyReason } from "../lib/basket";

type CheckRow = {
  item_id: number; raw_name: string; barcode: string | null; db_name: string | null; quantity: number;
  paid: number | null; discount: number | null; db_price: number | null; is_weighted: boolean; db_promo: string | null;
  reason?: BuyReason;
};

const money = (n: number) => `₪${n.toFixed(2)}`;

export const REASONS: [BuyReason, string][] = [
  ["preferred", "⭐ זה המוצר שלי"],
  ["deal", "🏷️ בגלל מבצע"],
  ["substitute", "🔁 המוצר הרגיל לא היה"],
];

/** One receipt line against the price files: did the shelf price and the deal match? */
function verdict(r: CheckRow): { ok: boolean; text: string } {
  if (!r.barcode) return { ok: false, text: "לא זוהה במאגר" };
  if (r.db_price == null) return { ok: false, text: "זוהה, אבל אין לו מחיר בסניף הזה במאגר" };
  if (r.paid == null) return { ok: true, text: `במאגר ${money(r.db_price)}` };
  if (r.is_weighted) {
    const kg = r.paid / r.db_price;
    return { ok: true, text: `${money(r.db_price)} לק"ג במאגר → שקלת כ-${Math.round(kg * 1000)} גרם` };
  }
  const unit = r.paid / (r.quantity || 1);
  return Math.abs(unit - r.db_price) < 0.015
    ? { ok: true, text: `תואם למאגר (${money(r.db_price)})` }
    : { ok: false, text: `במאגר ${money(r.db_price)}, בקבלה ${money(unit)} ליחידה` };
}

export default function ReceiptCheck({ receiptId }: { receiptId: number }) {
  const [rows, setRows] = useState<CheckRow[] | null>(null);

  useEffect(() => {
    let stale = false;
    Promise.all([
      supabase.rpc("receipt_check", { p_receipt: receiptId }),
      supabase.from("receipt_items").select("id, reason").eq("receipt_id", receiptId),
    ]).then(([c, r]) => {
      if (stale) return;
      const reasons = new Map((r.data ?? []).map((x) => [x.id as number, x.reason as BuyReason]));
      setRows(((c.data ?? []) as CheckRow[]).map((x) => ({ ...x, reason: reasons.get(x.item_id) ?? "preferred" })));
    });
    return () => {
      stale = true;
    };
  }, [receiptId]);

  async function setReason(id: number, reason: BuyReason) {
    setRows((rs) => rs?.map((r) => (r.item_id === id ? { ...r, reason } : r)) ?? null);
    await supabase.from("receipt_items").update({ reason }).eq("id", id);
  }

  if (!rows) return <p className="muted small">בודק מול המאגר...</p>;
  const matched = rows.filter((r) => verdict(r).ok).length;
  return (
    <div className="receipt-check">
      <p className="small">
        {matched}/{rows.length} שורות תואמות למחירים במאגר.
      </p>
      <ul className="plain check-list">
        {rows.map((r) => {
          const v = verdict(r);
          return (
            <li key={r.item_id}>
              <div>
                <b>{r.raw_name}</b>
                {r.db_name && r.db_name !== r.raw_name && <span className="muted small"> · במאגר: {r.db_name}</span>}
                <div className={`small ${v.ok ? "ok-text" : "warn-text"}`}>{v.ok ? "✓" : "⚠️"} {v.text}</div>
                {(r.discount ?? 0) > 0 && (
                  <div className={`small ${r.db_promo ? "ok-text" : "warn-text"}`}>
                    🏷️ הנחה {money(r.discount!)} · {r.db_promo ? `המבצע מופיע במאגר: ${r.db_promo}` : "המבצע לא מופיע במאגר"}
                  </div>
                )}
              </div>
              <select aria-label={`למה נקנה ${r.raw_name}`} value={r.reason} onChange={(e) => setReason(r.item_id, e.target.value as BuyReason)}>
                {REASONS.map(([v2, label]) => (
                  <option key={v2} value={v2}>{label}</option>
                ))}
              </select>
            </li>
          );
        })}
      </ul>
      <p className="muted small">רק מה שמסומן "⭐ זה המוצר שלי" נלמד כמוצר מועדף. קניות בגלל מבצע או כתחליף לא משנות את ההעדפות.</p>
    </div>
  );
}
