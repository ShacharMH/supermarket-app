import { useEffect, useState } from "react";
import { howMuch, maker, packSize, promoHint, shelfBarcode, shoppingText, type Line, type Product } from "../lib/basket";
import ShopMode from "./ShopMode";

const money = (n: number) => `₪${n.toFixed(2)}`;

function loadChecked(id: string): Set<string> {
  try {
    return new Set(JSON.parse(localStorage.getItem(`checked-${id}`) ?? "[]"));
  } catch {
    return new Set();
  }
}

/** What to put in the cart at one store: exact product, amount, promo, barcode, tick-off. */
export default function ShoppingList({
  id, title, lines, weighted, products,
}: {
  id: string;
  title: string;
  lines: Line[];
  weighted: Set<string>;
  products: Map<string, Product>;
}) {
  const [checked, setChecked] = useState<Set<string>>(() => loadChecked(id));
  const [copied, setCopied] = useState(false);
  const [shopping, setShopping] = useState(false);

  useEffect(() => {
    try {
      localStorage.setItem(`checked-${id}`, JSON.stringify([...checked]));
    } catch {
      /* ignore */
    }
  }, [id, checked]);

  function toggle(key: string) {
    const next = new Set(checked);
    if (next.has(key)) next.delete(key);
    else next.add(key);
    setChecked(next);
  }

  async function share() {
    const text = shoppingText(title, lines, weighted, products);
    try {
      if (navigator.share) await navigator.share({ text });
      else {
        await navigator.clipboard.writeText(text);
        setCopied(true);
        window.setTimeout(() => setCopied(false), 2500);
      }
    } catch {
      /* user cancelled */
    }
  }

  return (
    <div className="shop">
      <ul className="shoplist">
        {lines.map((l) => {
          const p = products.get(l.barcode);
          const isW = weighted.has(l.key);
          const size = packSize(p);
          const code = shelfBarcode(l.barcode);
          return (
            <li key={l.key} className={checked.has(l.key) ? "done" : ""}>
              <label>
                <input type="checkbox" checked={checked.has(l.key)} onChange={() => toggle(l.key)} />
                <span className="sl-main">
                  <span className="sl-name">
                    <b>{howMuch(l, isW)}</b> · {l.name}
                  </span>
                  <span className="sl-meta">
                    {[maker(p), size, isW ? `${money(l.price)} לק"ג` : l.qty !== 1 ? `${money(l.price)} ליח'` : null]
                      .filter(Boolean)
                      .join(" · ")}
                    {code && (
                      <span>
                        {" · ברקוד "}
                        <bdi className="sl-code">{code}</bdi>
                      </span>
                    )}
                  </span>
                  <span className="sl-tags">
                    <span className="muted small">עבור "{l.key}"</span>
                    {l.promo && <span className="tag promo">מבצע: {l.promo}</span>}
                    {!l.preferred && <span className="tag alt">תחליף</span>}
                  </span>
                  {(() => {
                    const h = promoHint(l);
                    return h ? <span className="sl-hint">💡 {h.text} (חיסכון {money(h.saving)})</span> : null;
                  })()}
                </span>
                <span className="lprice">{money(l.total)}</span>
              </label>
            </li>
          );
        })}
      </ul>
      <button className="primary shop-go" onClick={() => setShopping(true)}>🛒 מצב קנייה בסופר</button>
      {shopping && (
        <ShopMode
          title={title}
          lines={lines}
          weighted={weighted}
          products={products}
          checked={checked}
          toggle={toggle}
          clear={() => setChecked(new Set())}
          close={() => setShopping(false)}
        />
      )}
      <div className="row">
        <button onClick={share}>{copied ? "✓ הועתק" : "📤 שיתוף / העתקת הרשימה"}</button>
        {checked.size > 0 && (
          <button className="link" onClick={() => setChecked(new Set())}>
            ניקוי סימונים ({checked.size}/{lines.length})
          </button>
        )}
      </div>
    </div>
  );
}
