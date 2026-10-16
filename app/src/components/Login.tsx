import { useState } from "react";
import { supabase } from "../supabase";

export default function Login() {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [msg, setMsg] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function go(mode: "in" | "up") {
    setBusy(true);
    setMsg(null);
    const { error } =
      mode === "in"
        ? await supabase.auth.signInWithPassword({ email, password })
        : await supabase.auth.signUp({ email, password, options: { emailRedirectTo: location.href } });
    setBusy(false);
    if (error) setMsg(error.message);
    else if (mode === "up") setMsg("נשלח מייל אימות - אחרי האישור אפשר להתחבר.");
  }

  return (
    <div className="login">
      <h1>סל זול 🛒</h1>
      <p className="muted">איפה סל הקניות שלך הכי זול</p>
      <input type="email" placeholder="אימייל" value={email} onChange={(e) => setEmail(e.target.value)} dir="ltr" autoComplete="email" />
      <input type="password" placeholder="סיסמה" value={password} onChange={(e) => setPassword(e.target.value)} dir="ltr" autoComplete="current-password" />
      <button className="primary" disabled={busy} onClick={() => go("in")}>כניסה</button>
      <button className="link" disabled={busy} onClick={() => go("up")}>הרשמה ראשונה</button>
      {msg && <p className="note">{msg}</p>}
    </div>
  );
}
