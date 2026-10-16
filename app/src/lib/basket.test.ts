import { describe, expect, it } from "vitest";
import { bestSplits, parseList, parseReceiptCsv, rankStores, resolveItem, type BranchRow, type Product } from "./basket";

const prod = (barcode: string, q: number | null, u: string | null, branches = 5): Product => ({
  barcode, name: barcode, manufacturer: null, quantity: q, unit_of_measure: u, is_weighted: false, branches, min_price: 1, max_price: 2,
});

const line = (key: string, total: number) => ({ key, qty: 1, barcode: key, name: key, price: total, total, promo: null, promo_min_qty: null, preferred: true });
const branch = (id: number, lines: ReturnType<typeof line>[], online = false): BranchRow => ({
  branch_id: id, chain_id: "c", chain_name: "c", branch_name: `b${id}`, city: null, address: null, is_online: online, lat: null, lon: null, lines,
});

describe("parseList", () => {
  it("parses quantities without eating product attributes", () => {
    expect(parseList("2 קוטג\nחלב 3%\nלחם x3\n- ביצים\nחלב 3%")).toEqual([
      { key: "קוטג", qty: 2 },
      { key: "חלב 3%", qty: 2 },
      { key: "לחם", qty: 3 },
      { key: "ביצים", qty: 1 },
    ]);
  });
});

describe("resolveItem", () => {
  it("prefers bought products and keeps only similar sizes", () => {
    const results = [prod("a", 250, "גרם"), prod("b", 0.25, "ק\"ג"), prod("c", 750, "גרם"), prod("d", 250, "גרם")];
    const r = resolveItem({ key: "x", qty: 1 }, results, [], new Map([["d", 3]]));
    expect(r.preferred).toEqual(["d"]);
    expect(r.candidates.map((c) => c.barcode)).toEqual(["a", "b", "d"]);
  });
  it("pinned beats history", () => {
    const results = [prod("a", 1, "ליטר"), prod("b", 1, "ליטר")];
    expect(resolveItem({ key: "x", qty: 1 }, results, ["b"], new Map([["a", 9]])).preferred).toEqual(["b"]);
  });
});

describe("ranking and splits", () => {
  const rows = [
    branch(1, [line("x", 10), line("y", 10)]),
    branch(2, [line("x", 5), line("y", 20)]),
    branch(3, [line("x", 20), line("y", 4)]),
    branch(4, [line("x", 1)]),
    branch(5, [line("x", 8), line("y", 8)], true),
  ];
  it("ranks complete baskets first, adds delivery fee", () => {
    const r = rankStores(rows, ["x", "y"], { deliveryFee: 10 });
    expect(r.map((o) => o.branch.branch_id)).toEqual([1, 3, 2, 5, 4]);
    expect(r[3].total).toBe(26);
  });
  it("finds a profitable split", () => {
    const ranked = rankStores(rows, ["x", "y"], { deliveryFee: 10 });
    const s = bestSplits(rows, ["x", "y"], ranked[0], { minSaving: 5, deliveryFee: 10 });
    expect(s[0].total).toBe(5);
    expect(s[0].saving).toBe(15);
  });
});

describe("parseReceiptCsv", () => {
  it("reads hebrew headers", () => {
    const rows = parseReceiptCsv('תאריך,מוצר,ברקוד,כמות,מחיר\n2026-10-01,"קוטג תנובה, 5%",7290000000001,2,11.80\n');
    expect(rows).toEqual([{ date: "2026-10-01", store: null, name: "קוטג תנובה, 5%", barcode: "7290000000001", qty: 2, price: 11.8 }]);
  });
});

describe("normDate", () => {
  it("handles common formats", async () => {
    const { normDate } = await import("./basket");
    expect(normDate("15/10/2026")).toBe("2026-10-15");
    expect(normDate("5.3.26")).toBe("2026-03-05");
    expect(normDate("2026-10-15")).toBe("2026-10-15");
    expect(normDate("אתמול")).toBe(null);
  });
});

describe("edge cases", () => {
  it("ignores blank lines and bullets", () => {
    expect(parseList("\n\n  - \n•  חלב\n")).toEqual([{ key: "חלב", qty: 1 }]);
  });
  it("item with no products resolves to no candidates", () => {
    const r = resolveItem({ key: "x", qty: 1 }, [], ["a"], new Map());
    expect(r.candidates).toEqual([]);
    expect(r.reference).toBeNull();
  });
  it("no store data gives no ranking and no splits", () => {
    const ranked = rankStores([], ["x"], { deliveryFee: 30 });
    expect(ranked).toEqual([]);
    expect(bestSplits([], ["x"], ranked[0], { minSaving: 0, deliveryFee: 30 })).toEqual([]);
  });
  it("a store with no lines is not ranked", () => {
    expect(rankStores([branch(1, [])], ["x"], { deliveryFee: 0 })).toEqual([]);
  });
  it("splits never use online stores", () => {
    const rows = [branch(1, [line("x", 1), line("y", 50)]), branch(2, [line("x", 50), line("y", 1)], true)];
    const ranked = rankStores(rows, ["x", "y"], { deliveryFee: 0 });
    expect(bestSplits(rows, ["x", "y"], ranked[0], { minSaving: 0, deliveryFee: 0 })).toEqual([]);
  });
  it("receipt CSV without a name column explains the problem", () => {
    expect(() => parseReceiptCsv("a,b\n1,2")).toThrow(/מוצר/);
  });
  it("receipt CSV accepts tabs (pasted from a spreadsheet)", () => {
    expect(parseReceiptCsv("מוצר\tכמות\nחלב\t2")[0]).toMatchObject({ name: "חלב", qty: 2 });
  });
});

describe("weighed goods", () => {
  const w = (barcode: string): Product => ({ ...prod(barcode, 1, "קילוגרם"), is_weighted: true });
  it("parses weights anywhere in the line", () => {
    expect(parseList("בשר טחון 500 גרם\n1.5 ק\"ג עגבניות\nגבינה צהובה 300ג'\nקוטג 5%")).toEqual([
      { key: "בשר טחון", qty: 1, weightKg: 0.5 },
      { key: "עגבניות", qty: 1, weightKg: 1.5 },
      { key: "גבינה צהובה", qty: 1, weightKg: 0.3 },
      { key: "קוטג 5%", qty: 1 },
    ]);
  });
  it("'מהקצביה' means sold by weight", () => {
    expect(parseList("בשר טחון מהקצביה 500 גרם")).toEqual([{ key: "בשר טחון", qty: 1, weightKg: 0.5, byWeight: true }]);
  });
  it("prices weighed products per kg and compares them across chains", () => {
    const results = [prod("frozen", 400, "גרם", 9), w("chainA:12"), w("chainB:77")];
    const r = resolveItem({ key: "בשר טחון", qty: 1, weightKg: 0.5, byWeight: true }, results, [], new Map());
    expect(r.weighted).toBe(true);
    expect(r.qty).toBe(0.5);
    expect(r.candidates.map((c) => c.barcode)).toEqual(["chainA:12", "chainB:77"]);
  });
  it("butcher items default to by-weight, 0.5kg", () => {
    const results = [prod("frozen", 500, "גרם", 9), w("chainA:12")];
    const r = resolveItem({ key: "בשר טחון", qty: 1 }, results, [], new Map());
    expect([r.weighted, r.qty, r.reference?.barcode]).toEqual([true, 0.5, "chainA:12"]);
  });
  it("deli cheese defaults to 200g", () => {
    expect(resolveItem({ key: "גבינה צהובה", qty: 1 }, [prod("pack", 200, "גרם"), w("d:1")], [], new Map()).qty).toBe(0.2);
  });
  it("the user's explicit choice wins over hints", () => {
    const r = resolveItem({ key: "בשר טחון", qty: 1 }, [prod("frozen", 500, "גרם"), w("c:1")], [], new Map(), { mode: "pack" });
    expect([r.weighted, r.reference?.barcode]).toEqual([false, "frozen"]);
    expect(resolveItem({ key: "בשר טחון", qty: 1 }, [w("c:1")], [], new Map(), { weightKg: 1.2 }).qty).toBe(1.2);
  });
  it("receipts decide when there is no explicit choice", () => {
    const r = resolveItem({ key: "גבינה צהובה", qty: 1 }, [prod("pack", 200, "גרם"), w("d:1")], [], new Map([["pack", 3]]));
    expect(r.weighted).toBe(false);
  });
  it("unknown terms follow the shelf", () => {
    const shelf = [{ ...w("a"), name: "קשקבל" }, { ...w("b"), name: "קשקבל צאן" }, { ...prod("c", 200, "גרם"), name: "קשקבל ארוז" }];
    expect(resolveItem({ key: "קשקבל", qty: 1 }, shelf, [], new Map()).weighted).toBe(true);
    expect(resolveItem({ key: "קוטג", qty: 1 }, [prod("c", 250, "גרם")], [], new Map()).weighted).toBe(false);
  });
  it("hint without weighed products on the shelf stays packaged", () => {
    expect(resolveItem({ key: "עגבניות שרי", qty: 1 }, [prod("box", 250, "גרם")], [], new Map()).weighted).toBe(false);
  });
  it("weighed item without a weight defaults to 1kg", () => {
    expect(resolveItem({ key: "עגבניות", qty: 1 }, [w("a")], [], new Map()).qty).toBe(1);
  });
  it("a weight on a packaged product picks that pack size", () => {
    const results = [prod("500g", 500, "גרם"), prod("250g", 250, "גרם")];
    const r = resolveItem({ key: "קוטג", qty: 2, weightKg: 0.25 }, results, [], new Map());
    expect(r.weighted).toBe(false);
    expect(r.qty).toBe(2);
    expect(r.candidates.map((c) => c.barcode)).toEqual(["250g"]);
  });
  it("strict pin allows no substitutes", () => {
    const results = [prod("a", 250, "גרם"), prod("b", 250, "גרם")];
    expect(resolveItem({ key: "x", qty: 1 }, results, ["b"], new Map(), { strict: true }).candidates.map((c) => c.barcode)).toEqual(["b"]);
    expect(resolveItem({ key: "x", qty: 1 }, results, ["b"], new Map(), { strict: false }).candidates).toHaveLength(2);
  });
});
