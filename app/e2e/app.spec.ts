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
  await page.locator(".item").first().getByRole("button", { name: "שינוי" }).click();
  await page.locator(".item select").first().selectOption(PRODUCT.barcode);
  await expect(page.locator(".toast")).toContainText("הכי משתלם עכשיו");
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
  await page.getByRole("button", { name: "שינוי" }).click();
  await expect(page.getByRole("button", { name: /במשקל/ })).toHaveClass(/on/);
  await page.getByRole("button", { name: /📦 ארוז/ }).click();
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
  await meatItem.getByRole("button", { name: "שינוי" }).click();
  await expect(meatItem.locator(".grams input")).toHaveValue("500");
  const milkItem = page.locator(".item", { hasText: "חלב 3%" });
  await expect(milkItem).toContainText("📦 1 יח'");
  await milkItem.getByRole("button", { name: "שינוי" }).click();
  await expect(milkItem.locator(".seg")).toHaveCount(0);
  expect(weighedTerms).not.toContain("חלב"); // never relaxed to a single word
});

test("an explicit button recalculates the basket", async ({ page }) => {
  let baskets = 0;
  await mockSupabase(page, (r, url, body) => {
    if (url.includes("rpc/price_basket")) baskets++;
    return listHandler(r, url, body);
  });
  await page.goto("./");
  await page.getByRole("button", { name: "איפה הכי זול?" }).click();
  await expect(page.locator(".best")).toBeVisible();
  await page.getByRole("button", { name: /חשב שוב את הסל/ }).click();
  await expect(page.locator(".toast")).toContainText("הכי משתלם עכשיו: רמי לוי ₪24.40");
  expect(baskets).toBe(2);
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
  await page.getByRole("button", { name: "שינוי" }).click();
  await page.getByRole("button", { name: "לא מתאים: מלפפון בייבי" }).click();
  await expect(page.locator(".toast")).toContainText("לא ייחשב יותר");
  expect(saved).toMatchObject({ term: "מלפפונים", excluded: ["מלפפונ בייבי"] });
  expect(JSON.parse(payloads[1]).items[0].candidates).toEqual(["c:1"]);
});

test("the product in the recommended basket is always listed among the matches", async ({ page }) => {
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
  await item.getByRole("button", { name: "שינוי" }).click();
  await expect(item.locator(".matches li").first()).toContainText("חסה סוג 13");
  await expect(item.locator(".matches li").first()).toContainText("בסל המומלץ");
  await expect(item.locator(".matches li")).toHaveCount(8);
  await item.getByRole("button", { name: "הצגת כל 14" }).click();
  await expect(item.locator(".matches li")).toHaveCount(14);
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
