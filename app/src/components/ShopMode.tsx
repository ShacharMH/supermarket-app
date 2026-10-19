import { useEffect } from "react";
import { groupByCategory } from "../lib/categories";
import { howMuch, lineNames, lineWeighed, maker, packSize, promoHint, shelfBarcode, type Line, type Product } from "../lib/basket";

const money = (n: number) => `₪${n.toFixed(2)}`;

type WakeLock = { release: () => Promise<void> };

/** Keep the screen on while shopping (where the browser supports it). */
function useWakeLock() {
  useEffect(() => {
    let lock: WakeLock | null = null;
    const nav = navigator as Navigator & { wakeLock?: { request: (t: "screen") => Promise<WakeLock> } };
    const acquire = async () => {
      try {
        if (document.visibilityState === "visible") lock = (await nav.wakeLock?.request("screen")) ?? null;
      } catch {
        /* not allowed - fine */
      }
    };
    acquire();
    document.addEventListener("visibilitychange", acquire);
    return () => {
      document.removeEventListener("visibilitychange", acquire);
      lock?.release().catch(() => {});
    };
  }, []);
}

/** Full-screen, big-print list for the aisle: tap a row to put it in the cart. */
export default function ShopMode({
  title, lines, weighted, products, checked, toggle, clear, close,
}: {
  title: string;
  lines: Line[];
  weighted: Set<string>;
  products: Map<string, Product>;
  checked: Set<string>;
  toggle: (key: string) => void;
  clear: () => void;
  close: () => void;
}) {
  useWakeLock();

  useEffect(() => {
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && close();
    window.addEventListener("keydown", onKey);
    return () => {
      document.body.style.overflow = prev;
      window.removeEventListener("keydown", onKey);
    };
  }, [close]);

  const todo = lines.filter((l) => !checked.has(l.key));
  const done = lines.filter((l) => checked.has(l.key));
  const left = todo.reduce((t, l) => t + l.total, 0);

  const row = (l: Line) => {
    const p = products.get(l.barcode);
    const isW = lineWeighed(l, weighted, products);
    const code = shelfBarcode(l.barcode);
    const hint = promoHint(l);
    const meta = [maker(p), packSize(p), code && `ברקוד ${code}`].filter(Boolean).join(" · ");
    return (
      <li key={l.key} className={checked.has(l.key) ? "done" : ""}>
        <button className="sm-row" onClick={() => toggle(l.key)} aria-pressed={checked.has(l.key)}>
          <span className="sm-box" aria-hidden>{checked.has(l.key) ? "✓" : ""}</span>
          <span className="sm-main">
            <span className="sm-qty">{howMuch(l, isW)}</span>
            <span className="sm-name">{lineNames(l, products).name}</span>
            {lineNames(l, products).shelf && <span className="sm-meta">במדף: {lineNames(l, products).shelf}</span>}
            {meta && <span className="sm-meta">{meta}</span>}
            {l.promo && <span className="tag promo">מבצע: {l.promo}</span>}
            {hint && !checked.has(l.key) && <span className="sm-hint">💡 {hint.text}</span>}
          </span>
          <span className="sm-price">{money(l.total)}</span>
        </button>
      </li>
    );
  };

  return (
    <div className="shopmode" role="dialog" aria-modal="true" aria-label={`קנייה ב${title}`}>
      <header className="sm-head">
        <div>
          <div className="sm-title">{title}</div>
          <div className="sm-progress">
            {done.length}/{lines.length} בעגלה{todo.length > 0 && ` · נשאר ${money(left)}`}
          </div>
        </div>
        <button className="sm-close" onClick={close} aria-label="סגירת מצב קנייה">✕</button>
      </header>
      <div className="sm-bar" aria-hidden>
        <div style={{ width: `${lines.length ? (done.length / lines.length) * 100 : 0}%` }} />
      </div>
      <ul className="sm-list">
        {groupByCategory(todo, (l) => l.key).map(({ cat, items }) => [
          <li key={`h-${cat.id}`} className="sm-dept">
            <span aria-hidden>{cat.icon}</span> {cat.label}
          </li>,
          ...items.map(row),
        ])}
        {done.length > 0 && <li className="sm-sep">בעגלה</li>}
        {done.map(row)}
      </ul>
      {todo.length === 0 && lines.length > 0 && (
        <div className="sm-finish">
          <div>🎉 הכול בעגלה!</div>
          <button className="primary" onClick={() => { clear(); close(); }}>סיום וניקוי הסימונים</button>
        </div>
      )}
    </div>
  );
}
