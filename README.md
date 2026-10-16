# סל זול – supermarket-app

אפליקציה אישית שמקבלת רשימת קניות ומחזירה באיזה סופר באזור (או חנות אונליין) הסל הכי זול.
אם משתלם, היא מציעה גם פיצול בין שני סופרים. הנתונים מגיעים מקבצי שקיפות המחירים שהרשתות מחויבות לפרסם.

## מבנה
| תיקייה | מה יש שם |
|---|---|
| `ingest/` | סקריפט Python שרץ כל לילה ב-GitHub Actions: מוריד רשימות סניפים, מחירים ומבצעים (בעזרת `il-supermarket-scraper`), בוחר את הסניפים באזורים שלך ושומר רק את המחיר העדכני ב-Supabase |
| `supabase/migrations/` | מבנה מסד הנתונים, הרשאות (RLS) ופונקציות החיפוש והתמחור (`search_products`, `price_basket`, `resolve_receipt`) |
| `app/` | אפליקציית ווב (PWA) ב-React, מותאמת לטלפון ומתפרסמת ב-GitHub Pages |

## איך זה עובד
1. **אזורים** (בהגדרות): עיר ורדיוס, או המיקום הנוכחי. האיסוף הלילי עוקב רק אחרי סניפים באזורים האלה, ובנוסף אחרי חנות האונליין הקרובה של כל רשת.
2. **רשימה**: כל שורה היא מוצר כללי ("קוטג"). המערכת מוצאת מוצרים תואמים ומשאירה רק גדלים דומים (±25%).
   - **מועדף**: מוצר שנבחר ידנית, אחרת מוצר שמופיע בקבלות.
   - מוצר חלופי ייבחר רק אם הוא זול ביותר מהסף שהוגדר (ברירת מחדל 15%).
3. **מבצעים**: "X ב-Y" ואחוזי הנחה מחושבים לפי הכמות ברשימה. מבצעי מועדון נספרים רק ברשתות שסומנו כמועדון שלך.
4. **קבלות**: טוענים CSV עם העמודות `תאריך, מוצר, ברקוד, כמות, מחיר` (חובה רק `מוצר`). שורה בלי ברקוד מזוהה לפי השם, מול שמות הפריטים של הרשת.

## הקמה (חד-פעמית)
1. **סוד ל-Actions**: ‏Settings → Secrets and variables → Actions → `SUPABASE_DB_URL`.
   הערך הוא מחרוזת החיבור "Session pooler" מ-Supabase (Connect → Connection string), כולל הסיסמה.
2. **Pages**: ‏Settings → Pages → Source: GitHub Actions.
3. **Supabase Auth**: ‏Authentication → URL Configuration → Site URL = `https://shacharmh.github.io/supermarket-app/`.
   אחרי ההרשמה הראשונה כבו את Allow new users to sign up.
4. מוסיפים אזור באפליקציה ומריצים ידנית את Actions → Ingest prices → Run workflow. אחר כך הוא ירוץ כל לילה.

## פיתוח
```bash
cd app && npm install && npm run dev      # אפליקציה
cd app && npm test                         # בדיקות לוגיקה
pip install -r ingest/requirements.txt && SUPABASE_DB_URL=... python ingest/ingest.py
```
