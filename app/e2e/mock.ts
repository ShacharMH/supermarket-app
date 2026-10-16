import type { Page, Route } from "@playwright/test";

export const USER_ID = "00000000-0000-0000-0000-000000000001";

const line = (key: string, name: string, total: number, promo: string | null = null, preferred = true) => ({
  key, qty: 1, barcode: name, name, price: total, total, promo, promo_min_qty: promo ? 2 : null, preferred,
});

export const ROWS = [
  { branch_id: 1, chain_id: "a", chain_name: "רמי לוי", branch_name: "רמלה", city: "רמלה", address: "הרצל 1", is_online: false, lat: 0, lon: 0,
    lines: [line("קוטג", "קוטג תנובה 5%", 10, "2 ב-10"), line("חלב 3%", "חלב תנובה 3%", 6.9), line("לחם", "לחם אחיד", 7.5)] },
  { branch_id: 2, chain_id: "b", chain_name: "שופרסל", branch_name: "שלי לוד", city: "לוד", address: "רמב\"ם 5", is_online: false, lat: 0, lon: 0,
    lines: [line("קוטג", "קוטג טרה 5%", 9.2, null, false), line("חלב 3%", "חלב טרה 3%", 7.4), line("לחם", "לחם אחיד", 8.1)] },
];

export const PRODUCT = { barcode: "7290000000001", name: "קוטג תנובה 5% 250 גרם", manufacturer: "תנובה", quantity: 250,
  unit_of_measure: "גרם", is_weighted: false, branches: 2, min_price: 5, max_price: 6.5 };

type Handler = (route: Route, url: string, body: string) => Promise<void> | void;

/** Signs in a fake user and serves Supabase REST calls from `handler` (default: empty lists). */
export async function mockSupabase(page: Page, handler?: Handler, opts: { signedIn?: boolean } = {}) {
  const signedIn = opts.signedIn ?? true;
  const exp = Math.floor(Date.now() / 1000) + 3600;
  const session = { access_token: "x.y.z", refresh_token: "r", token_type: "bearer", expires_in: 3600, expires_at: exp,
    user: { id: USER_ID, email: "me@example.com", aud: "authenticated", role: "authenticated" } };
  await page.route("**/auth/v1/**", (r) => r.fulfill({ json: session.user }));
  await page.route("**/rest/v1/**", async (r) => {
    const url = r.request().url();
    const body = r.request().postData() ?? "";
    if (handler) {
      await handler(r, url, body);
      return;
    }
    await r.fulfill({ json: [] });
  });
  if (signedIn) {
    await page.addInitScript((s) => localStorage.setItem("sb-grzjrbtxrrxccpxunfvy-auth-token", JSON.stringify(s)), session);
  }
}

export const listHandler: Handler = (r, url) => {
  if (url.includes("rpc/price_basket")) return r.fulfill({ json: ROWS });
  if (url.includes("rpc/search_products")) return r.fulfill({ json: [PRODUCT] });
  if (url.includes("shopping_lists")) return r.fulfill({ json: [{ id: 1, items: { text: "קוטג\nחלב 3%\nלחם" } }] });
  if (url.includes("branches")) return r.fulfill({ json: [], headers: { "content-range": "*/2" } });
  return r.fulfill({ json: [] });
};
