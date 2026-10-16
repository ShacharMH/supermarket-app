"""Nightly ingestion: stores -> tracked branches -> latest prices & promotions.

Run:  SUPABASE_DB_URL=postgresql://... python ingest/ingest.py
Env:
  SUPABASE_DB_URL   Postgres connection string (Supabase "Session pooler" URI)
  CHAINS            optional comma-separated ScraperFactory names to limit the run
  SKIP_STORES=1     reuse branches already in the DB (faster re-runs)
"""

from __future__ import annotations

import asyncio
import os
import re
import shutil
import sys
import tempfile
import threading
from concurrent.futures import ThreadPoolExecutor, as_completed
from datetime import datetime, timedelta
from zoneinfo import ZoneInfo

import psycopg
from il_supermarket_scarper import FileTypesFilters, ScraperFactory
from il_supermarket_scarper.utils.files.file_output import DiskFileOutput

sys.path.insert(0, os.path.dirname(__file__))
from geo import geocode, haversine_km, load_city_codes, norm_city  # noqa: E402
from parse_xml import parse_prices, parse_promos, parse_stores  # noqa: E402

# Extra margin (km) when pre-filtering branches by their city's centre.
CITY_MARGIN_KM = 4
# Keep the database small (Supabase free tier = 500MB): per area keep only the
# nearest few branches of each chain, and a hard cap per area.
MAX_PER_CHAIN_PER_AREA = int(os.environ.get("MAX_PER_CHAIN_PER_AREA", "2"))
MAX_PER_AREA = int(os.environ.get("MAX_PER_AREA", "30"))
MAX_DB_MB = int(os.environ.get("MAX_DB_MB", "400"))
# Give up on one download attempt after this long (a stuck site must not eat the run).
ATTEMPT_TIMEOUT_S = int(os.environ.get("ATTEMPT_TIMEOUT_S", "600"))
# Chains are downloaded in parallel; loading into the DB stays sequential.
DOWNLOAD_WORKERS = int(os.environ.get("DOWNLOAD_WORKERS", "6"))
# Store lists rarely change: on scheduled runs refresh them only weekly.
STORES_MAX_AGE_DAYS = 6
# Convenience / pharmacy / factory-outlet chains - not useful for a weekly basket.
SKIP_SCRAPERS = {"YELLOW", "DOR_ALON", "GOOD_PHARM", "SUPER_PHARM", "BAREKET"}
MAX_PROMO_ITEMS = 3000

STAMP_RE = re.compile(r"(\d{8})-?(\d{4,6})")


_log_lock = threading.Lock()
_log_conn = None  # separate autocommit connection: progress is visible while the run is going
_run_id = None


def log(msg: str) -> None:
    print(f"[{datetime.now():%H:%M:%S}] {msg}", flush=True)
    if _log_conn is None:
        return
    try:
        with _log_lock:
            _log_conn.execute("insert into ingest_log (run_id, msg) values (%s, %s)", (_run_id, msg[:1000]))
    except Exception:  # noqa: BLE001 - logging must never break the run
        pass


# ------------------------------------------------------------------ download

def _newest(paths: list[str]) -> list[str]:
    def stamp(p):
        m = STAMP_RE.findall(os.path.basename(p))
        return "".join(m[-1]).ljust(14, "0") if m else ""
    return sorted(paths, key=stamp, reverse=True)


async def _scrape(enum: ScraperFactory, dest: str, files_types, regex=None, when_date=None, limit=None,
                  store_id=None) -> list[str]:
    cls = enum.value
    scraper = cls(file_output=DiskFileOutput(dest))
    found = []

    async def collect():
        async for result in scraper.scrape(
            files_types=files_types, file_name_regex=regex, when_date=when_date, limit=limit, store_id=store_id
        ):
            if result.extract_succefully and result.file_name:
                p = os.path.join(dest, result.file_name)
                if os.path.exists(p):
                    found.append(p)

    try:
        await asyncio.wait_for(collect(), ATTEMPT_TIMEOUT_S)
    except asyncio.TimeoutError:
        log(f"  {enum.name}{f' store {store_id}' if store_id else ''}: gave up after {ATTEMPT_TIMEOUT_S}s")
    # fall back to whatever landed in the folder (some engines rename on extract)
    if not found:
        found = [os.path.join(dest, f) for f in os.listdir(dest) if f.lower().endswith(".xml")]
    return found


def fetch(enum: ScraperFactory, files_types: list[str], regex: str | None = None, store_id: int | None = None) -> list[str]:
    """Download files of the given types, preferring today's, then yesterday's."""
    today = datetime.now(ZoneInfo("Asia/Jerusalem"))
    attempts = [dict(when_date=today), dict(when_date=today - timedelta(days=1)), dict(limit=6 if store_id else 40)]
    for kw in attempts:
        dest = tempfile.mkdtemp(prefix=f"{enum.name}-")
        try:
            paths = asyncio.run(_scrape(enum, dest, files_types, regex=regex, store_id=store_id, **kw))
        except Exception as e:  # noqa: BLE001
            log(f"  {enum.name}: download error {e!r}")
            paths = []
        if paths:
            return _newest(paths)
        shutil.rmtree(dest, ignore_errors=True)
    return []


def active_chains() -> list[ScraperFactory]:
    only = {c.strip() for c in os.environ.get("CHAINS", "").split(",") if c.strip()}
    chains = []
    for name in ScraperFactory.all_scrapers_name():
        if only and name not in only:
            continue
        enum = getattr(ScraperFactory, name)
        if ScraperFactory.is_deprecated(name):
            continue
        chains.append(enum)
    return chains


# ------------------------------------------------------------------ stores

def ingest_stores(conn, chains, city_codes) -> dict[str, str]:
    """Upsert chains+branches. Returns {chain_id: scraper name}."""
    chain_map: dict[str, str] = {}
    with ThreadPoolExecutor(DOWNLOAD_WORKERS) as pool:
        futures = {pool.submit(fetch, enum, [FileTypesFilters.STORE_FILE.name]): enum for enum in chains}
        downloaded = [(futures[f], f.result()) for f in as_completed(futures)]
    for enum, paths in downloaded:
        log(f"stores: {enum.name}")
        if not paths:
            log(f"  no store file for {enum.name}")
            continue
        stores = parse_stores(paths[0])
        chain_id = next((s["chain_id"] for s in stores if s["chain_id"]), None)
        if not chain_id:
            log(f"  {enum.name}: could not determine chain id")
            continue
        chain_map[chain_id] = enum.name
        chain_name = next((s["chain_name"] for s in stores if s["chain_name"]), enum.name)
        with conn.cursor() as cur:
            cur.execute(
                """insert into chains (chain_id, name, scraper) values (%s, %s, %s)
                   on conflict (chain_id) do update set name = excluded.name,
                     scraper = excluded.scraper, updated_at = now()""",
                (chain_id, chain_name, enum.name),
            )
            for s in stores:
                city = s["city"] or ""
                if city.strip().isdigit():
                    city = city_codes.get(str(int(city.strip())), city)
                cur.execute(
                    """insert into branches (chain_id, sub_chain_id, store_id, name, address, city, zip_code, is_online)
                       values (%s,%s,%s,%s,%s,%s,%s,%s)
                       on conflict (chain_id, store_id) do update set
                         sub_chain_id = excluded.sub_chain_id, name = excluded.name,
                         address = excluded.address, city = excluded.city,
                         zip_code = excluded.zip_code, is_online = excluded.is_online,
                         lat = case when branches.address is distinct from excluded.address
                                    then null else branches.lat end,
                         lon = case when branches.address is distinct from excluded.address
                                    then null else branches.lon end,
                         updated_at = now()""",
                    (chain_id, s["sub_chain_id"], s["store_id"], s["name"], s["address"],
                     city.strip() or None, s["zip_code"], s["is_online"]),
                )
        conn.commit()
        log(f"  {len(stores)} branches")
    return chain_map


# ------------------------------------------------------------------ areas / tracking

def city_center(conn, city: str) -> tuple[float, float] | None:
    key = norm_city(city)
    if not key:
        return None
    with conn.cursor() as cur:
        cur.execute("select lat, lon from city_geo where city = %s", (key,))
        row = cur.fetchone()
        if row:
            return None if row[0] is None else (row[0], row[1])
        pt = geocode(f"{city}, ישראל")
        cur.execute(
            "insert into city_geo (city, lat, lon) values (%s,%s,%s) on conflict (city) do nothing",
            (key, pt[0] if pt else None, pt[1] if pt else None),
        )
    conn.commit()
    return pt


def infer_missing_cities(conn) -> None:
    """Some chains publish city '0' or a numeric code and put the city in the store
    name instead ("קולינריק מודיעין"). Fill the city from the longest known city
    name found in the store name or address."""
    with conn.cursor() as cur:
        cur.execute(r"select distinct city from branches where city is not null and city !~ '^\d*$'")
        known = sorted({norm_city(c) for (c,) in cur.fetchall() if len(norm_city(c)) >= 2}, key=len, reverse=True)
        cur.execute(r"select id, name, address from branches where city is null or city ~ '^\d*$'")
        missing = cur.fetchall()
        fixed = 0
        for bid, name, address in missing:
            text = f" {norm_city(name)} {norm_city(address)} "
            hit = next((c for c in known if f" {c} " in text), None)
            if hit:
                cur.execute("update branches set city = %s where id = %s", (hit, bid))
                fixed += 1
    conn.commit()
    log(f"inferred city for {fixed}/{len(missing)} branches without one")


def select_tracked(conn) -> list[tuple]:
    infer_missing_cities(conn)
    with conn.cursor() as cur:
        cur.execute("select id, label, city, lat, lon, radius_km from user_areas")
        areas = cur.fetchall()
    if not areas:
        log("no user areas defined yet - nothing to track")
        return []

    resolved = []
    for aid, label, city, lat, lon, radius in areas:
        if lat is None and city:
            pt = city_center(conn, city)
            if pt:
                lat, lon = pt
                with conn.cursor() as cur:
                    cur.execute("update user_areas set lat=%s, lon=%s where id=%s", (lat, lon, aid))
                conn.commit()
        resolved.append((label, norm_city(city), lat, lon, float(radius)))
        log(f"area {label}: city={city} center={lat},{lon} r={radius}km")

    with conn.cursor() as cur:
        cur.execute(
            """select b.id, b.chain_id, b.name, b.address, b.city, b.lat, b.lon, b.is_online
               from branches b join chains c using (chain_id)
               where coalesce(c.scraper, '') <> all(%s)""",
            (list(SKIP_SCRAPERS),),
        )
        branches = cur.fetchall()

    # per area: [(distance, chain_id, branch_id)]
    per_area: list[list[tuple[float, str, int]]] = [[] for _ in resolved]
    nearest_online: dict[str, tuple[float, int]] = {}
    for bid, chain_id, name, address, city, lat, lon, is_online in branches:
        bcity = norm_city(city)
        center = city_center(conn, city) if city else None
        best = None
        for i, (_label, acity, alat, alon, radius) in enumerate(resolved):
            d = None
            if alat is not None and center is not None and haversine_km(alat, alon, *center) <= radius + CITY_MARGIN_KM:
                # candidate: geocode the exact address and re-check
                if lat is None and address:
                    pt = geocode(f"{address}, {city}, ישראל") or center
                    lat, lon = pt
                    with conn.cursor() as cur:
                        cur.execute("update branches set lat=%s, lon=%s where id=%s", (lat, lon, bid))
                    conn.commit()
                d = haversine_km(alat, alon, lat or center[0], lon or center[1])
                if d > radius:
                    d = None
            if d is None and acity and bcity == acity:
                d = 0.0
            if d is None:
                continue
            best = d if best is None else min(best, d)
            if not is_online:
                per_area[i].append((d, chain_id, bid))
        if is_online:
            # one online store per chain: the one closest to any area
            if center is not None:
                for _l, _c, alat, alon, _r in resolved:
                    if alat is None:
                        continue
                    d = haversine_km(alat, alon, *center)
                    if chain_id not in nearest_online or d < nearest_online[chain_id][0]:
                        nearest_online[chain_id] = (d, bid)
            if best is not None:
                nearest_online[chain_id] = (-1, bid)

    tracked: set[int] = set()
    for (label, *_rest), cands in zip(resolved, per_area):
        per_chain: dict[str, int] = {}
        kept = 0
        for d, chain_id, bid in sorted(cands):
            if kept >= MAX_PER_AREA:
                break
            if per_chain.get(chain_id, 0) >= MAX_PER_CHAIN_PER_AREA:
                continue
            per_chain[chain_id] = per_chain.get(chain_id, 0) + 1
            tracked.add(bid)
            kept += 1
        log(f"area {label}: {len(cands)} branches in radius, tracking {kept}")
    tracked.update(bid for _d, bid in nearest_online.values())

    with conn.cursor() as cur:
        cur.execute("update branches set tracked = (id = any(%s))", (list(tracked),))
        # free space: drop data of branches no longer tracked
        cur.execute("delete from prices where branch_id in (select id from branches where not tracked)")
        cur.execute("delete from promotions where branch_id in (select id from branches where not tracked)")
        cur.execute(
            """select b.id, b.store_id, c.scraper, c.chain_id from branches b
               join chains c using (chain_id) where b.tracked order by c.scraper, b.store_id"""
        )
        rows = cur.fetchall()
    conn.commit()
    log(f"tracking {len(rows)} branches")
    return rows


# ------------------------------------------------------------------ prices / promos

def load_prices(conn, branch_id: int, items: list[dict]) -> None:
    with conn.cursor() as cur:
        cur.execute(
            """create temp table if not exists _p (barcode text, name text, manufacturer text,
               quantity numeric, unit_of_measure text, is_weighted bool, price numeric,
               unit_price numeric) on commit delete rows"""
        )
        with cur.copy("copy _p from stdin") as cp:
            seen = set()
            for it in items:
                if it["barcode"] in seen:
                    continue
                seen.add(it["barcode"])
                cp.write_row((it["barcode"], it["name"], it["manufacturer"], it["quantity"],
                              it["unit_of_measure"], it["is_weighted"], it["price"], it["unit_price"]))
        cur.execute(
            """insert into products (barcode, name, manufacturer, quantity, unit_of_measure, is_weighted)
               select barcode, name, manufacturer, quantity, unit_of_measure, is_weighted from _p
               on conflict (barcode) do update set
                 manufacturer = coalesce(products.manufacturer, excluded.manufacturer),
                 name = case when products.manufacturer is null and excluded.manufacturer is not null
                             then excluded.name else products.name end,
                 quantity = coalesce(products.quantity, excluded.quantity),
                 unit_of_measure = coalesce(products.unit_of_measure, excluded.unit_of_measure)"""
        )
        cur.execute(
            """insert into prices (branch_id, barcode, price, unit_price, item_name, updated_at)
               select %s, barcode, price, unit_price, name, now() from _p
               on conflict (branch_id, barcode) do update set price = excluded.price,
                 unit_price = excluded.unit_price, item_name = excluded.item_name, updated_at = now()""",
            (branch_id,),
        )
        cur.execute(
            "delete from prices where branch_id = %s and barcode not in (select barcode from _p)",
            (branch_id,),
        )
    conn.commit()


def load_promos(conn, branch_id: int, chain_id: str, promos: list[dict]) -> None:
    now = datetime.now().astimezone()
    with conn.cursor() as cur:
        cur.execute("delete from promotions where branch_id = %s", (branch_id,))
        for p in promos:
            if p["ends_at"] and p["ends_at"] < now:
                continue
            if len(p["barcodes"]) > MAX_PROMO_ITEMS:
                continue
            cur.execute(
                """insert into promotions (branch_id, promotion_id, description, starts_at, ends_at,
                     min_qty, max_qty, discounted_price, discount_rate, reward_type, club_ids, is_club_only)
                   values (%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s)
                   on conflict (branch_id, promotion_id) do nothing returning id""",
                (branch_id, p["promotion_id"], p["description"], p["starts_at"], p["ends_at"],
                 p["min_qty"], p["max_qty"], p["discounted_price"], p["discount_rate"],
                 p["reward_type"], p["club_ids"], p["is_club_only"]),
            )
            row = cur.fetchone()
            if not row:
                continue
            codes = p["barcodes"]
            with cur.copy("copy promotion_items (promotion_pk, barcode) from stdin") as cp:
                for b in set(codes):
                    cp.write_row((row[0], b))
    conn.commit()


def db_size_mb(conn) -> float:
    with conn.cursor() as cur:
        cur.execute("select pg_database_size(current_database()) / 1048576.0")
        return float(cur.fetchone()[0])


def ingest_prices(conn, tracked_rows) -> None:
    by_scraper: dict[str, list[tuple]] = {}
    for bid, store_id, scraper, chain_id in tracked_rows:
        by_scraper.setdefault(scraper, []).append((bid, store_id, chain_id))

    def download(scraper: str, branches: list[tuple]) -> list[str]:
        # one store at a time: some sites (e.g. Shufersal) filter by store server-side,
        # which is far faster than listing every file of the chain
        enum = getattr(ScraperFactory, scraper)
        paths: list[str] = []
        for _bid, store_id, _cid in branches:
            t = datetime.now()
            got = fetch(enum, [FileTypesFilters.PRICE_FULL_FILE.name, FileTypesFilters.PROMO_FULL_FILE.name],
                        rf"-0*{int(store_id)}-\d{{8}}", store_id=int(store_id))
            log(f"downloaded {scraper} store {store_id}: {len(got)} files in {(datetime.now() - t).seconds}s")
            paths += got
        return paths

    with ThreadPoolExecutor(DOWNLOAD_WORKERS) as pool:
        futures = {pool.submit(download, sc, br): sc for sc, br in by_scraper.items()}
        for fut in as_completed(futures):
            scraper = futures[fut]
            try:
                paths = fut.result()
            except Exception as e:  # noqa: BLE001
                log(f"prices: {scraper} download failed: {e!r}")
                continue
            log(f"prices: {scraper} - loading {len(paths)} files")
            for bid, store_id, chain_id in by_scraper[scraper]:
                if db_size_mb(conn) > MAX_DB_MB:
                    log(f"database above {MAX_DB_MB}MB - skipping {scraper} {store_id}")
                    continue
                pat = re.compile(rf"-0*{int(store_id)}-\d{{8}}", re.I)
                mine = [p for p in paths if pat.search(os.path.basename(p))]
                price_files = [p for p in mine if "pricefull" in os.path.basename(p).lower()]
                promo_files = [p for p in mine if "promofull" in os.path.basename(p).lower()]
                try:
                    if price_files:
                        _meta, items = parse_prices(price_files[0])
                        load_prices(conn, bid, items)
                        log(f"  store {store_id}: {len(items)} prices")
                    else:
                        log(f"  store {store_id}: no price file found")
                    if promo_files:
                        _meta, promos = parse_promos(promo_files[0])
                        load_promos(conn, bid, chain_id, promos)
                        log(f"  store {store_id}: {len(promos)} promotions")
                except Exception as e:  # noqa: BLE001 - one bad file must not stop the run
                    conn.rollback()
                    log(f"  store {store_id}: failed to load: {e!r}")


def stores_are_fresh(conn) -> bool:
    with conn.cursor() as cur:
        cur.execute("select coalesce(max(updated_at) > now() - make_interval(days => %s), false) from chains",
                    (STORES_MAX_AGE_DAYS,))
        return bool(cur.fetchone()[0])


def main() -> None:
    db_url = os.environ["SUPABASE_DB_URL"]
    chains = active_chains()
    global _log_conn, _run_id
    with psycopg.connect(db_url, autocommit=False, prepare_threshold=None) as conn:
        with conn.cursor() as cur:
            cur.execute("insert into ingest_runs default values returning id")
            run_id = cur.fetchone()[0]
            cur.execute("delete from ingest_log where at < now() - interval '14 days'")
        conn.commit()
        try:
            _log_conn = psycopg.connect(db_url, autocommit=True, prepare_threshold=None)
            _run_id = run_id
        except Exception as e:  # noqa: BLE001
            print(f"progress logging disabled: {e!r}")
        status, note = "ok", None
        try:
            # SKIP_STORES: "1" = skip, "0" = force refresh, unset (scheduled) = weekly
            mode = (os.environ.get("SKIP_STORES") or "").strip()
            if mode == "0" or (mode != "1" and not stores_are_fresh(conn)):
                ingest_stores(conn, chains, load_city_codes())
            else:
                log("skipping store lists (fresh enough)")
            tracked = select_tracked(conn)
            ingest_prices(conn, tracked)
        except Exception as e:  # noqa: BLE001
            conn.rollback()
            status, note = "error", repr(e)[:2000]
            raise
        finally:
            with conn.cursor() as cur:
                cur.execute(
                    "update ingest_runs set finished_at = now(), status = %s, note = %s where id = %s",
                    (status, note, run_id),
                )
            conn.commit()


if __name__ == "__main__":
    main()
