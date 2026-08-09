# Python SDK

A minimal client for the Crypto Payment Gateway (USDT / BEP20) using `requests`
and the standard-library `hmac` / `hashlib`.

- Merchant endpoints authenticate with **API key + HMAC-SHA256 signature**.
- Webhooks are verified with a **per-client webhook secret**.

## Auth scheme (must match exactly)

Every merchant request sends three headers:

| Header        | Value                                                              |
|---------------|-------------------------------------------------------------------|
| `X-Api-Key`   | Your public API key (e.g. `pk_live_...`)                           |
| `X-Timestamp` | Current unix time **in seconds**                                  |
| `X-Signature` | `hex( HMAC_SHA256( secret, f"{timestamp}.{raw_json_body}" ) )`     |

Rules:

- Sign the **exact raw JSON string** you send. Serialize once, sign that string,
  and send that same string as the body — do not let `requests` re-serialize it
  (pass `data=`, not `json=`).
- For GET requests with no body, the raw body is the **empty string** `""`, so
  you sign `f"{timestamp}."`.
- Timestamps more than **5 minutes** (300 s) off the server clock are rejected
  (replay protection). Keep the clock NTP-synced.


## Two key modes

Your account can hold API keys of two kinds. Pick per integration in the Client
Panel → API Keys.

| | **HMAC-signed** (`pk_live_…`) | **Bearer** (`ak_live_…`) |
|---|---|---|
| Headers | `X-Api-Key` + `X-Timestamp` + `X-Signature` | `X-Api-Key` only |
| Secret on the wire | Never | Every request |
| `payouts:write` | Yes | **Never granted** |
| Use for | Production; anything that moves money | Storefront plugins, prototypes |

A bearer key is one opaque token sent alone — no signing:

```
X-Api-Key: ak_live_3ea4f5c5e51ad13eba4ed653a8de1ffd197db3af17b81cf218c20b8d7f93f8eb
Content-Type: application/json
```

The trade-off is real: that token is on the wire on every call, so it lands in
proxy logs, shell history and screenshots. The gateway compensates by refusing to
grant it `payouts:write` — a leaked bearer key can create payments and read your
data, but **cannot move funds**. Pair it with an IP allowlist (Settings → IP
allowlist), which is enforced on every request when non-empty.

**Do not mix the modes.** Sending an HMAC key without a signature, or a bearer
token with one, is rejected with 401 rather than falling back — a silent
fallback would let anyone downgrade to the weaker path by omitting headers.

Whichever you use, no API key can change your payout wallet, your password or
your set of keys. Those require a signed-in dashboard session, which is what
stops a leaked credential from redirecting your settlements.


## Install

```bash
pip install requests
# hmac, hashlib, json are in the standard library
```

## `GatewayClient`

```python
# gateway_client.py
import hmac
import hashlib
import json
import time
from urllib.parse import quote

import requests


class GatewayClient:
    def __init__(self, api_key, api_secret,
                 base_url="http://localhost:4000/api/v1", timeout=15):
        if not api_key or not api_secret:
            raise ValueError("api_key and api_secret are required")
        self.api_key = api_key
        self.api_secret = api_secret.encode("utf-8")
        self.base_url = base_url.rstrip("/")
        self.timeout = timeout
        self.session = requests.Session()

    def _sign(self, timestamp, raw_body):
        """HMAC-SHA256 over '{timestamp}.{raw_body}' -> hex."""
        msg = f"{timestamp}.{raw_body}".encode("utf-8")
        return hmac.new(self.api_secret, msg, hashlib.sha256).hexdigest()

    def _request(self, method, path, body=None, query=None, extra_headers=None):
        # Serialize ONCE, sign that exact string, send that exact string.
        raw_body = "" if body is None else json.dumps(body, separators=(",", ":"))
        timestamp = str(int(time.time()))
        signature = self._sign(timestamp, raw_body)

        headers = {
            "Content-Type": "application/json",
            "X-Api-Key": self.api_key,
            "X-Timestamp": timestamp,
            "X-Signature": signature,
        }
        if extra_headers:
            headers.update(extra_headers)

        resp = self.session.request(
            method,
            f"{self.base_url}{path}",
            params=query,
            data=None if raw_body == "" else raw_body,  # send the signed string
            headers=headers,
            timeout=self.timeout,
        )
        resp.raise_for_status()
        return resp.json() if resp.content else {}

    # ---- Payments ----------------------------------------------------------
    def create_payment(self, amount, order_id, description=None, idempotency_key=None):
        extra = {"Idempotency-Key": idempotency_key} if idempotency_key else None
        body = {"amount": amount, "orderId": order_id}
        if description is not None:
            body["description"] = description
        return self._request("POST", "/payments", body=body, extra_headers=extra)

    def get_payment(self, payment_id):
        return self._request("GET", f"/payments/{quote(payment_id)}")

    def list_payments(self, status=None, page=1, limit=25):
        query = {"page": page, "limit": limit}
        if status:
            query["status"] = status
        return self._request("GET", "/payments", query=query)

    # ---- Account & payouts -------------------------------------------------
    def get_balance(self):
        return self._request("GET", "/balance")

    def request_payout(self, amount):
        return self._request("POST", "/payouts", body={"amount": amount})
```

## Usage examples

```python
# examples.py
import os
from gateway_client import GatewayClient

client = GatewayClient(
    api_key=os.environ["GATEWAY_API_KEY"],
    api_secret=os.environ["GATEWAY_API_SECRET"],
    base_url=os.environ.get("GATEWAY_BASE_URL", "http://localhost:4000/api/v1"),
)

# 1) Create a payment (idempotency key prevents double-charge on retry)
payment = client.create_payment(
    amount="50.00",
    order_id="order_789",
    description="Order #789 — Pro plan",
    idempotency_key="order_789",
)
print("Pay to:", payment["address"])
print("Status:", payment["status"])        # waiting
print("Expires:", payment["expiresAt"])
# payment["qrCode"] is a base64 data URI for an <img> tag

# 2) Retrieve a single payment
fresh = client.get_payment(payment["paymentId"])
print("Now:", fresh["status"], fresh["confirmations"], "confs")

# 3) List recent confirmed payments
result = client.list_payments(status="confirmed", page=1, limit=25)
print("Total confirmed:", result["total"])

# 4) Balance + payout
balance = client.get_balance()
print(f"Available: {balance['available']} {balance['currency']}")
if float(balance["available"]) > 0:
    client.request_payout(amount=balance["available"])
    print("Payout queued.")
```

## Flask webhook receiver

The gateway `POST`s a JSON body to your `webhook_url` when a payment reaches
`confirmed`. The `signature` field = `hex HMAC-SHA256` of the **raw JSON body**
using **your webhook secret**. Verify over the **raw bytes** and compare in
**constant time**.

```python
# webhook_server.py
import hmac
import hashlib
import json
import os

from flask import Flask, request, jsonify

WEBHOOK_SECRET = os.environ["GATEWAY_WEBHOOK_SECRET"].encode("utf-8")

app = Flask(__name__)


def verify(raw_bytes, secret):
    """
    The gateway computes `signature` as HMAC over the body with the signature
    field emptied, then fills in the digest. Recompute over the same canonical
    form and compare in constant time.
    """
    parsed = json.loads(raw_bytes)
    provided = parsed.get("signature", "")
    unsigned = json.dumps({**parsed, "signature": ""}, separators=(",", ":"))
    expected = hmac.new(secret, unsigned.encode("utf-8"), hashlib.sha256).hexdigest()
    return hmac.compare_digest(expected, provided), parsed


@app.post("/webhooks/gateway")
def gateway_webhook():
    ok, parsed = verify(request.get_data(), WEBHOOK_SECRET)
    if not ok:
        return jsonify(error="invalid_signature"), 401

    # Signature valid — handle idempotently (retries are possible).
    if parsed.get("event") == "payment.confirmed":
        print("Confirmed",
              parsed["paymentId"], parsed["orderId"],
              parsed["amount"], parsed.get("txHash"))
        # fulfill the order; make it idempotent on parsed["paymentId"]

    # Ack quickly with 200 so the gateway stops retrying.
    return jsonify(received=True), 200


if __name__ == "__main__":
    app.run(port=3000)
```

> Verify against the same canonical form your gateway signs. Whatever the form,
> always: verify over the **raw** received bytes, use the **webhook secret**
> (never the API secret), and compare with `hmac.compare_digest`.

## Runnable snippet

Save as `snippet.py`, then
`GATEWAY_API_KEY=... GATEWAY_API_SECRET=... python snippet.py`.

```python
import hmac, hashlib, json, os, time
import requests

BASE = os.environ.get("GATEWAY_BASE_URL", "http://localhost:4000/api/v1")
KEY = os.environ["GATEWAY_API_KEY"]
SECRET = os.environ["GATEWAY_API_SECRET"].encode()


def create_payment(amount, order_id):
    raw = json.dumps({"amount": amount, "orderId": order_id}, separators=(",", ":"))
    ts = str(int(time.time()))
    sig = hmac.new(SECRET, f"{ts}.{raw}".encode(), hashlib.sha256).hexdigest()
    r = requests.post(
        f"{BASE}/payments",
        data=raw,
        headers={
            "Content-Type": "application/json",
            "X-Api-Key": KEY,
            "X-Timestamp": ts,
            "X-Signature": sig,
            "Idempotency-Key": order_id,
        },
        timeout=15,
    )
    r.raise_for_status()
    return r.json()


p = create_payment("50.00", f"order_{int(time.time())}")
print("Send USDT to:", p["address"], "| status:", p["status"])
```
