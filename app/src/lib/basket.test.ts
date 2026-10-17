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
      { key: "קוטג", qty: 2, raw: "2 קוטג" },
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
    const results = [prod("500g", 500, "גרם"), prod("250g", 250, "גרם"), prod("1kg", 1, "קג")];
    const r = resolveItem({ key: "קוטג", qty: 2, weightKg: 0.25 }, results, [], new Map());
    expect(r.weighted).toBe(false);
    expect(r.reference?.barcode).toBe("250g");
    expect(r.candidates.map((c) => c.barcode)).toEqual(["500g", "250g"]);
    expect(r.qtys).toEqual({ "500g": 2, "250g": 2 });
  });
  it("strict pin allows no substitutes", () => {
    const results = [prod("a", 250, "גרם"), prod("b", 250, "גרם")];
    expect(resolveItem({ key: "x", qty: 1 }, results, ["b"], new Map(), { strict: true }).candidates.map((c) => c.barcode)).toEqual(["b"]);
    expect(resolveItem({ key: "x", qty: 1 }, results, ["b"], new Map(), { strict: false }).candidates).toHaveLength(2);
  });
});

describe("shopping list", () => {
  it("formats a shareable list with amounts, sizes, promos and substitutes", async () => {
    const { shoppingText, shelfBarcode, packSize } = await import("./basket");
    const products = new Map([["7290000000001", { ...prod("7290000000001", 250, "גרם"), manufacturer: "תנובה" }]]);
    const lines = [
      { ...line("קוטג", 10), barcode: "7290000000001", name: "קוטג 5%", qty: 2, promo: "2 ב-10" },
      { ...line("בשר טחון", 32.45), barcode: "c:1", name: "בשר בקר טחון", qty: 0.5 },
      { ...line("חלב", 7), name: "חלב טרה", preferred: false },
    ];
    expect(shoppingText("רמי לוי · רמלה", lines, new Set(["בשר טחון"]), products)).toBe(
      [
        "🛒 רמי לוי · רמלה",
        "☐ 2 יח' · קוטג 5% · תנובה · 250 גרם - ₪10.00 (מבצע: 2 ב-10)",
        "☐ 500 גרם · בשר בקר טחון - ₪32.45",
        "☐ 1 יח' · חלב טרה - ₪7.00 (תחליף)",
        'סה"כ משוער: ₪49.45',
      ].join("\n"),
    );
    expect(shelfBarcode("c:1")).toBeNull();
    expect(packSize(prod("x", 1, "ליטר"))).toBe("1 ליטר");
  });
});

describe("pack sizes in the list", () => {
  it("reads volumes as a pack size", () => {
    expect(parseList("אקונומיקה 5 ליטר\nשמן 1.5 ל'\nמיץ 750 מ\"ל")).toEqual([
      { key: "אקונומיקה", qty: 1, volumeL: 5 },
      { key: "שמן", qty: 1, volumeL: 1.5 },
      { key: "מיץ", qty: 1, volumeL: 0.75 },
    ]);
  });
  it("picks the closest pack size and only similar sizes", () => {
    const results = [prod("small", 500, 'מ"ל', 20), prod("big4", 4, "ליטר"), prod("big5", 5000, "מל"), prod("1l", 1, "ליטר")];
    const r = resolveItem({ key: "אקונומיקה", qty: 1, volumeL: 5 }, results, [], new Map());
    expect(r.reference?.barcode).toBe("big5");
    expect(r.candidates.map((c) => c.barcode)).toEqual(["big4", "big5", "1l"]);
    expect(r.qtys).toEqual({ big4: 1, big5: 1, "1l": 5 });
  });
  it("falls back to the nearest size when the exact one is missing", () => {
    const r = resolveItem({ key: "אקונומיקה", qty: 1, volumeL: 5 }, [prod("small", 500, 'מ"ל'), prod("big4", 4, "ליטר")], [], new Map());
    expect(r.reference?.barcode).toBe("big4");
  });
});

describe("pack size from the product name", () => {
  const named = (barcode: string, name: string, q: number | null, u: string | null): Product => ({ ...prod(barcode, q, u), name });
  it("trusts the name over a wrong or missing unit", () => {
    const results = [
      named("touch", "אקונומיקה סמיכה בניחוח לימון 4 ל' טאצ'", 4000, "מיליליטר"),
      named("kings", "אקונומיקה ריחנית 4 ל' קינגז הום", 4000, "גרם"),
      named("plain", "אקונומיקה מבושמת 4 ל", 4000, "לא ידוע"),
      named("sano1", "סנו JAVEL אקונומיקה בריח לימון 1 ליט", 1000, 'מ"ל'),
      named("small", "סיף ג'ל אקונומיקה 750 מ\"ל", 750, 'מ"ל'),
    ];
    const r = resolveItem({ key: "אקונומיקה", qty: 1, volumeL: 5 }, results, [], new Map());
    expect(r.candidates.map((c) => c.barcode)).toEqual(["touch", "kings", "plain", "sano1"]);
    expect(r.qtys).toMatchObject({ touch: 1, sano1: 5 });
  });
  it("reads gram sizes glued to the number", () => {
    const results = [named("a", "קוטג' 5% 250ג'", 1, "יחידות"), named("b", "קוטג 5% 500 גרם", 500, "גרם")];
    expect(resolveItem({ key: "קוטג", qty: 1, weightKg: 0.25 }, results, [], new Map()).reference?.barcode).toBe("a");
  });
});

describe("quantities and sizes", () => {
  it("counts with units, and numbers that are part of a name", () => {
    expect(parseList("ביצים 2 חבילות\nקולה 6 בקבוקים\nנקה 7\n3 ב-1 שמפו\nבמבה 80\n5 קוטג\n7 אפ")).toEqual([
      { key: "ביצים", qty: 2 },
      { key: "קולה", qty: 6 },
      { key: "נקה 7", qty: 1 },
      { key: "3 ב-1 שמפו", qty: 1 },
      { key: "במבה 80", qty: 1 },
      { key: "קוטג", qty: 5, raw: "5 קוטג" },
      { key: "אפ", qty: 7, raw: "7 אפ" },
    ]);
  });
  it("buys enough packs to reach the requested size", () => {
    const results = [prod("4l", 4, "ליטר"), prod("1l", 1, "ליטר"), prod("2.5l", 2500, "מל"), prod("750", 750, "מל")];
    const r = resolveItem({ key: "אקונומיקה", qty: 1, volumeL: 5 }, results, [], new Map());
    expect(r.candidates.map((c) => c.barcode)).toEqual(["4l", "1l", "2.5l"]);
    expect(r.qtys).toEqual({ "4l": 1, "1l": 5, "2.5l": 2 });
  });
  it("compares similar packs per gram", () => {
    const r = resolveItem({ key: "קוטג", qty: 1 }, [prod("250", 250, "גרם"), prod("300", 300, "גרם")], [], new Map());
    expect(r.factors).toEqual({ "300": 0.833 });
  });
});

describe("promo hints", () => {
  it("suggests reaching a multi-buy deal", async () => {
    const { promoHint } = await import("./basket");
    const l = { ...line("קוטג", 6.5), price: 6.5, hint: "2 ב-10", hint_qty: 2, hint_unit: 5 };
    expect(promoHint(l)).toEqual({ text: 'מבצע "2 ב-10": עוד יחידה אחת ותשלמו ₪5.00 ליחידה במקום ₪6.50', saving: 3 });
    expect(promoHint({ ...l, hint_unit: 6.4 })).toBeNull(); // not worth mentioning
    expect(promoHint({ ...l, qty: 2 })).toBeNull();
  });
});

describe("picking a weighed product applies to every chain", () => {
  const w = (barcode: string, name: string): Product => ({ ...prod(barcode, 1, "קילוגרם"), is_weighted: true, name });
  const meats = [
    w("frozen", "בשר טחון מקפוא עטרה"),
    w("ramilevy", "בשר בקר טחון טרי"),
    w("other:9", "בשר בקר טחון טרי"),
    w("mahfud", "בשר טחון טרי מחפוד (עוף ירושלים)"),
    w("bakar2", "טחון בקר מבשר טרי"),
  ];
  it("prefers the same kind in all chains, not just the picked code", () => {
    const r = resolveItem({ key: "בשר טחון", qty: 1 }, meats, ["ramilevy"], new Map());
    expect(r.preferred).toEqual(["ramilevy", "other:9", "bakar2"]);
    expect(r.candidates.map((c) => c.barcode)).toContain("mahfud"); // other kinds still allowed, with the penalty
    expect(r.candidates.map((c) => c.barcode)).not.toContain("frozen"); // frozen only when asked for
  });
  it("'only this product' means only that kind", () => {
    const r = resolveItem({ key: "בשר טחון", qty: 1 }, meats, ["ramilevy"], new Map(), { strict: true });
    expect(r.candidates.map((c) => c.barcode)).toEqual(["ramilevy", "other:9", "bakar2"]);
  });
});

describe("plain produce, not pickles or premium", () => {
  const w = (barcode: string, name: string, price = 5): Product => ({ ...prod(barcode, 1, "קילוגרם"), is_weighted: true, name, min_price: price });
  it("skips pickled, organic and cherry unless asked", () => {
    const cukes = [w("pickle", "מלפפונים במלח/חומץ במשקל", 35), w("veg", "מלפפון/ירקות במשקל", 35), w("plain", "מלפפון", 4.9), w("org", "מלפפון אורגני", 16.9)];
    expect(resolveItem({ key: "מלפפונים", qty: 1 }, cukes, [], new Map()).candidates.map((c) => c.barcode)).toEqual(["plain"]);
    expect(resolveItem({ key: "מלפפונים במלח", qty: 1 }, cukes, [], new Map()).candidates.map((c) => c.barcode)).toContain("pickle");
    const toms = [w("cheryorg", "עגבנית שרי אורגנית", 36.9), w("magi", "עגבניות מגי", 9.9), w("plain", "עגבניה", 3.5), w("gouda", "גאודה עגבניות וזיתים", 138)];
    expect(resolveItem({ key: "עגבניות", qty: 1 }, toms, [], new Map()).candidates.map((c) => c.barcode)).toEqual(["magi", "plain"]);
    expect(resolveItem({ key: "עגבניות שרי", qty: 1 }, toms, [], new Map()).candidates.map((c) => c.barcode)).toContain("cheryorg");
  });
  it("keeps special products when nothing else matches", () => {
    expect(resolveItem({ key: "מלפפונים", qty: 1 }, [w("pickle", "מלפפונים במלח")], [], new Map()).candidates).toHaveLength(1);
  });
  it("drops what the user marked 'not this' (by name, in every chain)", () => {
    const toms = [w("a:1", "עגבניות מגי"), w("b:2", "עגבניות מגי"), w("plain", "עגבניה")];
    const r = resolveItem({ key: "עגבניות", qty: 1 }, toms, [], new Map(), { excluded: ["עגבניות מגי"] });
    expect(r.candidates.map((c) => c.barcode)).toEqual(["plain"]);
  });
  it("normalises like the database", async () => {
    const { normName, heStem } = await import("./basket");
    expect(heStem(normName("מלפפונים"))).toBe(heStem(normName("מלפפון")));
    expect(heStem(normName("עגבניות"))).toBe(heStem(normName("עגבנייה")));
  });
});
