import { useEffect, useRef, useState } from "react";
import { supabase } from "../supabase";
import { lineAmount, parseList, setLineQty, setLineUnits, setLineWeight, unitWeight } from "../lib/basket";
import { categoryOf } from "../lib/categories";

const RECENT_KEY = "recent-terms";

export function loadRecent(): string[] {
  try {
    return JSON.parse(localStorage.getItem(RECENT_KEY) ?? "[]");
  } catch {
    return [];
  }
}

/** Remember list terms for suggestions (most recent first). */
export function rememberTerms(terms: string[]) {
  try {
    const next = [...new Set([...terms, ...loadRecent()])].slice(0, 200);
    localStorage.setItem(RECENT_KEY, JSON.stringify(next));
  } catch {
    /* ignore */
  }
}

const kgLabel = (q: number) => (q < 1 ? `${Math.round(q * 1000)} גרם` : `${+q.toFixed(2)} ק"ג`);

/**
 * The shopping list as rows (icon, name, − qty +, remove) with an "add" box that
 * suggests recent items and real product names. The text form stays the source of
 * truth, so pasting a whole list still works ("עריכה כטקסט").
 */
export default function ListEditor({ text, onChange }: { text: string; onChange: (t: string) => void }) {
  const [asText, setAsText] = useState(false);
  const [draft, setDraft] = useState("");
  const [suggestions, setSuggestions] = useState<string[]>([]);
  const timer = useRef<number | undefined>(undefined);
  const lines = text.split("\n").filter((l) => l.trim());

  const setLines = (ls: string[]) => onChange(ls.join("\n"));

  function add(value: string) {
    const v = value.trim();
    if (!v) return;
    setLines([...lines, v]);
    setDraft("");
    setSuggestions([]);
  }

  useEffect(() => {
    window.clearTimeout(timer.current);
    const q = draft.trim();
    if (q.length < 2) {
      setSuggestions([]);
      return;
    }
    const inList = new Set(lines.map((l) => parseList(l)[0]?.key));
    const recent = loadRecent().filter((t) => t.includes(q) && !inList.has(t)).slice(0, 4);
    setSuggestions(recent);
    // a reply for an older draft (e.g. "ענב" after "ענבים" was already added) is dropped
    let stale = false;
    timer.current = window.setTimeout(async () => {
      const { data } = await supabase.rpc("search_products", { term: q, max_results: 8 });
      if (stale) return;
      const names = ((data ?? []) as { name: string }[]).map((p) => p.name);
      setSuggestions([...new Set([...recent, ...names])].slice(0, 8));
    }, 250);
    return () => {
      stale = true;
      window.clearTimeout(timer.current);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [draft]);

  if (asText) {
    return (
      <div className="editor">
        <div className="editor-head">
          <label className="lbl" htmlFor="list">כל שורה מוצר. אפשר "2 קוטג", "בשר טחון 500 גרם", "אקונומיקה 4 ליטר"</label>
          <button className="link" onClick={() => setAsText(false)}>✓ סיום עריכה</button>
        </div>
        <textarea id="list" rows={10} value={text} onChange={(e) => onChange(e.target.value)} placeholder={"2 קוטג\nחלב 3%\nלחם אחיד\nביצים L"} />
      </div>
    );
  }

  return (
    <div className="editor">
      <div className="editor-head">
        <h2 className="editor-title">הרשימה שלי {lines.length > 0 && <span className="muted small">({lines.length})</span>}</h2>
        <button className="link" onClick={() => setAsText(true)}>✍️ עריכה כטקסט / הדבקה</button>
      </div>
      <div className="add-box">
        <input
          aria-label="הוספת מוצר"
          placeholder="➕ הוספת מוצר (למשל: קוטג, עגבניות, 2 חלב)"
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") add(draft);
            else if (e.key === "Escape") setSuggestions([]);
          }}
          onBlur={() => window.setTimeout(() => setSuggestions([]), 200)}
          enterKeyHint="done"
        />
        {draft.trim() && (
          <button className="primary add-btn" onClick={() => add(draft)} aria-label="הוספה">הוספה</button>
        )}
        {draft.trim().length >= 2 && suggestions.length > 0 && (
          <ul className="suggest" role="listbox" aria-label="הצעות">
            {suggestions.map((s) => (
              <li key={s}>
                <button role="option" aria-selected={false} onClick={() => add(s)}>
                  <span aria-hidden>{categoryOf(s).icon}</span> {s}
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>
      {lines.length === 0 ? (
        <p className="muted small empty-list">הרשימה ריקה. הוסיפו מוצרים למעלה, או הדביקו רשימה שלמה ב"עריכה כטקסט".</p>
      ) : (
        <ul className="list-rows">
          {lines.map((line, i) => {
            const it = parseList(line)[0];
            const amt = lineAmount(line);
            if (!it || !amt) return null;
            const cat = categoryOf(it.key);
            const update = (l: string) => setLines(lines.map((x, j) => (j === i ? l : x)));
            const remove = () => setLines(lines.filter((_, j) => j !== i));
            return (
              <li key={`${i}-${line}`} className="list-row">
                <span className="row-icon" aria-hidden>{cat.icon}</span>
                <span className="row-name">
                  {it.key}
                  {it.volumeL && <span className="muted small"> · {it.volumeL} ל'</span>}
                  {amt.mode === "unit" && amt.approxKg && <span className="muted small"> · ≈{kgLabel(amt.approxKg)}</span>}
                </span>
                <span className="row-ctl">
                {amt.mode === "kg" ? (
                  <>
                    <button className="unit-chip" aria-label={`לקנות ${it.key} ביחידות`} onClick={() => update(setLineUnits(line, Math.max(1, Math.round(amt.kg / (unitWeight(it.key) ?? amt.kg)))))}>
                      ⚖️ ק"ג
                    </button>
                    <span className="stepper" role="group" aria-label={`כמות ${it.key}`}>
                      <button aria-label={`פחות ${it.key}`} onClick={() => (amt.kg - amt.step < amt.step / 2 ? remove() : update(setLineWeight(line, amt.kg - amt.step)))}>
                        {amt.kg - amt.step < amt.step / 2 ? "🗑" : "−"}
                      </button>
                      <span className="qty wide">{kgLabel(amt.kg)}</span>
                      <button aria-label={`עוד ${it.key}`} onClick={() => update(setLineWeight(line, amt.kg + amt.step))}>+</button>
                    </span>
                  </>
                ) : (
                  <>
                    {amt.canKg ? (
                      <button className="unit-chip" aria-label={`לקנות ${it.key} במשקל`} onClick={() => update(setLineWeight(line, amt.approxKg && amt.approxKg >= 0.25 ? Math.round(amt.approxKg * 4) / 4 : 1))}>
                        🔢 יח'
                      </button>
                    ) : (
                      <span className="unit-label">יח'</span>
                    )}
                    <span className="stepper" role="group" aria-label={`כמות ${it.key}`}>
                      <button aria-label={`פחות ${it.key}`} onClick={() => (amt.count <= 1 ? remove() : update(amt.canKg ? setLineUnits(line, amt.count - 1) : setLineQty(line, amt.count - 1)))}>
                        {amt.count <= 1 ? "🗑" : "−"}
                      </button>
                      <span className="qty">{amt.count}</span>
                      <button aria-label={`עוד ${it.key}`} onClick={() => update(amt.canKg ? setLineUnits(line, amt.count + 1) : setLineQty(line, amt.count + 1))}>
                        +
                      </button>
                    </span>
                  </>
                )}
                </span>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
