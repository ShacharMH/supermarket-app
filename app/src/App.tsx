import { useEffect, useState } from "react";
import type { Session } from "@supabase/supabase-js";
import { supabase } from "./supabase";
import Login from "./components/Login";
import ListPage from "./components/ListPage";
import SettingsPage from "./components/SettingsPage";
import ReceiptsPage from "./components/ReceiptsPage";

type Tab = "list" | "receipts" | "settings";

export default function App() {
  const [session, setSession] = useState<Session | null>(null);
  const [ready, setReady] = useState(false);
  const [tab, setTab] = useState<Tab>("list");

  useEffect(() => {
    supabase.auth.getSession().then(({ data }) => {
      setSession(data.session);
      setReady(true);
    });
    const { data } = supabase.auth.onAuthStateChange((_e, s) => setSession(s));
    return () => data.subscription.unsubscribe();
  }, []);

  if (!ready) return null;
  if (!session) return <Login />;

  return (
    <div className="app">
      <header className="top">
        <h1>סל זול</h1>
        <button className="link" onClick={() => supabase.auth.signOut()}>יציאה</button>
      </header>
      <main>
        {tab === "list" && <ListPage />}
        {tab === "receipts" && <ReceiptsPage />}
        {tab === "settings" && <SettingsPage />}
      </main>
      <nav className="tabs">
        <button className={tab === "list" ? "on" : ""} onClick={() => setTab("list")}>🛒 רשימה</button>
        <button className={tab === "receipts" ? "on" : ""} onClick={() => setTab("receipts")}>🧾 קבלות</button>
        <button className={tab === "settings" ? "on" : ""} onClick={() => setTab("settings")}>⚙️ הגדרות</button>
      </nav>
    </div>
  );
}
