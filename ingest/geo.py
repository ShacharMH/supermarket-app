"""City-name normalisation and geocoding (OpenStreetMap Nominatim)."""

from __future__ import annotations

import math
import re
import time

import requests

USER_AGENT = "supermarket-app/1.0 (github.com/ShacharMH/supermarket-app)"
_last_call = 0.0


def norm_city(city: str | None) -> str:
    if not city:
        return ""
    c = city.strip()
    c = re.sub(r"[\"'`׳״]", "", c)
    c = re.sub(r"[-–_/,.()]", " ", c)
    c = re.sub(r"\s+", " ", c).strip()
    c = c.replace("תל אביב יפו", "תל אביב")
    return c


def haversine_km(lat1, lon1, lat2, lon2) -> float:
    r = 6371.0
    p1, p2 = math.radians(lat1), math.radians(lat2)
    dp, dl = p2 - p1, math.radians(lon2 - lon1)
    a = math.sin(dp / 2) ** 2 + math.cos(p1) * math.cos(p2) * math.sin(dl / 2) ** 2
    return 2 * r * math.asin(math.sqrt(a))


# Nominatim answers with the town itself when it can't find the street
_AREA_TYPES = {"city", "town", "village", "municipality", "county", "state", "region", "country",
               "suburb", "quarter", "neighbourhood", "city_district", "district", "hamlet", "isolated_dwelling"}


def geocode_exact(query: str | None = None, **structured: str) -> tuple[float, float] | None:
    """A street- or place-level point, or None if only the town (or nothing) was found."""
    hits = _search({"q": query} if query else structured)
    if not hits or hits[0].get("addresstype") in _AREA_TYPES:
        return None
    return float(hits[0]["lat"]), float(hits[0]["lon"])


def photon_exact(query: str, near: tuple[float, float] | None = None) -> tuple[float, float] | None:
    """Second opinion from Photon (also OpenStreetMap, but forgiving with spelling)."""
    global _last_call
    wait = 1.1 - (time.time() - _last_call)
    if wait > 0:
        time.sleep(wait)
    _last_call = time.time()
    params: dict = {"q": query, "limit": 1}
    if near:
        params.update(lat=near[0], lon=near[1])
    try:
        r = requests.get("https://photon.komoot.io/api/", params=params, headers={"User-Agent": USER_AGENT}, timeout=20)
        r.raise_for_status()
        feats = r.json().get("features") or []
    except Exception as e:  # noqa: BLE001
        print(f"  photon failed for {query!r}: {e}")
        return None
    if not feats or feats[0]["properties"].get("type") in _AREA_TYPES | {"locality", "district"}:
        return None
    lon, lat = feats[0]["geometry"]["coordinates"]
    return float(lat), float(lon)


def geocode(query: str) -> tuple[float, float] | None:
    """Geocode a free-text Israeli address. Respects Nominatim's 1 req/sec policy."""
    hits = _search({"q": query})
    if not hits:
        return None
    return float(hits[0]["lat"]), float(hits[0]["lon"])


def _search(params: dict) -> list[dict]:
    global _last_call
    wait = 1.1 - (time.time() - _last_call)
    if wait > 0:
        time.sleep(wait)
    _last_call = time.time()
    try:
        r = requests.get(
            "https://nominatim.openstreetmap.org/search",
            params={**params, "format": "jsonv2", "limit": 1, "countrycodes": "il", "accept-language": "he"},
            headers={"User-Agent": USER_AGENT},
            timeout=20,
        )
        r.raise_for_status()
        return r.json()
    except Exception as e:  # noqa: BLE001
        print(f"  geocode failed for {params!r}: {e}")
        return []


def load_city_codes() -> dict[str, str]:
    """Some chains publish the CBS settlement code instead of the city name.
    Returns {code: name} from data.gov.il (empty dict if unavailable)."""
    try:
        r = requests.get(
            "https://data.gov.il/api/3/action/datastore_search",
            params={"resource_id": "5c78e9fa-c2e2-4771-93ff-7f400a12f7ba", "limit": 5000},
            headers={"User-Agent": USER_AGENT},
            timeout=30,
        )
        r.raise_for_status()
        records = r.json()["result"]["records"]
    except Exception as e:  # noqa: BLE001
        print(f"could not load CBS city codes: {e}")
        return {}
    out = {}
    for rec in records:
        code = str(rec.get("סמל_ישוב", "")).strip()
        name = str(rec.get("שם_ישוב", "")).strip()
        if code and name:
            out[str(int(code))] = name
    return out
