"""החישוק (hahishook.com): an online-only shop outside the price-transparency files.
They publish a daily TSV of every product for anyone who wants their prices:
https://hahishook.com/wp-content/uploads/chp/YYYYMMDD.tsv  (format stable since 2025)

Columns: 0 itemcode, 1 price, 2 discounted_price, 3 capacity, 4 deeplink, 5 short_name,
6 capacity unit, 7 long_name, 8 image, 9 leading_barcodes, 10 similar_barcodes, 11 in stock?
"""

from __future__ import annotations

from datetime import datetime, timedelta
from zoneinfo import ZoneInfo

import requests

CHAIN_ID = "hahishook"
CHAIN_NAME = "החישוק"
URL = "https://hahishook.com/wp-content/uploads/chp/{day}.tsv"
HEADERS = {"User-Agent": "supermarket-app (personal price comparison; prices shared by החישוק)"}


def _num(v: str) -> float | None:
    try:
        n = float(v.strip())
    except (ValueError, AttributeError):
        return None
    return n if n > 0 else None


def _gtins(cell: str) -> list[str]:
    return [b.strip() for b in (cell or "").split(",") if b.strip().isdigit() and len(b.strip()) >= 8]


def fetch_tsv() -> tuple[str, str] | None:
    """Today's file, else yesterday's (it is created during the day)."""
    today = datetime.now(ZoneInfo("Asia/Jerusalem")).date()
    for days in range(0, 3):
        day = (today - timedelta(days=days)).strftime("%Y%m%d")
        r = requests.get(URL.format(day=day), headers=HEADERS, timeout=60)
        if r.ok and r.content.count(b"\n") > 10:
            return day, r.content.decode("utf-8", errors="replace")
    return None


def parse(text: str) -> list[dict]:
    """Rows for load_prices. Each product is stored under its own code and, with the same
    price, under the barcodes of the identical branded product it sells (leading_barcodes),
    so a product you prefer in the supermarket is also found at החישוק."""
    items: list[dict] = []
    for line in text.splitlines():
        c = line.split("\t")
        if len(c) < 10 or not c[0].strip().isdigit():
            continue
        if len(c) > 11 and c[11].strip() == "0":  # out of stock
            continue
        prices = [p for p in (_num(c[1]), _num(c[2])) if p]
        if not prices:
            continue
        short = c[5].strip()
        qty = _num(c[3])
        unit = c[6].strip() or None
        name = f"{short} {qty:g} {unit}" if qty and unit and str(int(qty)) not in short else short
        base = {
            "name": name, "manufacturer": CHAIN_NAME, "quantity": qty, "unit_of_measure": unit,
            "is_weighted": False, "price": round(min(prices), 2), "unit_price": None,
        }
        items.append({**base, "barcode": f"{CHAIN_ID}:{c[0].strip()}"})
        for gtin in _gtins(c[9]):
            items.append({**base, "barcode": gtin})
    return items


def ensure_branch(conn) -> int:
    """The shop as one online 'branch' that is always tracked."""
    with conn.cursor() as cur:
        cur.execute(
            """insert into chains (chain_id, name, scraper) values (%s, %s, 'HAHISHOOK')
               on conflict (chain_id) do update set name = excluded.name, updated_at = now()""",
            (CHAIN_ID, CHAIN_NAME),
        )
        cur.execute(
            """insert into branches (chain_id, store_id, name, is_online, tracked)
               values (%s, 'online', 'משלוח עד הבית', true, true)
               on conflict (chain_id, store_id) do update set tracked = true, is_online = true
               returning id""",
            (CHAIN_ID,),
        )
        bid = cur.fetchone()[0]
    conn.commit()
    return bid
