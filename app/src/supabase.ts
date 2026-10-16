import { createClient } from "@supabase/supabase-js";

// Publishable key: safe to ship in the client. Data access is governed by RLS.
const url = import.meta.env.VITE_SUPABASE_URL ?? "https://grzjrbtxrrxccpxunfvy.supabase.co";
const key = import.meta.env.VITE_SUPABASE_KEY ?? "sb_publishable_FDOm9DPEBbIbrUZW80QFPA_LnUzhxpR";

export const supabase = createClient(url, key, {
  auth: { persistSession: true, autoRefreshToken: true },
});
