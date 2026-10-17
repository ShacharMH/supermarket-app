"""Tolerant parsers for the price-transparency XML files.

Chains publish the same logical data with different casing and nesting
(e.g. Shufersal uses <STORE><STOREID>, Cerberus chains use <Store><StoreId>,
some use <Product> instead of <Item>). Rather than hard-coding paths we look
for any element whose children contain the key field, and read children
case-insensitively.
"""

from __future__ import annotations

import re
from datetime import datetime
from typing import Iterator
from zoneinfo import ZoneInfo

from lxml import etree

TLV = ZoneInfo("Asia/Jerusalem")


def _local(tag) -> str:
    if not isinstance(tag, str):
        return ""
    return tag.rsplit("}", 1)[-1].lower()


def _fields(el) -> dict[str, str]:
    out: dict[str, str] = {}
    for child in el:
        key = _local(child.tag)
        if key and len(child) == 0 and key not in out:
            out[key] = (child.text or "").strip()
    return out


def _records(path: str, key: str) -> Iterator[tuple[etree._Element, dict[str, str]]]:
    """Yield (element, fields) for every element that has a direct child named `key`."""
    parser = etree.XMLParser(recover=True, huge_tree=True)
    root = etree.parse(path, parser).getroot()
    for el in root.iter():
        if any(_local(c.tag) == key for c in el):
            yield el, _fields(el)


def _root_fields(path: str) -> dict[str, str]:
    parser = etree.XMLParser(recover=True, huge_tree=True)
    root = etree.parse(path, parser).getroot()
    out: dict[str, str] = {}
    for el in root.iter():
        key = _local(el.tag)
        if key in ("chainid", "subchainid", "storeid", "chainname") and key not in out and el.text:
            out[key] = el.text.strip()
    return out


def _num(value: str | None) -> float | None:
    if value is None:
        return None
    value = value.strip().replace(",", "")
    if not value:
        return None
    try:
        return float(value)
    except ValueError:
        return None


def _first(f: dict[str, str], *keys: str) -> str | None:
    for k in keys:
        v = f.get(k)
        if v:
            return v
    return None


def _dt(date: str | None, time: str | None = None) -> datetime | None:
    if not date:
        return None
    date = date.strip()
    time = (time or "00:00:00").strip()
    for fmt in ("%Y-%m-%d %H:%M:%S", "%Y-%m-%d %H:%M", "%Y/%m/%d %H:%M:%S", "%d/%m/%Y %H:%M:%S"):
        try:
            return datetime.strptime(f"{date[:10]} {time[:8]}", fmt).replace(tzinfo=TLV)
        except ValueError:
            continue
    return None


# ---------------------------------------------------------------- stores

def parse_stores(path: str) -> list[dict]:
    meta = _root_fields(path)
    stores = []
    for _, f in _records(path, "storeid"):
        store_id = f.get("storeid")
        if not store_id or not store_id.isdigit():
            continue
        store_type = f.get("storetype", "")
        name = f.get("storename") or ""
        stores.append(
            {
                "chain_id": f.get("chainid") or meta.get("chainid"),
                "chain_name": f.get("chainname") or meta.get("chainname"),
                "sub_chain_id": f.get("subchainid") or meta.get("subchainid"),
                "store_id": str(int(store_id)),
                "name": name,
                "address": f.get("address"),
                "city": f.get("city"),
                "zip_code": f.get("zipcode"),
                # StoreType: 1 = physical, 2 = online, 3 = both
                "is_online": store_type == "2"
                or bool(re.search(r"אונליין|online|אינטרנט|משלוח", name, re.I)),
            }
        )
    return stores


# ---------------------------------------------------------------- prices

def is_gtin(code: str) -> bool:
    """True for a real EAN-8 / UPC-A / EAN-13 barcode (valid check digit)."""
    if not code.isdigit() or len(code) not in (8, 12, 13):
        return False
    digits = [int(c) for c in code]
    check = digits.pop()
    total = sum(d * (3 if i % 2 == 0 else 1) for i, d in enumerate(reversed(digits)))
    return (10 - total % 10) % 10 == check


def norm_barcode(code: str, chain_id: str | None) -> str:
    """Real barcodes are comparable across chains; anything else is a chain-internal
    code (produce, bakery...) and gets namespaced by chain."""
    code = code.strip().lstrip("0")
    if is_gtin(code) or (len(code) >= 11 and is_gtin(code.zfill(13))):
        return code
    return f"{chain_id or 'x'}:{code}"


UNKNOWN = {"לא ידוע", "לא ידוע.", "unknown", "כללי", "-", "0", "tbd", ",", ""}


def _known(v: str | None) -> str | None:
    return None if v is None or v.strip().lower() in UNKNOWN else v.strip()


def parse_prices(path: str) -> tuple[dict, list[dict]]:
    meta = _root_fields(path)
    items = []
    for _, f in _records(path, "itemcode"):
        raw = (f.get("itemcode") or "").strip()
        price = _num(f.get("itemprice"))
        if not raw.strip("0") or price is None or price <= 0:
            continue
        # ItemType is unreliable across chains, so decide by the code itself.
        barcode = norm_barcode(raw, meta.get("chainid"))
        weighted = f.get("bisweighted", "0") in ("1", "true")
        if weighted and ":" not in barcode:
            # weighed goods use chain-internal codes even when they look like a real
            # barcode (7290000046181 is grapes in one chain, Emek cheese in another)
            barcode = f"{meta.get('chainid') or 'x'}:{barcode}"
        items.append(
            {
                "barcode": barcode,
                "plain_code": norm_barcode(raw, meta.get("chainid")),
                "name": _first(f, "itemname", "itemnm", "manufactureritemdescription") or barcode,
                "manufacturer": _known(_first(f, "manufacturername", "manufacturename")),
                "quantity": _num(f.get("quantity")),
                "unit_of_measure": _first(f, "unitqty", "unitofmeasure"),
                "is_weighted": weighted,
                "price": round(price, 2),
                "unit_price": _num(_first(f, "unitofmeasureprice")),
            }
        )
    return meta, items


# ---------------------------------------------------------------- promotions

def parse_promos(path: str) -> tuple[dict, list[dict]]:
    meta = _root_fields(path)
    promos = []
    for el, f in _records(path, "promotionid"):
        barcodes = []
        clubs = []
        for sub in el.iter():
            key = _local(sub.tag)
            if key == "itemcode" and sub.text and sub.text.strip().strip("0"):
                barcodes.append(norm_barcode(sub.text, meta.get("chainid")))
            elif key == "clubid" and sub.text:
                clubs.append(sub.text.strip())
        if not barcodes:
            continue
        rate = _num(f.get("discountrate"))
        if rate is not None and rate > 100:  # some chains send hundredths of a percent
            rate = rate / 100
        promos.append(
            {
                "promotion_id": f["promotionid"],
                "description": f.get("promotiondescription"),
                "starts_at": _dt(f.get("promotionstartdate"), f.get("promotionstarthour")),
                "ends_at": _dt(f.get("promotionenddate"), f.get("promotionendhour")),
                "min_qty": _num(f.get("minqty")),
                "max_qty": _num(f.get("maxqty")),
                "discounted_price": _num(f.get("discountedprice")),
                "discount_rate": rate,
                "reward_type": int(f["rewardtype"]) if (f.get("rewardtype") or "").isdigit() else None,
                # ClubId 0 = all customers; anything else = club / card holders only
                "club_ids": sorted(set(clubs)),
                "is_club_only": bool(clubs) and "0" not in clubs,
                "barcodes": sorted(set(b for b in barcodes if b)),
            }
        )
    return meta, promos
