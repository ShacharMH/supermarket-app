// Supermarket departments, in a typical walking order, with a keyword matcher each.
export type Category = { id: string; label: string; icon: string };

const CATS: [Category, RegExp][] = [
  [{ id: "produce", label: "ירקות ופירות", icon: "🥬" },
    /(עגבני|מלפפו|פלפל|גזר|בצל|שום|תפוח|תפו"א|תפוא|בטטה|קישוא|חציל|כרוב|ברוקולי|סלק|חסה|פטרוזיליה|כוסברה|שמיר|נענע|בזיליקום|פטריות|אבוקדו|לימו|תפוז|קלמנטינ|אשכולית|בננ|אגס|ענב|אפרסק|נקטרינ|שזיף|משמש|מנגו|קיווי|רימו|אבטיח|מלון|תות|דלעת|דלורית|תירס טרי|ירקות|פירות|ג'ינג'ר|גינגר|סלרי|צנונית|קולורבי|לפת|שעועית ירוקה|אפונה טרייה)/],
  [{ id: "bakery", label: "מאפים ולחם", icon: "🍞" },
    /(לחם|לחמני|פיתה|פיתות|באגט|חלה|חלות|טורטיי|לאפה|עוגה|עוגיות|קרואסון|בורקס|מאפ)/],
  [{ id: "dairy", label: "מוצרי חלב וביצים", icon: "🥛" },
    /(חלב|קוטג|גבינ|גאודה|עמק|פרמזן|ריקוטה|פטה|חלומי|קממבר|עיזים|יוגורט|יופלה|מעדן|שמנת|חמאה|לבן|לבנה|אשל|בולגרית|מוצרלה|צפתית|ביצים|ביצה|דנונה|מילקי|שוקו(?![א-ת]))/],
  [{ id: "meat", label: "בשר, עוף ודגים", icon: "🥩" },
    /(בשר|טחון|עוף|הודו|שניצל|פרגית|חזה|כרעיים|שוקיים|כנפיים|אנטריקוט|סינטה|פילה|צלעות|קבב|המבורגר|נקניק|נקניקי|פסטרמה|סלמי|דג|דגים|סלמון|טונה טרי|אמנון|דניס|לברק)/],
  [{ id: "frozen", label: "קפואים", icon: "🧊" },
    /(קפוא|גלידה|ארטיק|פיצה קפואה|ירקות קפואים|בצק עלים|שקדי מרק)/],
  [{ id: "pantry", label: "מזווה", icon: "🥫" },
    /(אורז|פסטה|ספגטי|קמח|סוכר|מלח|שמן|חומץ|טונה|שימור|רסק|רוטב|קטשופ|מיונז|חרדל|טחינה|חומוס|קוסקוס|פתיתים|עדשים|שעועית|גרגרי|תבלין|פפריקה|כמון|פלפל שחור|קפה|תה|קקאו|דבש|ריבה|ממרח|נוטלה|שוקולד|דגני|קורנפלקס|גרנולה|שיבולת|קרקר|פריכיות|מרק|אבקת|שמרים|זיתים|חמוצים|מלפפונים במלח)/],
  [{ id: "snacks", label: "חטיפים ומתוקים", icon: "🍪" },
    /(במבה|ביסלי|חטיף|צ'יפס|ציפס|דוריטוס|אפרופו|קליק|קרמבו|וופל|סוכריות|מסטיק|פופקורן|גרעינים|בוטנים|אגוז|שקדים|קשיו|פיסטוק|פיצוחים)/],
  [{ id: "drinks", label: "משקאות", icon: "🥤" },
    /(מים|סודה|קולה|ספרייט|פאנטה|מיץ|משקה|בירה|יין|וודקה|ענבים|תפוזים טבעי|פריגת|ספרינג|נביעות|נסטי|אנרגיה)/],
  [{ id: "cleaning", label: "ניקיון וכביסה", icon: "🧽" },
    /(אקונומיקה|נקה|ניקוי|סבון כלים|פיירי|אבקת כביסה|ג'ל כביסה|מרכך|כביסה|מגבונ|נייר טואלט|נייר סופג|מגבות נייר|שקיות אשפה|שקיות|ספוג|מטלית|כלור|מסיר|אל סבון|סנו|טאצ')/],
  [{ id: "care", label: "טיפוח והיגיינה", icon: "🧴" },
    /(שמפו|מרכך שיער|סבון|משחת שיניים|מברשת|דאודורנט|תחבושות|טמפונ|קרם|גילוח|סכיני|צמר גפן|מקלוני)/],
  [{ id: "baby", label: "תינוקות", icon: "👶" }, /(חיתול|מטרנה|סימילאק|נוטרילון|מחית|טיטול|האגיס|פמפרס)/],
];

export const OTHER: Category = { id: "other", label: "שונות", icon: "🛒" };
export const CATEGORY_ORDER = [...CATS.map(([c]) => c.id), OTHER.id];

/** Department of a list term or product name (first matching keyword wins; produce first). */
export function categoryOf(text: string): Category {
  const t = text.replace(/[׳]/g, "'").replace(/["״]/g, '"');
  // "מלפפונים במלח" / "טונה" belong to the pantry even though they name produce or fish
  if (/(במלח|בחומץ|חמוצ|משומר|שימורים|קופסת)/.test(t)) return CATS.find(([c]) => c.id === "pantry")![0];
  if (/קפוא/.test(t)) return CATS.find(([c]) => c.id === "frozen")![0];
  // the word that comes first decides: "שעועית לבנה" is a legume, not labneh; ties go to
  // the earlier department ("שעועית ירוקה" is produce)
  let best: Category = OTHER;
  let at = Infinity;
  for (const [c, re] of CATS) {
    const i = t.search(re);
    if (i >= 0 && i < at) [best, at] = [c, i];
  }
  return best;
}

/** Group items by department in walking order. */
export function groupByCategory<T>(items: T[], text: (x: T) => string): { cat: Category; items: T[] }[] {
  const groups = new Map<string, { cat: Category; items: T[] }>();
  for (const it of items) {
    const cat = categoryOf(text(it));
    if (!groups.has(cat.id)) groups.set(cat.id, { cat, items: [] });
    groups.get(cat.id)!.items.push(it);
  }
  return [...groups.values()].sort((a, b) => CATEGORY_ORDER.indexOf(a.cat.id) - CATEGORY_ORDER.indexOf(b.cat.id));
}
