import { useEffect, useState } from "react";
import { supabase } from "../supabase";
import { errorText } from "../lib/errors";
import { loadSettings, saveSettings, type Settings } from "../settings";

type Area = { id: number; label: string; city: string | null; lat: number | null; lon: number | null; radius_km: number };
type Chain = { chain_id: string; name: string };

export default function SettingsPage() {
  const [areas, setAreas] = useState<Area[]>([]);
  const [chains, setChains] = useState<Chain[]>([]);
  const [clubs, setClubs] = useState<Set<string>>(new Set());
  const [city, setCity] = useState("");
  const [radius, setRadius] = useState(5);
  const [settings, setSettings] = useState<Settings>(loadSettings());
  const [msg, setMsg] = useState<string | null>(null);

  async function load() {
    const [a, c, u] = await Promise.all([
      supabase.from("user_areas").select("id, label, city, lat, lon, radius_km").order("id"),
      supabase.from("chains").select("chain_id, name").order("name"),
      supabase.from("user_clubs").select("chain_id"),
    ]);
    setAreas((a.data ?? []) as Area[]);
    setChains((c.data ?? []) as Chain[]);
    setClubs(new Set((u.data ?? []).map((x) => x.chain_id)));
  }
  useEffect(() => {
    load();
  }, []);

  async function addCity() {
    if (!city.trim()) return;
    const { error } = await supabase.from("user_areas").insert({ label: city.trim(), city: city.trim(), radius_km: radius });
    if (error) setMsg(errorText(error));
    else {
      setCity("");
      setMsg("נוסף. הסניפים באזור ייכנסו למעקב בריצת האיסוף הבאה.");
      load();
    }
  }

  function addHere() {
    if (!navigator.geolocation) return setMsg("הדפדפן לא תומך במיקום");
    navigator.geolocation.getCurrentPosition(
      async (pos) => {
        const { error } = await supabase.from("user_areas").insert({
          label: "המיקום שלי", lat: pos.coords.latitude, lon: pos.coords.longitude, radius_km: radius,
        });
        setMsg(error ? errorText(error) : "המיקום נוסף. הסניפים באזור ייכנסו למעקב בריצת האיסוף הבאה.");
        load();
      },
      (e) => setMsg(e.message),
    );
  }

  async function removeArea(id: number) {
    await supabase.from("user_areas").delete().eq("id", id);
    load();
  }

  async function toggleClub(chainId: string, on: boolean) {
    if (on) await supabase.from("user_clubs").insert({ chain_id: chainId });
    else await supabase.from("user_clubs").delete().eq("chain_id", chainId);
    load();
  }

  function update(patch: Partial<Settings>) {
    const s = { ...settings, ...patch };
    setSettings(s);
    saveSettings(s);
  }

  return (
    <div className="page">
      <section className="card">
        <h3>האזורים שלי</h3>
        <p className="muted small">מחירים נאספים רק לסניפים באזורים האלה, וגם לחנות האונליין הקרובה של כל רשת.</p>
        <ul className="plain">
          {areas.map((a) => (
            <li key={a.id}>
              <span>
                {a.label} · {a.radius_km} ק"מ
              </span>
              <button className="link" onClick={() => removeArea(a.id)}>הסרה</button>
            </li>
          ))}
        </ul>
        <div className="row">
          <input aria-label="עיר" placeholder="עיר (למשל רמלה)" value={city} onChange={(e) => setCity(e.target.value)} />
          <select aria-label="רדיוס" value={radius} onChange={(e) => setRadius(Number(e.target.value))}>
            {[2, 5, 10, 15, 25].map((r) => (
              <option key={r} value={r}>{r} ק"מ</option>
            ))}
          </select>
        </div>
        <div className="row">
          <button className="primary" onClick={addCity}>הוספת עיר</button>
          <button onClick={addHere}>📍 המיקום הנוכחי</button>
        </div>
        {msg && <p className="note">{msg}</p>}
      </section>

      <section className="card">
        <h3>מועדוני לקוחות</h3>
        <p className="muted small">מבצעי מועדון יחושבו רק ברשתות שמסומנות כאן.</p>
        {chains.length === 0 && <p className="muted small">רשימת הרשתות תופיע אחרי ריצת האיסוף הראשונה.</p>}
        <div className="clubs">
          {chains.map((c) => (
            <label key={c.chain_id}>
              <input type="checkbox" checked={clubs.has(c.chain_id)} onChange={(e) => toggleClub(c.chain_id, e.target.checked)} />
              {c.name}
            </label>
          ))}
        </div>
      </section>

      <section className="card">
        <h3>העדפות חישוב</h3>
        <label className="lbl">
          מוצר חלופי ייבחר רק אם הוא זול ביותר מ-{settings.penalty}% מהמועדף
          <input type="range" min={0} max={50} step={5} value={settings.penalty} onChange={(e) => update({ penalty: Number(e.target.value) })} />
        </label>
        <label className="lbl">
          דמי משלוח לחנויות אונליין (₪)
          <input type="number" min={0} value={settings.deliveryFee} onChange={(e) => update({ deliveryFee: Number(e.target.value) })} />
        </label>
        <label className="lbl">
          להציע פיצול לשני סופרים רק אם חוסך לפחות (₪)
          <input type="number" min={0} value={settings.minSplitSaving} onChange={(e) => update({ minSplitSaving: Number(e.target.value) })} />
        </label>
      </section>
    </div>
  );
}
