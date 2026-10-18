import { describe, expect, it } from "vitest";
import { categoryOf, groupByCategory } from "./categories";

describe("categories", () => {
  it("classifies common list items", () => {
    const cases: [string, string][] = [
      ["עגבניות", "produce"], ["מלפפונים", "produce"], ["חסה", "produce"], ["קוטג'", "dairy"], ["חלב 3%", "dairy"],
      ["ביצים", "dairy"], ["בשר בקר טחון טרי", "meat"], ["לחם אחיד", "bakery"], ["אקונומיקה", "cleaning"],
      ["קליק ביסקוויט של עלית", "snacks"], ["במבה", "snacks"], ["אורז", "pantry"], ["מלפפונים במלח", "pantry"],
      ["שניצל קפוא", "frozen"], ["קולה", "drinks"], ["שמפו", "care"], ["נקטרינה", "produce"], ["משהו אחר", "other"],
    ];
    for (const [t, id] of cases) expect([t, categoryOf(t).id]).toEqual([t, id]);
  });
  it("groups in walking order", () => {
    const g = groupByCategory(["אקונומיקה", "חלב", "עגבניות", "לחם"], (x) => x);
    expect(g.map((x) => x.cat.id)).toEqual(["produce", "bakery", "dairy", "cleaning"]);
  });
});

describe("the first word decides the department", () => {
  it("files legumes and chocolate correctly", () => {
    expect(categoryOf("שעועית לבנה").id).toBe("pantry");
    expect(categoryOf("שוקולד מריר 90%").id).toBe("pantry");
    expect(categoryOf("שוקו").id).toBe("dairy");
    expect(categoryOf("לבנה").id).toBe("dairy");
    expect(categoryOf("שעועית ירוקה").id).toBe("produce");
    expect(categoryOf("גבינה צהובה").id).toBe("dairy");
    expect(categoryOf("חזה עוף").id).toBe("meat");
  });
});
