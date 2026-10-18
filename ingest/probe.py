"""One-off diagnostics that need the network GitHub Actions has (the chains' file
servers, other shops' sites). Results go to ingest_log as 'probe ...' rows."""

from __future__ import annotations

import os
import sys

import psycopg
import requests
from lxml import etree

sys.path.insert(0, os.path.dirname(__file__))
import ingest  # noqa: E402
from il_supermarket_scarper import FileTypesFilters, ScraperFactory  # noqa: E402

PROMOS = [  # (scraper, store, promotion id to show or None for the first with a price word)
    ("SHUFERSAL", 187, "4659610"),
    ("RAMI_LEVY", 6, "0001427294"),
    ("YOHANANOF", 20, None),
    ("OSHER_AD", 26, None),
    ("YAYNO_BITAN_AND_CARREFOUR", 448, None),
]
SITES = [
    "https://hahishook.com/robots.txt",
    "https://hahishook.com/",
    "https://hahishook.com/products.json?limit=2",
    "https://hahishook.com/wp-json/wc/store/v1/products?per_page=2",
    "https://hahishook.com/sitemap.xml",
]


def main() -> None:
    conn = psycopg.connect(os.environ["SUPABASE_DB_URL"], autocommit=True, prepare_threshold=None)

    def out(msg: str) -> None:
        print(msg)
        for i in range(0, len(msg), 3500):
            conn.execute("insert into ingest_log (msg) values (%s)", (f"probe {msg[i:i + 3500]}",))

    for name, store, pid in PROMOS:
        try:
            files = ingest.fetch(getattr(ScraperFactory, name), [FileTypesFilters.PROMO_FULL_FILE.name],
                                 rf"-0*{store}-\d{{8}}", store_id=store)
            if not files:
                out(f"{name} {store}: no promo file")
                continue
            root = etree.parse(files[0], etree.XMLParser(recover=True, huge_tree=True)).getroot()
            hit = None
            for el in root.iter():
                tag = str(el.tag).rsplit("}", 1)[-1].lower()
                if tag != "promotionid" or el.getparent() is None:
                    continue
                if (pid and (el.text or "").strip() == pid) or (not pid and hit is None):
                    hit = el.getparent()
                    if pid:
                        break
            if hit is not None:
                # the item list can be long: keep its first two items
                for el in list(hit.iter()):
                    kids = list(el)
                    if len(kids) > 2 and len({str(k.tag) for k in kids}) == 1:
                        for k in kids[2:]:
                            el.remove(k)
            xml = etree.tostring(hit, encoding="unicode") if hit is not None else "not found"
            out(f"{name} {store} {os.path.basename(files[0])}: {xml[:5000]}")
        except Exception as e:  # noqa: BLE001
            out(f"{name} {store}: error {e!r}")

    for url in SITES:
        try:
            r = requests.get(url, timeout=30, headers={"User-Agent": "Mozilla/5.0 (supermarket-app probe)"})
            heads = {k: v for k, v in r.headers.items() if k.lower() in ("server", "x-powered-by", "content-type", "x-shopify-stage", "link")}
            out(f"{url} -> {r.status_code} {heads} {r.text[:2500]!r}")
        except Exception as e:  # noqa: BLE001
            out(f"{url} -> error {e!r}")


if __name__ == "__main__":
    main()
