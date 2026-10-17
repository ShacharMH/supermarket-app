import { useState } from "react";
import type { StoreOption } from "../lib/basket";
import { categoryOf } from "../lib/categories";

const money = (n: number) => `₪${n.toFixed(2)}`;

/**
 * Items × the 3 cheapest stores at a glance: the cheapest price in each row is
 * highlighted, so it is clear where the saving comes from.
 */
export default function CompareTable({
  stores, keys, weighted,
}: {
  stores: StoreOption[];
  keys: string[];
  weighted: Set<string>;
}) {
  const [open, setOpen] = useState(false);
  const best = stores[0];
  // compare stores carrying as many of the items as the best one
  const cols = stores.filter((s) => s.missing.length === best.missing.length).slice(0, 3);
  if (cols.length < 2) return null;
  const cell = (s: StoreOption, key: string) => s.branch.lines.find((l) => l.key === key);

  return (
    <section className="card">
      <button className="sec-toggle" aria-expanded={open} onClick={() => setOpen(!open)}>
        <h3>📊 השוואה מהירה בין {cols.length} הסניפים הזולים</h3>
        <span aria-hidden>{open ? "▾" : "◂"}</span>
      </button>
      {open && (
        <div className="cmp-wrap">
          <table className="cmp">
            <thead>
              <tr>
                <th scope="col">מוצר</th>
                {cols.map((s, i) => (
                  <th scope="col" key={s.branch.branch_id} className={i === 0 ? "cmp-best" : ""}>
                    {s.branch.chain_name}
                    <span className="cmp-branch">{s.branch.branch_name}</span>
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {keys.map((key) => {
                const prices = cols.map((s) => cell(s, key)?.total ?? null);
                const min = Math.min(...prices.filter((p): p is number => p !== null));
                return (
                  <tr key={key}>
                    <th scope="row">
                      <span aria-hidden>{categoryOf(key).icon}</span> {key}
                      {weighted.has(key) && <span className="muted small"> ⚖️</span>}
                    </th>
                    {prices.map((p, i) => (
                      <td key={cols[i].branch.branch_id} className={p !== null && p === min && prices.filter((x) => x === min).length < prices.length ? "cmp-min" : ""}>
                        {p === null ? <span className="muted">—</span> : money(p)}
                      </td>
                    ))}
                  </tr>
                );
              })}
            </tbody>
            <tfoot>
              <tr>
                <th scope="row">סה"כ</th>
                {cols.map((s, i) => (
                  <td key={s.branch.branch_id} className={i === 0 ? "cmp-min" : ""}>
                    {money(s.total)}
                  </td>
                ))}
              </tr>
            </tfoot>
          </table>
          <p className="muted small">מודגש: הזול ביותר בשורה. "—": לא נמכר בסניף.</p>
        </div>
      )}
    </section>
  );
}
