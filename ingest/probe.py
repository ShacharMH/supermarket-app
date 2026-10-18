"""One-off diagnostics that need the network GitHub Actions has. Results go to
ingest_log as 'probe ...' rows."""

from __future__ import annotations

import os
import sys
from collections import Counter

import psycopg

sys.path.insert(0, os.path.dirname(__file__))
import hahishook  # noqa: E402


def main() -> None:
    conn = psycopg.connect(os.environ["SUPABASE_DB_URL"], autocommit=True, prepare_threshold=None)

    def out(msg: str) -> None:
        print(msg)
        conn.execute("insert into ingest_log (msg) values (%s)", (f"probe {msg[:3500]}",))

    day, text = hahishook.fetch_tsv()
    lines = text.splitlines()
    cols = [l.split("\t") for l in lines]
    out(f"hahishook {day}: {len(lines)} lines; widths {Counter(len(c) for c in cols).most_common(5)}")
    out(f"col0 digit: {sum(c[0].strip().isdigit() for c in cols)}; col11 values {Counter(c[11].strip() if len(c) > 11 else None for c in cols).most_common(6)}")
    out(f"col1 numeric>0: {sum(1 for c in cols if hahishook._num(c[1] if len(c) > 1 else ''))}; col2: {sum(1 for c in cols if len(c) > 2 and hahishook._num(c[2]))}")
    out(f"parsed items: {len(hahishook.parse(text))}")
    odd = [l for l in lines if len(l.split('\t')) < 10][:3]
    out("short lines: " + repr(odd)[:3000])


if __name__ == "__main__":
    main()
