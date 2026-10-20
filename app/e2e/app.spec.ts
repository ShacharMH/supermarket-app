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
  await expect(page.locator(".list-row")).toHaveCount(3);
  await expect(page.locator(".list-row").first()).toContainText("קוטג");
  await page.getByRole("button", { name: "איפה הכי זול?" }).click();
  const best = page.locator(".best");
  await expect(best).toContainText("רמי לוי");
  await expect(best).toContainText("₪24.40");
  await expect(page.locator(".stores .store")).toHaveCount(ROWS.length - 1); // the others, best is on top
  await expect(page.locator(".stores .store").first()).toContainText("+₪0.30");
  await expect(page.getByText("המוצרים ברשימה")).toBeVisible();
});

test("shows a readable message when the server fails", async ({ page }) => {
  await mockSupabase(page, (r, url) => {
    if (url.includes("rpc/search_products"))
      return r.fulfill({ status: 500, json: { code: "57014", message: "canceling statement due to statement timeout" } });
    return listHandler(r, url, "");
  });
  await page.goto("./");
  await page.getByRole("button", { name: "איפה הכי זול?" }).click();
  await expect(page.locator(".error")).toContainText("השרת עמוס");
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
  await page.locator(".item").first().getByRole("button", { name: /שינוי/ }).click();
  const sheet = page.getByRole("dialog");
  await sheet.getByRole("radio", { name: /מוצר מסוים/ }).click();
  await sheet.getByRole("button", { name: /קוטג תנובה 5% 250 גרם/ }).click();
  await sheet.getByRole("checkbox").uncheck(); // no substitutes
  expect(baskets).toBe(1); // nothing is saved before "סיום"
  await sheet.getByRole("button", { name: "סיום" }).click();
  await expect(page.locator(".toast")).toContainText("הכי משתלם עכשיו");
  await expect(sheet).toHaveCount(0);
  expect(baskets).toBe(2);
  expect(JSON.parse(posted[0])).toMatchObject({ barcode: PRODUCT.barcode, strict: true });
  await expect(page.locator(".item").first()).toContainText("⭐ קוטג תנובה 5% 250 גרם בלבד");
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
  await expect(page.locator(".best")).toContainText('500 גרם');
  await expect(page.locator(".best")).toContainText('לק"ג');
});

test("guesses by-weight for butcher items and lets the user switch", async ({ page }) => {
  const meat = { ...PRODUCT, barcode: "c:1", name: "בשר בקר טחון טרי", is_weighted: true, quantity: 1, unit_of_measure: "קילוגרם" };
  const frozen = { ...PRODUCT, barcode: "7290000000099", name: "בשר טחון 500 גרם במגש", quantity: 500 };
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
  await expect(page.locator(".item")).toContainText("⚖️ 500 גרם");
  expect(JSON.parse(payloads[0]).items[0]).toMatchObject({ qty: 0.5, candidates: ["c:1"] });
  await page.getByRole("button", { name: /שינוי/ }).click();
  await expect(page.getByRole("button", { name: /במשקל/ })).toHaveClass(/on/);
  await page.getByRole("button", { name: /📦 ארוז/ }).click();
  await page.getByRole("button", { name: "סיום" }).click();
  await expect(page.locator(".toast")).toContainText("הכי משתלם עכשיו");
  expect(saved).toMatchObject({ term: "בשר טחון", mode: "pack" });
  expect(JSON.parse(payloads[1]).items[0]).toMatchObject({ qty: 1, candidates: [frozen.barcode] });
});

test("best store shows a shopping list to tick off and share", async ({ page }) => {
  await page.addInitScript(() => {
    (navigator as unknown as { share?: unknown }).share = undefined;
    Object.defineProperty(navigator, "clipboard", { value: { writeText: (t: string) => ((window as unknown as { copied: string }).copied = t, Promise.resolve()) } });
  });
  await mockSupabase(page, listHandler);
  await page.goto("./");
  await page.getByRole("button", { name: "איפה הכי זול?" }).click();
  const list = page.locator(".best .shoplist li");
  await expect(list).toHaveCount(3);
  // grouped by department in walking order: bakery before dairy
  await expect(page.locator(".best .dept-head")).toHaveText([/מאפים ולחם/, /מוצרי חלב/]);
  const cottage = page.locator(".best .shoplist li", { hasText: "קוטג תנובה 5%" });
  await expect(cottage).toContainText("מבצע: 2 ב-10");
  await cottage.locator("input").check();
  await expect(cottage).toHaveClass(/done/);
  await page.locator(".best").getByRole("button", { name: /שיתוף/ }).click();
  await expect(page.locator(".best").getByRole("button", { name: "✓ הועתק" })).toBeVisible();
  expect(await page.evaluate(() => (window as unknown as { copied: string }).copied)).toContain("🛒 רמי לוי · רמלה");
});

test("by-weight items always show their weight, even with no packaged option", async ({ page }) => {
  const meat = { ...PRODUCT, barcode: "c:1", name: "בשר בקר טחון טרי", is_weighted: true, quantity: 1, unit_of_measure: "קילוגרם" };
  const weighedTerms: string[] = [];
  await mockSupabase(page, (r, url, body) => {
    if (url.includes("rpc/search_weighed")) {
      weighedTerms.push(JSON.parse(body).term);
      return r.fulfill({ json: body.includes("בשר") ? [meat] : [] });
    }
    if (url.includes("rpc/search_products")) return r.fulfill({ json: body.includes("בשר") ? [] : [PRODUCT] });
    if (url.includes("shopping_lists")) return r.fulfill({ json: [{ id: 1, items: { text: "בשר טחון מהקצביה\nחלב 3%" } }] });
    return listHandler(r, url, body);
  });
  await page.goto("./");
  await page.getByRole("button", { name: "איפה הכי זול?" }).click();
  const meatItem = page.locator(".item", { hasText: "בשר טחון" });
  await expect(meatItem).toContainText("⚖️ 500 גרם");
  await meatItem.getByRole("button", { name: /שינוי/ }).click();
  await expect(page.getByRole("dialog").locator(".grams input")).toHaveValue("500");
  await page.getByRole("dialog").getByRole("button", { name: "סגירה" }).click();
  const milkItem = page.locator(".item", { hasText: "חלב 3%" });
  await expect(milkItem).toContainText("📦 1 יח'");
  await milkItem.getByRole("button", { name: /שינוי/ }).click();
  await expect(page.getByRole("dialog").locator(".seg")).toHaveCount(0);
  expect(weighedTerms).not.toContain("חלב"); // never relaxed to a single word
});

test("the item sheet: nothing changed, nothing recalculated; any way of closing keeps a change", async ({ page }) => {
  let baskets = 0;
  await mockSupabase(page, (r, url, body) => {
    if (url.includes("rpc/price_basket")) baskets++;
    return listHandler(r, url, body);
  });
  await page.goto("./");
  await page.getByRole("button", { name: "איפה הכי זול?" }).click();
  await expect(page.locator(".best")).toBeVisible();
  await page.locator(".item").first().getByRole("button", { name: /שינוי/ }).click();
  await expect(page.getByRole("dialog")).toContainText('מה חשוב לך ב"קוטג"?');
  await expect(page.getByRole("radio", { name: /הכי זול/ })).toHaveAttribute("aria-checked", "true");
  await page.getByRole("button", { name: "סיום" }).click();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await page.locator(".item").first().getByRole("button", { name: /שינוי/ }).click();
  await page.keyboard.press("Escape");
  await expect(page.getByRole("dialog")).toHaveCount(0);
  expect(baskets).toBe(1);
  // a choice is kept however the sheet is closed
  await page.locator(".item").first().getByRole("button", { name: /שינוי/ }).click();
  await page.getByRole("radio", { name: /מוצר מסוים/ }).click();
  await page.getByRole("dialog").getByRole("button", { name: "סגירה" }).click();
  await expect(page.locator(".toast")).toContainText("עודכן");
  expect(baskets).toBe(2);
});

test("the item sheet: brands I like", async ({ page }) => {
  const pasta = (barcode: string, name: string, manufacturer: string, min_price: number) => ({ ...PRODUCT, barcode, name, manufacturer, min_price, max_price: min_price, quantity: 500 });
  const all = [pasta("a", "ספגטי אסם", "אסם", 5.9), pasta("b", "ספגטי ברילה", "ברילה", 8.9), pasta("c", "ספגטי לה מוליסנה", "לה מוליסנה אס.פ.א.", 9.5)];
  let saved: Record<string, unknown> | null = null;
  const payloads: string[] = [];
  await mockSupabase(page, (r, url, body) => {
    if (url.includes("rpc/search_products")) return r.fulfill({ json: all });
    if (url.includes("term_settings") && r.request().method() === "POST") saved = JSON.parse(body);
    if (url.includes("term_settings") && r.request().method() === "GET") return r.fulfill({ json: saved ? [saved] : [] });
    if (url.includes("rpc/price_basket")) payloads.push(body);
    if (url.includes("shopping_lists")) return r.fulfill({ json: [{ id: 1, items: { text: "ספגטי" } }] });
    return listHandler(r, url, body);
  });
  await page.goto("./");
  await page.getByRole("button", { name: "איפה הכי זול?" }).click();
  await expect(page.locator(".item")).toContainText("💰 הכי זול");
  await page.getByRole("button", { name: /שינוי/ }).click();
  const sheet = page.getByRole("dialog");
  await sheet.getByRole("radio", { name: /מותגים שאני אוהבת/ }).click();
  await sheet.getByRole("button", { name: /ברילה/ }).click();
  await sheet.getByRole("button", { name: /לה מוליסנה/ }).click();
  await expect(sheet.locator(".result")).toContainText("ספגטי ברילה");
  await sheet.getByRole("button", { name: "סיום" }).click();
  await expect(page.locator(".toast")).toContainText("עודכן");
  expect(saved).toMatchObject({ term: "ספגטי", choice: "brands", brands: ["ברילה", "לה מוליסנה"] });
  expect(JSON.parse(payloads[1]).items[0].candidates.sort()).toEqual(["b", "c"]);
  await expect(page.locator(".item")).toContainText("🏷️ ברילה, לה מוליסנה");
});

test("liked brands outside the first results are still found and shown as chosen", async ({ page }) => {
  const pasta = (barcode: string, name: string, manufacturer: string, min_price: number) => ({ ...PRODUCT, barcode, name, manufacturer, min_price, max_price: min_price, quantity: 500 });
  const plain = [pasta("a", "פסטה אסם", "אסם", 5.9), pasta("b", "פסטה ברילה", "ברילה", 8.9)];
  const regia = pasta("r", "פסטה רגיה", "פאסטופיציו", 7.5);
  const payloads: string[] = [];
  await mockSupabase(page, (r, url, body) => {
    if (url.includes("rpc/search_products")) return r.fulfill({ json: JSON.parse(body).term === "פסטה פאסטופיציו" ? [regia] : JSON.parse(body).term === "פסטה" ? plain : [] });
    if (url.includes("term_settings") && r.request().method() === "GET")
      return r.fulfill({ json: [{ term: "פסטה", choice: "brands", brands: ["ברילה", "פאסטופיציו", "נעלם"], excluded: [] }] });
    if (url.includes("rpc/price_basket")) payloads.push(body);
    if (url.includes("shopping_lists")) return r.fulfill({ json: [{ id: 1, items: { text: "פסטה" } }] });
    return listHandler(r, url, body);
  });
  await page.goto("./");
  await page.getByRole("button", { name: "איפה הכי זול?" }).click();
  await expect(page.locator(".item")).toContainText("🏷️");
  expect(JSON.parse(payloads[0]).items[0].candidates.sort()).toEqual(["b", "r"]);
  await page.getByRole("button", { name: /שינוי/ }).click();
  const sheet = page.getByRole("dialog");
  for (const b of ["ברילה", "פאסטופיציו", "נעלם"]) await expect(sheet.getByRole("button", { name: new RegExp(b) })).toHaveAttribute("aria-pressed", "true");
  await expect(sheet.getByRole("button", { name: /אסם/ })).toHaveAttribute("aria-pressed", "false");
});

test("reopening the sheet while the basket is recalculated shows what was just chosen", async ({ page }) => {
  const pasta = (barcode: string, name: string, manufacturer: string, min_price: number) => ({ ...PRODUCT, barcode, name, manufacturer, min_price, max_price: min_price, quantity: 500 });
  const all = [pasta("a", "ספגטי אסם", "אסם", 5.9), pasta("b", "ספגטי ברילה", "ברילה", 8.9), pasta("c", "ספגטי לה מוליסנה", "לה מוליסנה", 9.5)];
  let saved: Record<string, unknown> | null = null;
  let slow = false;
  await mockSupabase(page, async (r, url, body) => {
    if (url.includes("rpc/search_products")) {
      if (slow) await new Promise((ok) => setTimeout(ok, 1500));
      return r.fulfill({ json: all });
    }
    if (url.includes("term_settings") && r.request().method() === "POST") saved = JSON.parse(body);
    if (url.includes("term_settings") && r.request().method() === "GET") return r.fulfill({ json: saved ? [saved] : [] });
    if (url.includes("shopping_lists")) return r.fulfill({ json: [{ id: 1, items: { text: "ספגטי" } }] });
    return listHandler(r, url, body);
  });
  await page.goto("./");
  await page.getByRole("button", { name: "איפה הכי זול?" }).click();
  await expect(page.locator(".item")).toContainText("💰 הכי זול");
  slow = true;
  await page.getByRole("button", { name: /שינוי/ }).click();
  let sheet = page.getByRole("dialog");
  await sheet.getByRole("radio", { name: /מותגים שאני אוהבת/ }).click();
  await sheet.getByRole("button", { name: /ברילה/ }).click();
  await sheet.getByRole("button", { name: "סיום" }).click();
  await expect(page.locator(".toast")).toContainText("מחשב מחדש");
  await page.getByRole("button", { name: /שינוי/ }).click();
  sheet = page.getByRole("dialog");
  await expect(sheet.getByRole("button", { name: /ברילה/ })).toHaveAttribute("aria-pressed", "true");
  await sheet.getByRole("button", { name: /לה מוליסנה/ }).click();
  await expect(page.locator(".toast")).toContainText("עודכן");
  // the recalculation ending while the sheet is open changes nothing in it
  await expect(sheet.getByRole("button", { name: /ברילה/ })).toHaveAttribute("aria-pressed", "true");
  await expect(sheet.getByRole("button", { name: /לה מוליסנה/ })).toHaveAttribute("aria-pressed", "true");
  await sheet.getByRole("button", { name: "סיום" }).click();
  await expect.poll(() => saved?.brands).toEqual(["ברילה", "לה מוליסנה"]);
});

test("settings show the app version and an update button", async ({ page }) => {
  await mockSupabase(page);
  await page.goto("./");
  await page.getByRole("button", { name: /הגדרות/ }).click();
  await expect(page.getByText(/^גרסה /)).toBeVisible();
  await expect(page.getByRole("button", { name: /בדיקת עדכונים/ })).toBeVisible();
});

test("a requested size is filled with the right number of packs", async ({ page }) => {
  const four = { ...PRODUCT, barcode: "4l", name: "אקונומיקה 4 ל'", quantity: 4000, unit_of_measure: 'מ"ל' };
  const one = { ...PRODUCT, barcode: "1l", name: "אקונומיקה 1 ליטר", quantity: 1, unit_of_measure: "ליטר" };
  const tiny = { ...PRODUCT, barcode: "05", name: "אקונומיקה 500 מ\"ל", quantity: 500, unit_of_measure: 'מ"ל' };
  let payload = "";
  await mockSupabase(page, (r, url, body) => {
    if (url.includes("rpc/search_products")) return r.fulfill({ json: JSON.parse(body).term === "אקונומיקה" ? [tiny, four, one] : [] });
    if (url.includes("rpc/price_basket")) payload = body;
    if (url.includes("shopping_lists")) return r.fulfill({ json: [{ id: 1, items: { text: "אקונומיקה 5 ליטר" } }] });
    return listHandler(r, url, body);
  });
  await page.goto("./");
  await page.getByRole("button", { name: "איפה הכי זול?" }).click();
  await expect.poll(() => payload).not.toBe("");
  const item = JSON.parse(payload).items[0];
  expect(item.candidates).toEqual(["4l", "1l"]);
  expect(item.qtys).toEqual({ "4l": 1, "1l": 5 });
});

test("in-store mode: big list, tick items, progress, finish", async ({ page }) => {
  await mockSupabase(page, (r, url, body) => {
    if (url.includes("rpc/price_basket"))
      return r.fulfill({ json: [{ ...ROWS[0], lines: ROWS[0].lines.map((l, i) => (i === 1 ? { ...l, price: 6.9, hint: "2 ב-11", hint_qty: 2, hint_unit: 5.5 } : l)) }] });
    return listHandler(r, url, body);
  });
  await page.goto("./");
  await page.getByRole("button", { name: "איפה הכי זול?" }).click();
  await expect(page.locator(".best .sl-hint")).toContainText("עוד יחידה אחת");
  await page.locator(".best").getByRole("button", { name: /מצב קנייה/ }).click();
  const dlg = page.getByRole("dialog");
  await expect(dlg).toContainText("0/3 בעגלה");
  await expect(dlg.locator(".sm-hint")).toContainText("₪5.50 ליחידה");
  await dlg.locator(".sm-row").first().click();
  await expect(dlg).toContainText("1/3 בעגלה");
  await expect(dlg.locator(".sm-sep")).toHaveText("בעגלה");
  await dlg.locator("li:not(.done) .sm-row").first().click();
  await dlg.locator("li:not(.done) .sm-row").first().click();
  await expect(dlg).toContainText("הכול בעגלה");
  await dlg.getByRole("button", { name: /סיום/ }).click();
  await expect(dlg).toHaveCount(0);
  await expect(page.locator(".best .shoplist input:checked")).toHaveCount(0);
});

test("'not this' removes a product from an item and recalculates", async ({ page }) => {
  const pickle = { ...PRODUCT, barcode: "p:1", name: "מלפפון בחומץ", is_weighted: true, quantity: 1, unit_of_measure: "קילוגרם", min_price: 30 };
  const magi = { ...PRODUCT, barcode: "m:1", name: "מלפפון בייבי", is_weighted: true, quantity: 1, unit_of_measure: "קילוגרם", min_price: 9 };
  const plain = { ...PRODUCT, barcode: "c:1", name: "מלפפון", is_weighted: true, quantity: 1, unit_of_measure: "קילוגרם", min_price: 4.9 };
  let saved: Record<string, unknown> | null = null;
  const payloads: string[] = [];
  await mockSupabase(page, (r, url, body) => {
    if (url.includes("rpc/search_products")) return r.fulfill({ json: [] });
    if (url.includes("rpc/search_weighed")) return r.fulfill({ json: [pickle, magi, plain] });
    if (url.includes("term_settings") && r.request().method() === "POST") saved = JSON.parse(body);
    if (url.includes("term_settings") && r.request().method() === "GET") return r.fulfill({ json: saved ? [saved] : [] });
    if (url.includes("rpc/price_basket")) payloads.push(body);
    if (url.includes("shopping_lists")) return r.fulfill({ json: [{ id: 1, items: { text: "מלפפונים" } }] });
    return listHandler(r, url, body);
  });
  await page.goto("./");
  await page.getByRole("button", { name: "איפה הכי זול?" }).click();
  await expect.poll(() => payloads.length).toBe(1);
  expect(JSON.parse(payloads[0]).items[0].candidates).toEqual(["m:1", "c:1"]); // pickles left out
  await page.getByRole("button", { name: /שינוי/ }).click();
  await page.getByRole("button", { name: /מה נחשב/ }).click();
  await page.getByRole("button", { name: "לא מתאים: מלפפון בייבי" }).click();
  await page.getByRole("button", { name: "סיום" }).click();
  await expect(page.locator(".toast")).toContainText("עודכן");
  expect(saved).toMatchObject({ term: "מלפפונים", excluded: ["מלפפונ בייבי"] });
  expect(JSON.parse(payloads[1]).items[0].candidates).toEqual(["c:1"]);
});

test("the item sheet shows what is in the basket and lists every match", async ({ page }) => {
  const lettuces = Array.from({ length: 14 }, (_, i) => ({ ...PRODUCT, barcode: `l${i}`, name: `חסה סוג ${i}`, min_price: 3 + i, quantity: null }));
  await mockSupabase(page, (r, url, body) => {
    if (url.includes("rpc/search_products")) return r.fulfill({ json: lettuces });
    if (url.includes("rpc/price_basket"))
      return r.fulfill({ json: [{ ...ROWS[0], lines: [{ key: "חסה", qty: 1, barcode: "l13", name: "חסה סוג 13", price: 7.9, total: 7.9, promo: null, promo_min_qty: null, preferred: true }] }] });
    if (url.includes("shopping_lists")) return r.fulfill({ json: [{ id: 1, items: { text: "חסה" } }] });
    return listHandler(r, url, body);
  });
  await page.goto("./");
  await page.getByRole("button", { name: "איפה הכי זול?" }).click();
  const item = page.locator(".item", { hasText: "חסה" });
  await expect(item).toContainText("בסל: חסה סוג 13");
  await item.getByRole("button", { name: /שינוי/ }).click();
  const sheet = page.getByRole("dialog");
  await expect(sheet.locator(".result")).toContainText("בסל: חסה סוג 13");
  await sheet.getByRole("button", { name: /מה נחשב/ }).click();
  await expect(sheet.locator(".matches > div")).toHaveCount(14);
});

test("list editor: add with suggestions, change quantity, remove, edit as text", async ({ page }) => {
  const saved: string[] = [];
  await mockSupabase(page, (r, url, body) => {
    if (url.includes("shopping_lists") && r.request().method() !== "GET") saved.push(body);
    if (url.includes("rpc/search_products")) return r.fulfill({ json: [{ ...PRODUCT, name: "קוטג' 5% תנובה" }] });
    if (url.includes("shopping_lists")) return r.fulfill({ json: [{ id: 1, items: { text: "חלב" } }] });
    return listHandler(r, url, body);
  });
  await page.goto("./");
  const add = page.getByRole("textbox", { name: "הוספת מוצר" });
  await add.fill("קוט");
  await page.getByRole("option", { name: /קוטג' 5% תנובה/ }).click();
  await expect(page.locator(".list-row")).toHaveCount(2);
  await add.fill("עגבניות");
  await add.press("Enter");
  await expect(page.locator(".list-row").nth(2)).toContainText("עגבניות");
  await expect(page.locator(".list-row").nth(2).locator(".row-icon")).toHaveText("🥬");
  // produce is bought by weight: 1 ק"ג by default, +/- in half kilos
  const tomatoes = page.locator(".list-row").nth(2);
  await expect(tomatoes.locator(".qty")).toHaveText('1 ק"ג');
  await page.getByRole("button", { name: "עוד עגבניות" }).click();
  await expect(tomatoes.locator(".qty")).toHaveText('1.5 ק"ג');
  // ...or switch to pieces
  await page.getByRole("button", { name: "לקנות עגבניות ביחידות" }).click();
  await expect(tomatoes.locator(".qty")).toHaveText("10");
  await expect(tomatoes).toContainText("≈1.5 ק\"ג");
  await page.getByRole("button", { name: "פחות חלב" }).click(); // qty 1 -> removes
  await expect(page.locator(".list-row")).toHaveCount(2);
  await expect(page.locator(".list-row").first()).toContainText("יח'");
  await page.getByRole("button", { name: /עריכה כטקסט/ }).click();
  await expect(page.locator("textarea")).toHaveValue("קוטג' 5% תנובה\nעגבניות 10 יח'");
  await expect.poll(() => saved.at(-1) ?? "").toContain("עגבניות 10 יח'");
});

test("quick comparison table highlights the cheapest price per item", async ({ page }) => {
  await mockSupabase(page, (r, url, body) => {
    if (url.includes("rpc/price_basket")) return r.fulfill({ json: [...ROWS, { ...ROWS[1], branch_id: 9, branch_name: "שלי רמלה" }] });
    return listHandler(r, url, body);
  });
  await page.goto("./");
  await page.getByRole("button", { name: "איפה הכי זול?" }).click();
  await page.getByRole("button", { name: /השוואה מהירה/ }).click();
  const table = page.locator("table.cmp");
  await expect(table.locator("thead th")).toHaveCount(4);
  const cottageRow = table.locator("tbody tr", { hasText: "קוטג" });
  await expect(cottageRow.locator("td.cmp-min")).toHaveText(["₪9.20", "₪9.20"]);
  await expect(table.locator("tfoot td").first()).toHaveText("₪24.40");
});

test("online stores can be left out of the comparison", async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem("basket-settings", JSON.stringify({ includeOnline: false })));
  await mockSupabase(page, (r, url, body) => {
    if (url.includes("rpc/price_basket"))
      return r.fulfill({ json: [...ROWS, { ...ROWS[0], branch_id: 7, chain_name: "שופרסל", is_online: true, lines: ROWS[0].lines.map((l) => ({ ...l, total: 1 })) }] });
    return listHandler(r, url, body);
  });
  await page.goto("./");
  await page.getByRole("button", { name: "איפה הכי זול?" }).click();
  await expect(page.locator(".best")).toContainText("רמי לוי");
  await expect(page.locator("body")).not.toContainText("אונליין");
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

test("list editor: a late search reply doesn't reopen suggestions after adding", async ({ page }) => {
  await mockSupabase(page, async (r, url, body) => {
    if (url.includes("rpc/search_products")) {
      await new Promise((res) => setTimeout(res, 600)); // slower than typing on
      return r.fulfill({ json: [{ ...PRODUCT, name: `${JSON.parse(body).term} ירוקים` }] });
    }
    return listHandler(r, url, body);
  });
  await page.goto("./");
  const add = page.getByRole("textbox", { name: "הוספת מוצר" });
  await add.pressSequentially("ענב", { delay: 50 });
  await page.waitForTimeout(300); // the "ענב" search is now in flight
  await add.pressSequentially("ים", { delay: 50 });
  await add.press("Enter");
  await expect(page.locator(".list-row").last()).toContainText("ענבים");
  await page.waitForTimeout(1200); // both replies have arrived
  await expect(page.getByRole("listbox", { name: "הצעות" })).toHaveCount(0);
});

test("deli items the app doesn't know come in grams; a pack can win per gram", async ({ page }) => {
  const deli = { ...PRODUCT, barcode: "a:1", name: "גאודה עיזים", is_weighted: true, quantity: null, unit_of_measure: null };
  const triangle = { ...PRODUCT, barcode: "7290000000777", name: "משולש גאודה עיזים 160 גרם", quantity: 160 };
  let payload = "";
  await mockSupabase(page, (r, url, body) => {
    if (url.includes("rpc/term_kinds"))
      return r.fulfill({ json: JSON.parse(body).terms.map((term: string) => ({ term, weighed_start: term === "גאודה עיזים" ? 19 : 0, packed_start: 3, weighed_all: 27, packed_all: 7 })) });
    if (url.includes("rpc/search_weighed")) return r.fulfill({ json: [deli] });
    if (url.includes("rpc/search_products")) return r.fulfill({ json: [triangle] });
    if (url.includes("shopping_lists")) return r.fulfill({ json: [{ id: 1, items: { text: "גאודה עיזים" } }] });
    if (url.includes("rpc/price_basket")) {
      payload = body;
      return r.fulfill({ json: [{ ...ROWS[0], lines: [{ key: "גאודה עיזים", qty: 1, barcode: triangle.barcode, name: triangle.name, price: 20.9, total: 20.9, promo: null, promo_min_qty: null, preferred: true }] }] });
    }
    return listHandler(r, url, body);
  });
  await page.goto("./");
  const row = page.locator(".list-row").first();
  await expect(row.locator(".qty")).toHaveText("200 גרם");
  await page.getByRole("button", { name: "עוד גאודה עיזים" }).click();
  await expect(row.locator(".qty")).toHaveText("300 גרם");
  await page.getByRole("button", { name: "פחות גאודה עיזים" }).click();
  await page.getByRole("button", { name: "איפה הכי זול?" }).click();
  await expect(page.locator(".best .shoplist li").first()).toContainText("1 יח'"); // the pack, not "1 ק\"ג"
  const item = JSON.parse(payload).items[0];
  expect(item.qty).toBe(0.2);
  expect(item.candidates.sort()).toEqual(["7290000000777", "a:1"]);
});

test("equal prices: the store nearer home comes first, with its distance", async ({ page }) => {
  const lines = ROWS[0].lines;
  const far = { ...ROWS[0], branch_id: 1, chain_name: "אושר עד", branch_name: "תלפיות", city: "ירושלים", lat: 31.75, lon: 35.21 };
  const near = { ...ROWS[0], branch_id: 2, chain_name: "רמי לוי", branch_name: "מישור אדומים", city: "מעלה אדומים", lat: 31.802, lon: 35.253, lines };
  await mockSupabase(page, (r, url, body) => {
    if (url.includes("rpc/price_basket")) return r.fulfill({ json: [far, near] });
    if (url.includes("user_profile")) return r.fulfill({ json: { home_lat: 31.8, home_lon: 35.25 } });
    if (url.includes("geo_exact")) return r.fulfill({ json: [{ id: 2 }] });
    return listHandler(r, url, body);
  });
  await page.goto("./");
  await page.getByRole("button", { name: "איפה הכי זול?" }).click();
  await expect(page.locator(".best h2")).toContainText("רמי לוי");
  await expect(page.locator(".best .nav-link")).toContainText('0.4 ק"מ');
  const other = page.locator(".stores details").first();
  await expect(other).toContainText("אותו מחיר");
  await expect(other).toContainText('≈'); // Talpiot is placed by its town only
});

test("the comparison is for the area I'm shopping in: nearest home by default, switchable", async ({ page }) => {
  const lines = ROWS[0].lines;
  const lod = { ...ROWS[0], branch_id: 1, chain_name: "שופרסל", branch_name: "לוד", city: "לוד", lat: 31.95, lon: 34.89, lines: lines.map((l) => ({ ...l, total: l.total - 5 })) };
  const ma = { ...ROWS[0], branch_id: 2, chain_name: "רמי לוי", branch_name: "מישור אדומים", city: "מעלה אדומים", lat: 31.802, lon: 35.253, lines };
  await mockSupabase(page, (r, url, body) => {
    if (url.includes("rpc/price_basket")) return r.fulfill({ json: [lod, ma] });
    if (url.includes("user_areas")) return r.fulfill({ json: [
      { id: 5, label: "רמלה", city: "רמלה", lat: 31.928, lon: 34.862, radius_km: 5 },
      { id: 4, label: "מעלה אדומים", city: "מעלה אדומים", lat: 31.776, lon: 35.302, radius_km: 10 },
    ] });
    if (url.includes("user_profile")) return r.fulfill({ json: { home_lat: 31.771, home_lon: 35.298 } });
    return listHandler(r, url, body);
  });
  await page.goto("./");
  const where = page.getByRole("group", { name: "קונה עכשיו ב:" });
  await expect(where.getByRole("button", { name: "מעלה אדומים" })).toHaveAttribute("aria-pressed", "true");
  await page.getByRole("button", { name: "איפה הכי זול?" }).click();
  await expect(page.locator(".best h2")).toContainText("רמי לוי");
  await expect(page.getByText("לוד")).toHaveCount(0);
  await where.getByRole("button", { name: "כל האזורים" }).click();
  await expect(page.locator(".best h2")).toContainText("שופרסל");
  await where.getByRole("button", { name: "רמלה" }).click();
  await expect(page.locator(".best h2")).toContainText("שופרסל");
  await expect(page.getByText("מישור אדומים")).toHaveCount(0);
  await page.reload();
  await expect(page.getByRole("group", { name: "קונה עכשיו ב:" }).getByRole("button", { name: "רמלה" })).toHaveAttribute("aria-pressed", "true");
});

test("receipts: discount lines, starring the preferred, and a check against the price files", async ({ page }) => {
  const items: Record<string, unknown>[] = [];
  await mockSupabase(page, (r, url, body) => {
    const m = r.request().method();
    if (url.includes("branches")) return r.fulfill({ json: [{ id: 7, name: "דיל קניון מעלה אדומים", city: "מעלה אדומים", chains: { name: "שופרסל" } }] });
    if (url.includes("/rest/v1/receipts") && m === "POST") return r.fulfill({ json: { id: 42 } });
    if (url.includes("/rest/v1/receipts"))
      return r.fulfill({ json: items.length ? [{ id: 42, purchased_at: "2026-10-18", total: 73.9, branch_id: 7, receipt_items: [{ count: 2 }] }] : [] });
    if (url.includes("/rest/v1/receipt_items") && m === "POST") {
      items.push(...JSON.parse(body));
      return r.fulfill({ json: [] });
    }
    if (url.includes("/rest/v1/receipt_items")) return r.fulfill({ json: [{ id: 1, reason: "preferred" }, { id: 2, reason: "deal" }] });
    if (url.includes("rpc/resolve_receipt")) return r.fulfill({ json: 2 });
    if (url.includes("rpc/receipt_deal_prices")) return r.fulfill({ json: [{ item_id: 2, deal_total: 35, deal: "2ב35" }] });
    if (url.includes("rpc/receipt_check"))
      return r.fulfill({ json: [
        { item_id: 1, raw_name: "12 ביצי משק טריות", barcode: "7290001201589", db_name: "12 ביצי משק טריות L לסר", quantity: 1, paid: 14.24, discount: null, db_price: 14.24, is_weighted: false, db_promo: null },
        { item_id: 2, raw_name: "שוק. מריר לינדט 1 90%", barcode: "3046920029759", db_name: "שוק.מריר לינדט 90% 100ג", quantity: 2, paid: 45.8, discount: 10.8, db_price: 22.9, is_weighted: false, db_promo: "2ב35 שוקולד אקסלנס 50-100 גרם" },
      ] });
    return r.fulfill({ json: [] });
  });
  await page.goto("./");
  await page.getByRole("button", { name: /קבלות/ }).click();
  await page.getByRole("combobox", { name: "סניף הקנייה" }).selectOption("7");
  await page.locator("textarea").fill(
    "תאריך,מוצר,ברקוד,כמות,מחיר\n18/10/2026,12 ביצי משק טריות,1201589,1,14.24\n18/10/2026,שוק. מריר לינדט 1 90%,3046920029759,2,45.80\n18/10/2026,שוקולד אקסלנט 50-100 גרם,3512,1,-10.80",
  );
  await expect(page.locator(".tbl.preview tbody tr")).toHaveCount(2);
  await expect(page.locator(".tbl.preview")).toContainText("−₪10.80");
  // nothing is starred until you say so
  const star = page.getByRole("button", { name: /מוצר מועדף: שוק/ });
  await expect(star).toHaveAttribute("aria-pressed", "false");
  await star.click();
  await expect(star).toHaveAttribute("aria-pressed", "true");
  await page.getByRole("button", { name: /שמירת קבלה \(2/ }).click();
  await expect(page.locator(".receipt-check")).toContainText("2/2 שורות תואמות");
  await expect(page.locator(".receipt-check")).toContainText("המבצע מופיע במאגר");
  expect(items[1]).toMatchObject({ raw_code: "3046920029759", discount: 10.8, reason: "preferred" });
  expect(items[0]).toMatchObject({ raw_code: "1201589", reason: "other" });
  // the saved receipt opens from the list
  const saved = page.locator(".receipt-row").first();
  await expect(saved).toContainText("שופרסל דיל קניון מעלה אדומים");
  await saved.getByRole("button", { name: /📄/ }).click();
  await expect(page.locator(".receipt-check")).toHaveCount(0);
  await saved.getByRole("button", { name: /📄/ }).click();
  await expect(saved.locator(".receipt-check")).toContainText("12 ביצי משק טריות");
});

test("receipts: the store column picks the branch", async ({ page }) => {
  await mockSupabase(page, (r, url) => {
    if (url.includes("/rest/v1/branches"))
      return r.fulfill({ json: [
        { id: 7, name: "דיל קניון מעלה אדומים", city: "מעלה אדומים", address: "דרך קדם 5", chains: { name: "שופרסל" } },
        { id: 8, name: "BE מעלה אדומים", city: "מעלה אדומים", address: "הרכס 31", chains: { name: "שופרסל" } },
      ] });
    return r.fulfill({ json: [] });
  });
  await page.goto("./");
  await page.getByRole("button", { name: /קבלות/ }).click();
  await expect(page.getByRole("combobox", { name: "סניף הקנייה" }).locator("option")).toHaveCount(3);
  await page.locator("textarea").fill("תאריך,סניף,מוצר,כמות,מחיר\n18/10/2026,שופרסל דיל קניון מעלה אדומים,מלפפון,0.39,2.69");
  await expect(page.getByRole("combobox", { name: "סניף הקנייה" })).toHaveValue("7");
});

test("a starred purchase joins its list term by its shelf name, marked as preferred", async ({ page }) => {
  const mozza = { ...PRODUCT, barcode: "3560071005214", name: "שוקולד מריר 90% מוצץ", min_price: 9.9, max_price: 9.9, quantity: 80 };
  const lindt = { ...PRODUCT, barcode: "3046920029759", name: "שוקולד לינדט אקסלנס", min_price: 22.9, max_price: 22.9, quantity: 100 };
  let payload = "";
  await mockSupabase(page, (r, url, body) => {
    if (url.includes("rpc/search_products")) return r.fulfill({ json: [mozza] });
    if (url.includes("rpc/bought_products")) return r.fulfill({ json: [lindt] });
    if (url.includes("rpc/bought_product_names")) return r.fulfill({ json: [{ barcode: lindt.barcode, item_name: "שוק.מריר לינדט 90% 100ג" }] });
    if (url.includes("purchase_history")) return r.fulfill({ json: [{ barcode: lindt.barcode, times_bought: 1 }] });
    if (url.includes("shopping_lists")) return r.fulfill({ json: [{ id: 1, items: { text: "שוקולד מריר 90%" } }] });
    if (url.includes("rpc/price_basket")) {
      payload = body;
      return r.fulfill({ json: [{ ...ROWS[0], lines: [{ key: "שוקולד מריר 90%", qty: 1, barcode: mozza.barcode, name: mozza.name, price: 9.9, total: 9.9, promo: null, promo_min_qty: null, preferred: false }] }] });
    }
    return listHandler(r, url, body);
  });
  await page.goto("./");
  await page.getByRole("button", { name: "איפה הכי זול?" }).click();
  await expect(page.locator(".item")).toContainText("כמו בקבלות: שוק.מריר לינדט 90% 100ג");
  expect(JSON.parse(payload).items[0].preferred).toEqual([lindt.barcode]);
  await page.getByRole("button", { name: /שינוי/ }).click();
  const sheet = page.getByRole("dialog");
  await expect(sheet.getByRole("radio", { name: /מוצר מסוים/ })).toHaveAttribute("aria-checked", "true");
  await expect(sheet).toContainText("לפי הקבלות שלך");
  await expect(sheet.getByRole("button", { name: /שוק.מריר לינדט/ })).toHaveAttribute("aria-pressed", "true");
});

test("part of the basket from החישוק, when it saves", async ({ page }) => {
  const hh = { branch_id: 99, chain_id: "hahishook", chain_name: "החישוק", branch_name: "משלוח עד הבית", city: null, address: null, is_online: true, lat: null, lon: null,
    lines: [
      { key: "לחם", qty: 1, barcode: "hahishook:1", name: "לחם מחמצת", price: 3, total: 3, promo: null, promo_min_qty: null, preferred: true },
      { key: "קוטג", qty: 1, barcode: "hahishook:2", name: "קוטג 5%", price: 2, total: 2, promo: null, promo_min_qty: null, preferred: true },
    ] };
  await mockSupabase(page, (r, url, body) => {
    if (url.includes("rpc/price_basket")) return r.fulfill({ json: [...ROWS, hh] });
    return listHandler(r, url, body);
  });
  await page.goto("./");
  await page.getByRole("button", { name: "איפה הכי זול?" }).click();
  const card = page.locator(".hahishook");
  await expect(card).toContainText("2 מוצרים מהחישוק");
  await expect(card).toContainText("₪7.00 לנקודת איסוף");
  await expect(page.locator(".best h2")).not.toContainText("החישוק"); // never the whole basket
  const box = card.locator("details");
  await box.locator("summary").click();
  await expect(box).toHaveAttribute("open", "");
  await box.getByRole("button", { name: /סגירה/ }).click();
  await expect(box).not.toHaveAttribute("open", "");
});

test("one clear name everywhere; the store's own name only on the shopping list", async ({ page }) => {
  const fusilli = { ...PRODUCT, barcode: "7290000060248", name: "פסטה תלתלים אסם 500", min_price: 4.9, quantity: 500 };
  const penne = { ...PRODUCT, barcode: "2", name: "פסטה פנה ברילה 500", min_price: 6.8, quantity: 500 };
  await mockSupabase(page, (r, url, body) => {
    if (url.includes("rpc/search_products")) return r.fulfill({ json: [penne, fusilli] });
    if (url.includes("rpc/price_basket"))
      return r.fulfill({ json: [{ ...ROWS[0], lines: [{ key: "פסטה", qty: 1, barcode: fusilli.barcode, name: "אטריות אסם תלתלים 50", price: 4.9, total: 4.9, promo: null, promo_min_qty: null, preferred: true }] }] });
    if (url.includes("shopping_lists")) return r.fulfill({ json: [{ id: 1, items: { text: "פסטה" } }] });
    return listHandler(r, url, body);
  });
  await page.goto("./");
  await page.getByRole("button", { name: "איפה הכי זול?" }).click();
  await expect(page.locator(".item")).toContainText("בסל: פסטה תלתלים אסם 500");
  // the shopping list: the product's clear name, and the store's own name to find it
  await expect(page.locator(".best .shoplist")).toContainText("פסטה תלתלים אסם 500");
  await expect(page.locator(".best .shoplist")).toContainText("במדף: אטריות אסם תלתלים 50");
  await page.getByRole("button", { name: /שינוי/ }).click();
  await page.getByRole("button", { name: /מה נחשב/ }).click();
  const first = page.locator(".sheet .matches > div").first();
  await expect(first).toContainText("פסטה תלתלים אסם 500");
  await expect(first).toContainText("בסל");
  await expect(first).not.toContainText("אטריות");
});
