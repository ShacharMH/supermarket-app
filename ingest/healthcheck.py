"""Post-ingest health check: exercises the database the way the app does.

Run:  SUPABASE_DB_URL=postgresql://... python ingest/healthcheck.py
Exit code 1 on hard failures (GitHub then marks the run red and emails the owner).
"""

from __future__ import annotations

import json
import os
import sys
import time

import psycopg

COMMON_ITEMS = [
    "חלב 3%", "קוטג", "לחם", "ביצים", "עגבניות", "מלפפון", "שמן קנולה", "סוכר",
    "קמח", "אורז", "פסטה", "טונה", "במבה", "קפה", "נייר טואלט", "אקונומיקה",
]
SEARCH_MAX_S = 1.0
BASKET_MAX_S = 3.0
MIN_ITEM_HIT_RATE = 0.7   # share of common items that must return results
STALE_DAYS = 2

failures: list[str] = []
warnings: list[str] = []


def fail(msg: str) -> None:
    failures.append(msg)
    print(f"FAIL  {msg}")


def warn(msg: str) -> None:
    warnings.append(msg)
    print(f"WARN  {msg}")


def ok(msg: str) -> None:
    print(f"ok    {msg}")


def as_role(cur, role: str, user_id: str | None = None) -> None:
    cur.execute(f"set local role {role}")
    claims = json.dumps({"sub": user_id, "role": role} if user_id else {"role": role})
    cur.execute("select set_config('request.jwt.claims', %s, true)", (claims,))
    if user_id:
        cur.execute("select set_config('request.jwt.claim.sub', %s, true)", (user_id,))


def check_security(conn, user_id: str | None) -> None:
    with conn.transaction(), conn.cursor() as cur:
        as_role(cur, "anon")
        for table in ("prices", "products", "branches", "receipts", "user_areas"):
            try:
                with conn.transaction():
                    cur.execute(f"select count(*) from {table}")
                    n = cur.fetchone()[0]
                if n:
                    fail(f"anonymous visitor can read {n} rows from {table}")
            except psycopg.errors.InsufficientPrivilege:
                pass  # no access at all is fine too
        ok("anonymous visitors see no data")
        raise psycopg.Rollback()

    if not user_id:
        warn("no registered user yet - skipping signed-in checks")
        return
    with conn.transaction(), conn.cursor() as cur:
        as_role(cur, "authenticated", "00000000-0000-0000-0000-000000000000")
        cur.execute("select count(*) from user_areas")
        if cur.fetchone()[0]:
            fail("a different signed-in user can see the owner's areas")
        else:
            ok("personal data is private to its owner")
        raise psycopg.Rollback()


def check_app_queries(conn, user_id: str | None) -> None:
    if not user_id:
        return
    hits: dict[str, list[str]] = {}
    with conn.transaction(), conn.cursor() as cur:
        as_role(cur, "authenticated", user_id)
        cur.execute("set local statement_timeout = '8s'")  # same limit the API uses
        slow = []
        for item in COMMON_ITEMS:
            t = time.monotonic()
            cur.execute("select barcode from search_products(%s, 25)", (item,))
            dt = time.monotonic() - t
            hits[item] = [r[0] for r in cur.fetchall()]
            if dt > SEARCH_MAX_S:
                slow.append(f"{item} ({dt:.1f}s)")
        if slow:
            fail(f"slow product search: {', '.join(slow)}")
        else:
            ok(f"product search under {SEARCH_MAX_S}s for {len(COMMON_ITEMS)} items")

        found = [k for k, v in hits.items() if v]
        missing = [k for k, v in hits.items() if not v]
        rate = len(found) / len(COMMON_ITEMS)
        (fail if rate < MIN_ITEM_HIT_RATE else (warn if missing else ok))(
            f"{len(found)}/{len(COMMON_ITEMS)} common items found" + (f"; missing: {', '.join(missing)}" if missing else "")
        )

        items = [{"key": k, "qty": 1, "candidates": v[:10]} for k, v in hits.items() if v]
        t = time.monotonic()
        cur.execute(
            "select branch_id, chain_name, branch_name, jsonb_array_length(lines) from price_basket(%s::jsonb, 0.15, '{}')",
            (json.dumps(items),),
        )
        rows = cur.fetchall()
        dt = time.monotonic() - t
        (fail if dt > BASKET_MAX_S else ok)(f"basket of {len(items)} items priced in {dt:.1f}s")
        if items and rows:
            good = [r for r in rows if r[3] >= 0.6 * len(items)]
            (warn if len(good) < len(rows) / 2 else ok)(
                f"{len(good)}/{len(rows)} branches carry at least 60% of a common basket"
            )
        raise psycopg.Rollback()


def check_data(conn) -> None:
    with conn.cursor() as cur:
        cur.execute("select count(*) from branches where tracked")
        tracked = cur.fetchone()[0]
        if tracked == 0:
            fail("no branches are tracked")
            return
        cur.execute(
            """select c.name, b.name, b.city from branches b join chains c using (chain_id)
               where b.tracked and not exists (select 1 from prices p where p.branch_id = b.id)"""
        )
        empty = cur.fetchall()
        msg = f"{tracked - len(empty)}/{tracked} tracked branches have prices"
        if empty:
            msg += "; without: " + ", ".join(f"{c} {n}" for c, n, _ in empty[:15])
        (fail if len(empty) > tracked / 2 else warn if empty else ok)(msg)

        cur.execute(
            """select c.name, b.name, max(p.updated_at)::date from prices p
               join branches b on b.id = p.branch_id join chains c using (chain_id)
               where b.tracked group by 1, 2 having max(p.updated_at) < now() - make_interval(days => %s)""",
            (STALE_DAYS,),
        )
        stale = cur.fetchall()
        (warn if stale else ok)(
            f"{len(stale)} branches with prices older than {STALE_DAYS} days"
            + (": " + ", ".join(f"{c} {n} ({d})" for c, n, d in stale[:10]) if stale else "")
        )

        cur.execute("select count(*) from prices where price <= 0 or price > 5000")
        bad = cur.fetchone()[0]
        (warn if bad else ok)(f"{bad} prices outside 0-5000 ₪")

        cur.execute(
            """select count(*) from promotions pm where pm.discounted_price is not null
               and pm.min_qty > 50"""
        )
        odd = cur.fetchone()[0]
        (warn if odd else ok)(f"{odd} promotions with min quantity above 50")

        cur.execute("select pg_database_size(current_database()) / 1048576")
        mb = cur.fetchone()[0]
        (fail if mb > 450 else warn if mb > 350 else ok)(f"database size {mb}MB (free tier: 500MB)")

        cur.execute(
            "select status, note from ingest_runs where finished_at is not null order by id desc limit 1"
        )
        last = cur.fetchone()
        if last and last[0] == "error":
            fail(f"last ingest run failed: {last[1]}")


def main() -> int:
    with psycopg.connect(os.environ["SUPABASE_DB_URL"], prepare_threshold=None, autocommit=True) as conn:
        with conn.cursor() as cur:
            cur.execute("select id::text from auth.users order by created_at limit 1")
            row = cur.fetchone()
        user_id = row[0] if row else None
        check_data(conn)
        check_security(conn, user_id)
        check_app_queries(conn, user_id)

    print(f"\n{len(failures)} failures, {len(warnings)} warnings")
    summary = os.environ.get("GITHUB_STEP_SUMMARY")
    if summary:
        with open(summary, "a", encoding="utf-8") as f:
            f.write("## Health check\n\n")
            for m in failures:
                f.write(f"- ❌ {m}\n")
            for m in warnings:
                f.write(f"- ⚠️ {m}\n")
            if not failures and not warnings:
                f.write("- ✅ all checks passed\n")
    return 1 if failures else 0


if __name__ == "__main__":
    sys.exit(main())
