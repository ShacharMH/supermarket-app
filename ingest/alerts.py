"""Price-drop alerts, after the nightly load.

compute_price_alerts() (in the database) keeps tonight's lowest price of every product a
user likes and records the ones well below their usual price. This sends each user one
push notification for the new ones. Without VAPID_PRIVATE_KEY nothing is sent: the alerts
still show in the app.
"""

import json
import os
import sys

import psycopg

# the address push services may contact about our notifications (required by the protocol)
VAPID_SUBJECT = "https://shacharmh.github.io"
APP_URL = "./?alerts=1"


def money(n) -> str:
    return f"₪{float(n):.2f}"


def message(rows: list[tuple]) -> dict:
    """One notification for all of a user's new alerts, the biggest saving first."""
    rows = sorted(rows, key=lambda r: float(r[2]) - float(r[1]), reverse=True)
    name, unit, usual, promo, min_qty, chain, branch = rows[0]
    deal = f"{money(unit)} במקום {money(usual)}"
    if min_qty and float(min_qty) > 1:
        deal += f" (בקנייה של {int(min_qty)})"
    body = f"{deal} · {chain} {branch}"
    if len(rows) > 1:
        body += " · ועוד מוצר אחד" if len(rows) == 2 else f" · ועוד {len(rows) - 1} מוצרים"
    return {"title": f"🔔 {name}", "body": body, "url": APP_URL, "tag": "price-drop"}


def send(conn, private_key: str) -> None:
    from pywebpush import WebPushException, webpush  # only needed when sending

    with conn.cursor() as cur:
        cur.execute(
            """select a.user_id, a.id, a.name, a.unit_price, a.usual_price, a.promo, a.min_qty, c.name, b.name
               from price_alerts a
               left join branches b on b.id = a.branch_id left join chains c on c.chain_id = b.chain_id
               where a.sent_at is null and not a.dismissed and a.created_at > now() - interval '1 day'"""
        )
        by_user: dict[str, list] = {}
        for user_id, aid, *rest in cur.fetchall():
            by_user.setdefault(user_id, []).append((aid, rest))

        for user_id, alerts in by_user.items():
            payload = json.dumps(message([r for _aid, r in alerts]), ensure_ascii=False)
            cur.execute("select id, endpoint, p256dh, auth from push_subscriptions where user_id = %s", (user_id,))
            sent = 0
            for sid, endpoint, p256dh, auth in cur.fetchall():
                try:
                    webpush(
                        subscription_info={"endpoint": endpoint, "keys": {"p256dh": p256dh, "auth": auth}},
                        data=payload,
                        vapid_private_key=private_key,
                        vapid_claims={"sub": VAPID_SUBJECT},
                        ttl=12 * 3600,
                    )
                    sent += 1
                except WebPushException as e:
                    code = getattr(e.response, "status_code", None)
                    if code in (404, 410):  # the browser dropped the subscription
                        cur.execute("delete from push_subscriptions where id = %s", (sid,))
                    print(f"push failed ({code}): {e}")
            cur.execute("update price_alerts set sent_at = now() where id = any(%s)", ([aid for aid, _ in alerts],))
            print(f"user {str(user_id)[:8]}: {len(alerts)} alerts, sent to {sent} devices")


def main() -> int:
    with psycopg.connect(os.environ["SUPABASE_DB_URL"], prepare_threshold=None, autocommit=True) as conn:
        with conn.cursor() as cur:
            cur.execute("select compute_price_alerts()")
            print(f"{cur.fetchone()[0]} new price-drop alerts")
        key = os.environ.get("VAPID_PRIVATE_KEY", "").strip()
        if key:
            send(conn, key)
        else:
            print("VAPID_PRIVATE_KEY not set - alerts are shown in the app only")
    return 0


if __name__ == "__main__":
    sys.exit(main())
