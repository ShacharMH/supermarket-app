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
    if (url.includes("rpc/search_products")) {
      const term = JSON.parse(body).term as string;
      terms.push(term);
      return r.fulfill({ json: term === "בשר טחון" ? [PRODUCT] : [] });
    }
    if (url.includes("shopping_lists")) return r.fulfill({ json: [{ id: 1, items: { text: "בשר טחון מהקצביה" } }] });
    return listHandler(r, url, body);
  });
  await page.goto("./");
  await page.getByRole("button", { name: "איפה הכי זול?" }).click();
  await expect(page.locator(".best")).toBeVisible();
  expect(terms).toEqual(["בשר טחון מהקצביה", "בשר טחון"]);
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
