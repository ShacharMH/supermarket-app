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
