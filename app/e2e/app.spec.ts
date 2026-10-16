import { expect, test } from "@playwright/test";
import { listHandler, mockSupabase, PRODUCT, ROWS } from "./mock";

test("shows the login screen when signed out", async ({ page }) => {
  await mockSupabase(page, undefined, { signedIn: false });
  await page.goto("./");
  await expect(page.getByRole("button", { name: "כניסה" })).toBeVisible();
});

test("compares a list and shows the cheapest store", async ({ page }) => {
  await mockSupabase(page, listHandler);
  await page.goto("./");
  await expect(page.locator("textarea")).toHaveValue(/קוטג/);
  await page.getByRole("button", { name: "איפה הכי זול?" }).click();
  const best = page.locator(".best");
  await expect(best).toContainText("רמי לוי");
  await expect(best).toContainText("₪24.40");
  await expect(page.locator(".stores > li")).toHaveCount(ROWS.length);
  await expect(page.getByText("איך הבנתי את הרשימה")).toBeVisible();
});

test("shows a readable message when the server fails", async ({ page }) => {
  await mockSupabase(page, (r, url) => {
    if (url.includes("rpc/search_products"))
      return r.fulfill({ status: 500, json: { code: "57014", message: "canceling statement due to statement timeout" } });
    return listHandler(r, url, "");
  });
  await page.goto("./");
  await page.getByRole("button", { name: "איפה הכי זול?" }).click();
  await expect(page.locator(".error")).toContainText("statement timeout");
  await expect(page.locator("body")).not.toContainText("[object Object]");
});

test("retries a multi-word item with fewer words", async ({ page }) => {
  const terms: string[] = [];
  await mockSupabase(page, (r, url, body) => {
    if (url.includes("rpc/search_weighed")) return r.fulfill({ json: [] });
    if (url.includes("rpc/search_products")) {
      const term = JSON.parse(body).term as string;
      terms.push(term);
      return r.fulfill({ json: term === "שמנת חמוצה" ? [PRODUCT] : [] });
    }
    if (url.includes("shopping_lists")) return r.fulfill({ json: [{ id: 1, items: { text: "שמנת חמוצה טרייה" } }] });
    return listHandler(r, url, body);
  });
  await page.goto("./");
  await page.getByRole("button", { name: "איפה הכי זול?" }).click();
  await expect(page.locator(".best")).toBeVisible();
  expect(terms).toEqual(["שמנת חמוצה טרייה", "שמנת חמוצה"]);
});

test("choosing a product recalculates and confirms", async ({ page }) => {
  const posted: string[] = [];
  let baskets = 0;
  await mockSupabase(page, (r, url, body) => {
    if (url.includes("product_preferences") && r.request().method() === "POST") posted.push(body);
    if (url.includes("product_preferences") && r.request().method() === "GET")
      return r.fulfill({ json: posted.length ? [JSON.parse(posted[posted.length - 1])] : [] });
    if (url.includes("rpc/price_basket")) baskets++;
    return listHandler(r, url, body);
  });
  await page.goto("./");
  await page.getByRole("button", { name: "איפה הכי זול?" }).click();
  await expect(page.locator(".best")).toBeVisible();
  await page.locator(".item select").first().selectOption(PRODUCT.barcode);
  await expect(page.getByText(/הסל חושב מחדש/)).toBeVisible();
  expect(baskets).toBe(2);
  expect(posted[0]).toContain(PRODUCT.barcode);
  await page.getByText("רק המוצר הזה, בלי תחליפים").first().click();
  await expect.poll(() => posted.length).toBe(2);
  expect(JSON.parse(posted[1]).strict).toBe(true);
});

test("weighed items show weight and per-kg price", async ({ page }) => {
  const meat = { ...PRODUCT, barcode: "c:1", name: "בשר בקר טחון טרי", is_weighted: true, quantity: 1, unit_of_measure: "קילוגרם" };
  let payload = "";
  await mockSupabase(page, (r, url, body) => {
    if (url.includes("rpc/search_products")) return r.fulfill({ json: [] });
    if (url.includes("rpc/search_weighed")) return r.fulfill({ json: [meat] });
    if (url.includes("rpc/price_basket")) {
      payload = body;
      return r.fulfill({ json: [{ ...ROWS[0], lines: [{ key: "בשר טחון", qty: 0.5, barcode: "c:1", name: meat.name, price: 64.9, total: 32.45, promo: null, promo_min_qty: null, preferred: true }] }] });
    }
    if (url.includes("shopping_lists")) return r.fulfill({ json: [{ id: 1, items: { text: "בשר טחון מהקצביה 500 גרם" } }] });
    return listHandler(r, url, body);
  });
  await page.goto("./");
  await page.getByRole("button", { name: "איפה הכי זול?" }).click();
  await expect(page.locator(".best")).toContainText("₪32.45");
  expect(JSON.parse(payload).items[0]).toMatchObject({ key: "בשר טחון", qty: 0.5 });
  await page.locator(".best summary").click();
  await expect(page.locator(".best")).toContainText('500 גרם');
  await expect(page.locator(".best")).toContainText('לק"ג');
});

test("guesses by-weight for butcher items and lets the user switch", async ({ page }) => {
  const meat = { ...PRODUCT, barcode: "c:1", name: "בשר בקר טחון טרי", is_weighted: true, quantity: 1, unit_of_measure: "קילוגרם" };
  const frozen = { ...PRODUCT, barcode: "7290000000099", name: "בשר טחון קפוא 500 גרם", quantity: 500 };
  let saved: Record<string, unknown> | null = null;
  const payloads: string[] = [];
  await mockSupabase(page, (r, url, body) => {
    if (url.includes("rpc/search_products")) return r.fulfill({ json: [frozen] });
    if (url.includes("rpc/search_weighed")) return r.fulfill({ json: [meat] });
    if (url.includes("term_settings") && r.request().method() === "POST") saved = JSON.parse(body);
    if (url.includes("term_settings") && r.request().method() === "GET") return r.fulfill({ json: saved ? [saved] : [] });
    if (url.includes("rpc/price_basket")) payloads.push(body);
    if (url.includes("shopping_lists")) return r.fulfill({ json: [{ id: 1, items: { text: "בשר טחון" } }] });
    return listHandler(r, url, body);
  });
  await page.goto("./");
  await page.getByRole("button", { name: "איפה הכי זול?" }).click();
  await expect(page.getByRole("button", { name: /במשקל/ })).toHaveClass(/on/);
  expect(JSON.parse(payloads[0]).items[0]).toMatchObject({ qty: 0.5, candidates: ["c:1"] });
  await page.getByRole("button", { name: /ארוז/ }).click();
  await expect(page.getByText(/הסל חושב מחדש/)).toBeVisible();
  expect(saved).toMatchObject({ term: "בשר טחון", mode: "pack" });
  expect(JSON.parse(payloads[1]).items[0]).toMatchObject({ qty: 1, candidates: [frozen.barcode] });
});

test("empty data explains what to do", async ({ page }) => {
  await mockSupabase(page, (r, url) => {
    if (url.includes("shopping_lists")) return r.fulfill({ json: [{ id: 1, items: { text: "חלב" } }] });
    if (url.includes("branches")) return r.fulfill({ json: [], headers: { "content-range": "*/0" } });
    return r.fulfill({ json: [] });
  });
  await page.goto("./");
  await expect(page.getByText("עדיין אין סניפים במעקב")).toBeVisible();
  await page.getByRole("button", { name: "איפה הכי זול?" }).click();
  await expect(page.getByText("לא נמצאו מחירים")).toBeVisible();
});

test("settings: adding a city sends it to the server", async ({ page }) => {
  let inserted = "";
  await mockSupabase(page, (r, url, body) => {
    if (url.includes("user_areas") && r.request().method() === "POST") inserted = body;
    if (url.includes("chains")) return r.fulfill({ json: [{ chain_id: "a", name: "רמי לוי" }] });
    return r.fulfill({ json: [] });
  });
  await page.goto("./");
  await page.getByRole("button", { name: /הגדרות/ }).click();
  await expect(page.getByText("רמי לוי")).toBeVisible();
  await page.getByPlaceholder("עיר (למשל רמלה)").fill("לוד");
  await page.getByRole("button", { name: "הוספת עיר" }).click();
  await expect.poll(() => inserted).toContain("לוד");
});

test("receipts: template download and CSV preview", async ({ page }) => {
  await mockSupabase(page);
  await page.goto("./");
  await page.getByRole("button", { name: /קבלות/ }).click();
  const download = page.waitForEvent("download");
  await page.getByRole("button", { name: /הורדת תבנית/ }).click();
  expect((await download).suggestedFilename()).toBe("receipt-template.csv");
  await page.locator("textarea").fill("מוצר,כמות,מחיר\nקוטג,2,11.80\nחלב,1,7");
  await expect(page.locator(".tbl.preview tbody tr")).toHaveCount(2);
  await expect(page.getByRole("button", { name: /שמירת קבלה \(2 פריטים\)/ })).toBeEnabled();
});
