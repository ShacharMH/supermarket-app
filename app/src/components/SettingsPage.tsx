import { useEffect, useState } from "react";
import { supabase } from "../supabase";
import { errorText } from "../lib/errors";
import { loadSettings, saveSettings, type Settings } from "../settings";
import { nearestArea, type Area } from "../lib/basket";

type Chain = { chain_id: string; name: string };
type Home = { home_lat: number | null; home_lon: number | null; home_label: string | null };

export default function SettingsPage() {
  const [areas, setAreas] = useState<Area[]>([]);
  const [chains, setChains] = useState<Chain[]>([]);
  const [clubs, setClubs] = useState<Set<string>>(new Set());
  const [city, setCity] = useState("");
  const [radius, setRadius] = useState(5);
  const [settings, setSettings] = useState<Settings>(loadSettings());
  const [msg, setMsg] = useState<string | null>(null);
  const [home, setHome] = useState<Home | null>(null);
  const [homeMsg, setHomeMsg] = useState<string | null>(null);

  async function load() {
    const [a, c, u, h] = await Promise.all([
      supabase.from("user_areas").select("id, label, city, lat, lon, radius_km").order("id"),
      supabase.from("chains").select("chain_id, name").order("name"),
      supabase.from("user_clubs").select("chain_id"),
      supabase.from("user_profile").select("home_lat, home_lon, home_label").maybeSingle(),
    ]);
    setHome((h.data as Home | null) ?? null);
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
      setMsg("נוסף. מחירים לסניפים חדשים באזור ייאספו בריצה הלילית הבאה.");
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

  const nearHome = home?.home_lat != null && areas.length > 1
    ? nearestArea(areas, { lat: home.home_lat, lon: home.home_lon! }) : undefined;

  function setHomeHere() {
    if (!navigator.geolocation) return setHomeMsg("הדפדפן לא תומך במיקום");
    setHomeMsg("מאתר מיקום...");
    navigator.geolocation.getCurrentPosition(
      async (pos) => {
        const { error } = await supabase.from("user_profile").upsert({
          home_lat: pos.coords.latitude, home_lon: pos.coords.longitude, home_label: "המיקום שנשמר", updated_at: new Date().toISOString(),
        });
        setHomeMsg(error ? errorText(error) : "נשמר. הסל הזול יחושב באזור הזה.");
        load();
      },
      (e) => setHomeMsg(e.message),
      { enableHighAccuracy: true, timeout: 15000 },
    );
  }

  async function clearHome() {
    await supabase.from("user_profile").update({ home_lat: null, home_lon: null, home_label: null }).not("user_id", "is", null);
    setHomeMsg("המיקום הוסר. ההשוואה תכלול את כל האזורים.");
    load();
  }

  async function removeArea(id: number) {
    await supabase.from("user_areas").delete().eq("id", id);
    setMsg("האזור הוסר. סניפים שמחוץ לאזורים שלך כבר לא יופיעו בהשוואה.");
    load();
  }

  async function toggleClub(chainId: string, on: boolean) {
    if (on) await supabase.from("user_clubs").insert({ chain_id: chainId });
    else await supabase.from("user_clubs").delete().eq("chain_id", chainId);
    load();
  }

  async function checkForUpdate() {
    setMsg("בודק עדכונים...");
    try {
      const reg = await navigator.serviceWorker?.getRegistration();
      await reg?.update();
    } catch {
      /* offline - just reload what we have */
    }
    location.reload();
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
        <h3>קונה עכשיו ב</h3>
        <p className="muted small">
          הסל הזול מחושב רק באזור הקרוב למיקום הזה, ובמחיר זהה הסניף הקרוב מופיע ראשון. נשמר רק בחשבון שלך.
        </p>
        {home?.home_lat != null ? (
          <div className="row">
            <span>📍 {nearHome ? `באזור ${nearHome.label}` : "המיקום נשמר"}</span>
            <button className="link" onClick={clearHome}>הסרה</button>
          </div>
        ) : (
          <p className="muted small">לא הוגדר. בינתיים ההשוואה כוללת את כל האזורים.</p>
        )}
        <button onClick={setHomeHere}>📍 אני קונה כאן (המיקום הנוכחי)</button>
        {homeMsg && <p className="note">{homeMsg}</p>}
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
        <label className="check-row">
          <input type="checkbox" checked={settings.includeOnline} onChange={(e) => update({ includeOnline: e.target.checked })} />
          להשוות גם לחנויות אונליין (משלוח עד הבית)
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

      <section className="card">
        <h3>על האפליקציה</h3>
        <p className="muted small">
          גרסה {__APP_VERSION__} · עודכנה {new Date(__BUILT_AT__).toLocaleString("he-IL")}
        </p>
        <button onClick={checkForUpdate}>🔄 בדיקת עדכונים</button>
      </section>
    </div>
  );
}
