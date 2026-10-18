import { useEffect, useState } from "react";
import { supabase } from "../supabase";
import { errorText } from "../lib/errors";
import { parseReceiptCsv, type ReceiptRow } from "../lib/basket";
import ReceiptCheck, { Star } from "./ReceiptCheck";

type Branch = { id: number; name: string | null; city: string | null; chains: { name: string } | null };
type Receipt = { id: number; purchased_at: string | null; total: number | null; branch_id: number | null; receipt_items: { count: number }[] };

const SAMPLE = "תאריך,מוצר,ברקוד,כמות,מחיר\n15/10/2026,קוטג תנובה 5% 250 גרם,,2,11.80\n15/10/2026,חלב תנובה 3% 1 ליטר,7290004131074,1,7.11";

function downloadTemplate() {
  // BOM so Excel opens the Hebrew correctly
  const blob = new Blob(["\uFEFF" + SAMPLE + "\n"], { type: "text/csv;charset=utf-8" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = "receipt-template.csv";
  a.click();
  URL.revokeObjectURL(a.href);
}

export default function ReceiptsPage() {
  const [branches, setBranches] = useState<Branch[]>([]);
  const [branchId, setBranchId] = useState<string>("");
  const [text, setText] = useState("");
  const [rows, setRows] = useState<ReceiptRow[]>([]);
  const [msg, setMsg] = useState<string | null>(null);
  const [receipts, setReceipts] = useState<Receipt[]>([]);
  const [busy, setBusy] = useState(false);
  const [checking, setChecking] = useState<number | null>(null); // receipt shown against the price files
  const [checkVersion, setCheckVersion] = useState(0);

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
    const total = rows.reduce((s, r) => s + (r.price ?? 0) - (r.discount ?? 0), 0);
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
      return setMsg(errorText(error ?? "שגיאה"));
    }
    const { error: e2 } = await supabase.from("receipt_items").insert(
      rows.map((r) => ({
        receipt_id: receipt.id, raw_name: r.name, raw_code: r.barcode?.trim() || null, quantity: r.qty, price: r.price,
        discount: r.discount ?? null, promo: r.promo ?? null, reason: r.preferred ? "preferred" : "other",
      })),
    );
    if (e2) {
      setBusy(false);
      return setMsg(errorText(e2));
    }
    const { data: matched } = await supabase.rpc("resolve_receipt", { p_receipt: receipt.id });
    setMsg(`נשמרו ${rows.length} פריטים, ${matched ?? 0} זוהו במאגר. למטה: השוואה למחירים במאגר.`);
    setChecking(receipt.id);
    setText("");
    setRows([]);
    setBusy(false);
    load();
  }

  // a receipt saved without a branch (or with the wrong one): set it and match the codes again
  async function setReceiptBranch(id: number, branch: string) {
    await supabase.from("receipts").update({ branch_id: branch ? Number(branch) : null }).eq("id", id);
    await supabase.rpc("resolve_receipt", { p_receipt: id });
    setCheckVersion((v) => v + 1);
    load();
  }

  const branchLabel = (id: number | null) => {
    const b = branches.find((x) => x.id === id);
    return b ? `${b.chains?.name ?? ""} ${b.name ?? ""}`.trim() : null;
  };

  async function remove(id: number) {
    await supabase.from("receipts").delete().eq("id", id);
    load();
  }

  return (
    <div className="page">
      <section className="card">
        <h3>טעינת קבלה</h3>
        <p className="muted small">
          שורה אחת לכל פריט בקבלה. אפשר למלא את התבנית באקסל או בגוגל שיטס, לשמור כ-CSV ולטעון, או להעתיק את הטבלה
          ולהדביק בתיבה למטה.
        </p>
        <button onClick={downloadTemplate}>⬇️ הורדת תבנית CSV</button>
        <details>
          <summary>מה למלא בכל עמודה</summary>
          <table className="tbl">
            <thead>
              <tr><th>עמודה</th><th>חובה?</th><th>מה כותבים</th><th>דוגמה</th></tr>
            </thead>
            <tbody>
              <tr><td>תאריך</td><td>לא</td><td>תאריך הקנייה</td><td>15/10/2026</td></tr>
              <tr><td>מוצר</td><td><b>כן</b></td><td>שם הפריט כמו שמודפס בקבלה</td><td>קוטג תנובה 5% 250 גרם</td></tr>
              <tr><td>ברקוד</td><td>לא</td><td>אם מופיע בקבלה. בלעדיו מזהים לפי השם</td><td>7290004131074</td></tr>
              <tr><td>כמות</td><td>לא (1)</td><td>מספר יחידות, או ק"ג במוצרים שקילים</td><td>2</td></tr>
              <tr><td>מחיר</td><td>לא</td><td>סה"כ לשורה (לא ליחידה)</td><td>11.80</td></tr>
            </tbody>
          </table>
          <p className="muted small">את הסניף בוחרים ברשימה למטה, לא בקובץ.</p>
        </details>
        <select aria-label="סניף הקנייה" value={branchId} onChange={(e) => setBranchId(e.target.value)}>
          <option value="">באיזה סניף? (משפר זיהוי)</option>
          {branches.map((b) => (
            <option key={b.id} value={b.id}>
              {b.chains?.name} · {b.name} {b.city ? `(${b.city})` : ""}
            </option>
          ))}
        </select>
        <input aria-label="קובץ CSV של קבלה" type="file" accept=".csv,.tsv,.txt,text/csv" onChange={(e) => onFile(e.target.files?.[0])} />
        <textarea aria-label="טבלת הקבלה" rows={6} value={text} placeholder={SAMPLE} onChange={(e) => preview(e.target.value)} dir="auto" />
        {rows.length > 0 && !branchId && <p className="warn small">כדאי לבחור סניף: כך הקודים הקצרים בקבלה מזוהים, והמחירים נבדקים מול הסניף הנכון.</p>}
        {rows.length > 0 && <p className="muted small">סמנו ⭐ ליד המוצרים שאתם מעדיפים. רק הם נלמדים; השאר רק נבדקים מול המאגר.</p>}
        {rows.length > 0 && (
          <table className="tbl preview">
            <thead>
              <tr><th>מוצר</th><th>כמות</th><th>מחיר</th><th aria-label="מועדף">⭐</th></tr>
            </thead>
            <tbody>
              {rows.slice(0, 50).map((r, i) => (
                <tr key={i}>
                  <td>
                    {r.name}
                    {r.barcode && <div className="muted small">קוד {r.barcode}</div>}
                    {r.discount && <div className="ok-text small">🏷️ {r.promo} · −₪{r.discount.toFixed(2)}</div>}
                  </td>
                  <td>{r.qty}</td>
                  <td>
                    {r.discount && r.price !== null ? (
                      <>
                        <s className="muted">{r.price}</s> {(r.price - r.discount).toFixed(2)}
                      </>
                    ) : (r.price ?? "")}
                  </td>
                  <td>
                    <Star on={!!r.preferred} name={r.name} onToggle={() => setRows(rows.map((x, j) => (j === i ? { ...x, preferred: !x.preferred } : x)))} />
                  </td>
                </tr>
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
            <li key={r.id} className="receipt-row">
              <div className="receipt-head">
                <button className="link receipt-open" aria-expanded={checking === r.id} onClick={() => setChecking(checking === r.id ? null : r.id)}>
                  {checking === r.id ? "▾" : "◂"} 📄 {r.purchased_at ?? "ללא תאריך"} · {branchLabel(r.branch_id) ?? "סניף לא נבחר"} ·{" "}
                  {r.receipt_items?.[0]?.count ?? 0} פריטים{r.total ? ` · ₪${r.total}` : ""}
                </button>
                <button className="link" onClick={() => remove(r.id)}>מחיקה</button>
              </div>
              {checking === r.id && (
                <div className="receipt-body">
                  <select aria-label="סניף הקבלה" value={r.branch_id ?? ""} onChange={(e) => setReceiptBranch(r.id, e.target.value)}>
                    <option value="">באיזה סניף? (נדרש לבדיקת המחירים)</option>
                    {branches.map((b) => (
                      <option key={b.id} value={b.id}>
                        {b.chains?.name} · {b.name} {b.city ? `(${b.city})` : ""}
                      </option>
                    ))}
                  </select>
                  <ReceiptCheck key={`${r.id}-${checkVersion}`} receiptId={r.id} />
                </div>
              )}
            </li>
          ))}
        </ul>
      </section>
    </div>
  );
}
