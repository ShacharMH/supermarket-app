"""One-off diagnostics that need the network GitHub Actions has (the chains' file
servers, other shops' sites). Results go to ingest_log as 'probe ...' rows."""

from __future__ import annotations

import os
from datetime import datetime, timedelta
from zoneinfo import ZoneInfo

import psycopg
import requests


def main() -> None:
    conn = psycopg.connect(os.environ["SUPABASE_DB_URL"], autocommit=True, prepare_threshold=None)

    def out(msg: str) -> None:
        print(msg)
        for i in range(0, len(msg), 3500):
            conn.execute("insert into ingest_log (msg) values (%s)", (f"probe {msg[i:i + 3500]}",))

    # החישוק: a daily TSV of all products and prices (shared by them for CHP and anyone)
    today = datetime.now(ZoneInfo("Asia/Jerusalem")).date()
    for days in range(0, 3):
        day = (today - timedelta(days=days)).strftime("%Y%m%d")
        for scheme in ("https", "http"):
            url = f"{scheme}://hahishook.com/wp-content/uploads/chp/{day}.tsv"
            try:
                r = requests.get(url, timeout=60, headers={"User-Agent": "supermarket-app (personal price comparison)"})
                lines = r.text.splitlines()
                out(f"{url} -> {r.status_code} {r.headers.get('content-type')} {len(r.content)} bytes, {len(lines)} lines")
                if r.ok and len(lines) > 1:
                    out("head: " + repr("\n".join(lines[:4]))[:3400])
                    widths = sorted({len(l.split('\t')) for l in lines[:500]})
                    out(f"columns per line: {widths}")
                    return
            except Exception as e:  # noqa: BLE001
                out(f"{url} -> error {e!r}")


if __name__ == "__main__":
    main()
