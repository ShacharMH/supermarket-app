import { useEffect, useState } from "react";
import { supabase } from "../supabase";
import { parseReceiptCsv, type ReceiptRow } from "../lib/basket";

type Branch = { id: number; name: string | null; city: string | null; chains: { name: string } | null };
type Receipt = { id: number; purchased_at: string | null; total: number | null; branch_id: number | null; receipt_items: { count: number }[] };

const SAMPLE = "תאריך,מוצר,ברקוד,כמות,מחיר\n2026-10-15,קוטג תנובה 5% 250 גרם,,2,11.80\n2026-10-15,חלב תנובה 3% 1 ליטר,7290004131074,1,7.11";

export default function ReceiptsPage() {
  const [branches, setBranches] = useState<Branch[]>([]);
  const [branchId, setBranchId] = useState<string>("");
  const [text, setText] = useState("");
  const [rows, setRows] = useState<ReceiptRow[]>([]);
  const [msg, setMsg] = useState<string | null>(null);
  const [receipts, setReceipts] = useState<Receipt[]>([]);
  const [busy, setBusy] = useState(false);

  async function load() {
    const [b, r] = await Promise.all([
      supabase.from("branches").select("id, name, city, chains(name)").eq("tracked", true).order("chain_id"),
      supabase.from("receipts").select("id, purchased_at, total, branch_id, receipt_items(count)").order("id", { ascending: false }).limit(20),
    ]);
    setBranches((b.data ?? []) as unknown as Branch[]);
    setReceipts((r.data ?? []) as unknown as Receipt[]);
  }
  useEffect(() => {
    load();
  }, []);

  function preview(t: string) {
    setText(t);
    try {
      setRows(parseReceiptCsv(t));
      setMsg(null);
    } catch (e) {
      setRows([]);
      setMsg(e instanceof Error ? e.message : String(e));
    }
  }

  async function onFile(f: File | undefined) {
    if (f) preview(await f.text());
  }

  async function save() {
    if (rows.length === 0) return;
    setBusy(true);
    const total = rows.reduce((s, r) => s + (r.price ?? 0), 0);
    const { data: receipt, error } = await supabase
      .from("receipts")
      .insert({
        branch_id: branchId ? Number(branchId) : null,
        purchased_at: rows.find((r) => r.date)?.date ?? null,
        total: Math.round(total * 100) / 100,
        source: "csv",
      })
      .select("id")
      .single();
    if (error || !receipt) {
      setBusy(false);
      return setMsg(error?.message ?? "שגיאה");
    }
    const { error: e2 } = await supabase.from("receipt_items").insert(
      rows.map((r) => ({ receipt_id: receipt.id, raw_name: r.name, barcode: r.barcode?.replace(/^0+/, "") || null, quantity: r.qty, price: r.price })),
    );
    if (e2) {
      setBusy(false);
      return setMsg(e2.message);
    }
    const { data: matched } = await supabase.rpc("resolve_receipt", { p_receipt: receipt.id });
    const withBarcode = rows.filter((r) => r.barcode).length;
    setMsg(`נשמרו ${rows.length} פריטים. ${withBarcode} עם ברקוד, ${matched ?? 0} זוהו לפי שם. מעכשיו הם ייחשבו המוצרים המועדפים שלך.`);
    setText("");
    setRows([]);
    setBusy(false);
    load();
  }

  async function remove(id: number) {
    await supabase.from("receipts").delete().eq("id", id);
    load();
  }

  return (
    <div className="page">
      <section className="card">
        <h3>טעינת קבלה</h3>
        <p className="muted small">
          קובץ CSV או טבלה מודבקת (גם מגיליון), עם עמודות: תאריך, מוצר, ברקוד, כמות, מחיר. חובה רק "מוצר". בלי ברקוד, השם
          מזוהה מול שמות הפריטים של הרשת, כי הקבלה מדפיסה בדיוק את השם שהרשת מפרסמת.
        </p>
        <select value={branchId} onChange={(e) => setBranchId(e.target.value)}>
          <option value="">באיזה סניף? (משפר זיהוי)</option>
          {branches.map((b) => (
            <option key={b.id} value={b.id}>
              {b.chains?.name} · {b.name} {b.city ? `(${b.city})` : ""}
            </option>
          ))}
        </select>
        <input type="file" accept=".csv,.tsv,.txt,text/csv" onChange={(e) => onFile(e.target.files?.[0])} />
        <textarea rows={6} value={text} placeholder={SAMPLE} onChange={(e) => preview(e.target.value)} dir="auto" />
        {rows.length > 0 && (
          <table className="tbl">
            <thead>
              <tr><th>מוצר</th><th>כמות</th><th>מחיר</th></tr>
            </thead>
            <tbody>
              {rows.slice(0, 50).map((r, i) => (
                <tr key={i}><td>{r.name}</td><td>{r.qty}</td><td>{r.price ?? ""}</td></tr>
              ))}
            </tbody>
          </table>
        )}
        <button className="primary" disabled={busy || rows.length === 0} onClick={save}>
          שמירת קבלה ({rows.length} פריטים)
        </button>
        {msg && <p className="note">{msg}</p>}
      </section>

      <section className="card">
        <h3>קבלות קודמות</h3>
        {receipts.length === 0 && <p className="muted small">אין עדיין.</p>}
        <ul className="plain">
          {receipts.map((r) => (
            <li key={r.id}>
              <span>
                {r.purchased_at ?? "ללא תאריך"} · {r.receipt_items?.[0]?.count ?? 0} פריטים{r.total ? ` · ₪${r.total}` : ""}
              </span>
              <button className="link" onClick={() => remove(r.id)}>מחיקה</button>
            </li>
          ))}
        </ul>
      </section>
    </div>
  );
}
