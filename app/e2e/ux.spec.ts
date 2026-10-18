import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Page } from "@playwright/test";
import { listHandler, mockSupabase, PRODUCT, ROWS } from "./mock";

const LONG = "גבינה צהובה עמק פרוסה דקה 28% שומן במארז חיסכון משפחתי ענק 750 גרם מהדרין בד\"ץ";
const ITEMS = Array.from({ length: 30 }, (_, i) => `מוצר מספר ${i + 1}`);

/** A crowded result: 30 items, very long product and store names, many stores. */
async function crowded(page: Page) {
  const lines = ITEMS.map((key, i) => ({
    key, qty: i % 3 ? 1 : 2, barcode: `72900000${String(i).padStart(5, "0")}`, name: i % 2 ? LONG : key,
    price: 9.9, total: 19.8, promo: i % 4 ? null : "3 ב-25 למועדון בלבד עד סוף החודש", promo_min_qty: 3, preferred: i % 5 !== 0,
  }));
  const stores = Array.from({ length: 12 }, (_, i) => ({
    ...ROWS[0], branch_id: i + 1, chain_name: "אלמשהדאוי קינג סטור בע\"מ", branch_name: `סניף ואדי אלג'וז ${i}`,
    lines: lines.slice(0, 30 - i),
  }));
  await mockSupabase(page, (r, url, body) => {
    if (url.includes("rpc/price_basket")) return r.fulfill({ json: stores });
    if (url.includes("rpc/search_products")) return r.fulfill({ json: [{ ...PRODUCT, name: LONG }] });
    if (url.includes("shopping_lists")) return r.fulfill({ json: [{ id: 1, items: { text: ITEMS.join("\n") } }] });
    if (url.includes("chains")) return r.fulfill({ json: [{ chain_id: "a", name: "אלמשהדאוי קינג סטור בע\"מ" }, { chain_id: "b", name: "רמי לוי" }] });
    if (url.includes("user_areas")) return r.fulfill({ json: [{ id: 1, label: "מעלה אדומים", city: "מעלה אדומים", lat: 1, lon: 1, radius_km: 10 }] });
    return listHandler(r, url, body);
  });
}

/** No horizontal page scroll, and nothing visible sticks out past the screen edges. */
async function expectNoOverflow(page: Page, where: string) {
  const problems = await page.evaluate(() => {
    const vw = document.documentElement.clientWidth;
    const out: string[] = [];
    if (document.documentElement.scrollWidth > vw + 1) out.push(`page scrolls sideways (${document.documentElement.scrollWidth} > ${vw})`);
    for (const el of Array.from(document.querySelectorAll("body *"))) {
      const r = el.getBoundingClientRect();
      if (!r.width || !r.height) continue;
      if (r.right > vw + 1 || r.left < -1) out.push(`${el.tagName}.${(el as HTMLElement).className} "${(el.textContent ?? "").slice(0, 30)}" ${Math.round(r.left)}..${Math.round(r.right)}`);
    }
    return out.slice(0, 8);
  });
  expect(problems, where).toEqual([]);
}

for (const width of [320, 412]) {
  for (const scheme of ["light", "dark"] as const) {
    test(`layout fits at ${width}px (${scheme})`, async ({ page }) => {
      await page.setViewportSize({ width, height: 800 });
      await page.emulateMedia({ colorScheme: scheme });
      await crowded(page);
      await page.goto("./");
      await page.getByRole("button", { name: "איפה הכי זול?" }).click();
      await expect(page.locator(".best .shoplist li")).toHaveCount(30);
      await page.locator(".stores details").first().evaluate((d) => ((d as HTMLDetailsElement).open = true));
      await expectNoOverflow(page, "results");
      await page.locator(".item").nth(1).getByRole("button", { name: /שינוי/ }).click();
      await page.getByRole("radio", { name: /מוצר מסוים/ }).click();
      await page.getByRole("button", { name: /מה נחשב/ }).click();
      await expectNoOverflow(page, "item sheet");
      await page.getByRole("dialog").getByRole("button", { name: "סגירה" }).click();
      await page.getByRole("button", { name: /קבלות/ }).click();
      await page.getByText("מה למלא בכל עמודה").click();
      await page.locator("textarea").fill(`מוצר,כמות,מחיר\n${LONG},1,9.9`);
      await expectNoOverflow(page, "receipts");
      await page.getByRole("button", { name: /הגדרות/ }).click();
      await expect(page.getByText("מעלה אדומים")).toBeVisible();
      await expectNoOverflow(page, "settings");
    });
  }
}

test("accessibility: no serious problems on any screen", async ({ page }) => {
  await crowded(page);
  await page.goto("./");
  await page.getByRole("button", { name: "איפה הכי זול?" }).click();
  await expect(page.locator(".best")).toBeVisible();
  const report: string[] = [];
  const scan = async (screen: string) => {
    const r = await new AxeBuilder({ page }).analyze();
    for (const v of r.violations.filter((v) => v.impact === "serious" || v.impact === "critical"))
      report.push(`${screen}: ${v.id} (${v.nodes.length}) ${v.nodes[0]?.target.join(" ")}`);
  };
  await scan("list");
  await page.locator(".item").first().getByRole("button", { name: /שינוי/ }).click();
  await page.getByRole("radio", { name: /מוצר מסוים/ }).click();
  await scan("item sheet");
  await page.keyboard.press("Escape");
  await page.getByRole("button", { name: /קבלות/ }).click();
  await scan("receipts");
  await page.getByRole("button", { name: /הגדרות/ }).click();
  await expect(page.getByText("מעלה אדומים")).toBeVisible();
  await scan("settings");
  expect(report).toEqual([]);
});

test("offline: a clear message instead of a stuck screen", async ({ page }) => {
  await mockSupabase(page, (r, url, body) => {
    if (url.includes("rpc/")) return r.abort("internetdisconnected");
    return listHandler(r, url, body);
  });
  await page.goto("./");
  await page.getByRole("button", { name: "איפה הכי זול?" }).click();
  await expect(page.locator(".error")).toContainText("אין חיבור");
  await expect(page.getByRole("button", { name: "איפה הכי זול?" })).toBeEnabled();
});

test("double tap runs the comparison once", async ({ page }) => {
  let baskets = 0;
  await mockSupabase(page, async (r, url, body) => {
    if (url.includes("rpc/price_basket")) {
      baskets++;
      await new Promise((res) => setTimeout(res, 300));
    }
    return listHandler(r, url, body);
  });
  await page.goto("./");
  const btn = page.getByRole("button", { name: "איפה הכי זול?" });
  await btn.dblclick();
  await expect(page.locator(".best")).toBeVisible();
  expect(baskets).toBe(1);
});

test("the list is saved even when the app is closed right after typing", async ({ page }) => {
  const saved: string[] = [];
  await mockSupabase(page, (r, url, body) => {
    if (url.includes("shopping_lists") && r.request().method() !== "GET") saved.push(body);
    return listHandler(r, url, body);
  });
  await page.goto("./");
  await page.getByRole("button", { name: /עריכה כטקסט/ }).click();
  await page.locator("textarea").fill("קוטג\nביצים");
  await page.evaluate(() => window.dispatchEvent(new Event("pagehide")));
  await expect.poll(() => saved.length, { timeout: 500 }).toBeGreaterThan(0); // well before the 800ms debounce
  expect(saved.at(-1)).toContain("ביצים");
});

test("ticks in the shopping list survive a reload", async ({ page }) => {
  await mockSupabase(page, listHandler);
  await page.goto("./");
  await page.getByRole("button", { name: "איפה הכי זול?" }).click();
  await page.locator(".best .shoplist li input").first().check();
  await page.reload();
  await page.getByRole("button", { name: "איפה הכי זול?" }).click();
  await expect(page.locator(".best .shoplist li input").first()).toBeChecked();
});
