# PHP SDK

A minimal client for the Crypto Payment Gateway (USDT / BEP20) using `curl` and
`hash_hmac`. No external dependencies required.

- Merchant endpoints authenticate with **API key + HMAC-SHA256 signature**.
- Webhooks are verified with a **per-client webhook secret**.

## Auth scheme (must match exactly)

Every merchant request sends three headers:

| Header        | Value                                                              |
|---------------|-------------------------------------------------------------------|
| `X-Api-Key`   | Your public API key (e.g. `pk_live_...`)                           |
| `X-Timestamp` | Current unix time **in seconds**                                  |
| `X-Signature` | `hash_hmac('sha256', "{$timestamp}.{$rawJsonBody}", $secret)`      |

Rules:

- Sign the **exact raw JSON string** you send. Build the body string once, sign
  it, and `POST` that same string.
- For GET requests with no body, the raw body is the **empty string** `''`, so
  you sign `"{$timestamp}."`.
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


## `GatewayClient`

```php
<?php
// GatewayClient.php

class GatewayException extends \RuntimeException {}

class GatewayClient
{
    private string $apiKey;
    private string $apiSecret;
    private string $baseUrl;
    private int $timeout;

    public function __construct(
        string $apiKey,
        string $apiSecret,
        string $baseUrl = 'http://localhost:4000/api/v1',
        int $timeout = 15
    ) {
        if ($apiKey === '' || $apiSecret === '') {
            throw new \InvalidArgumentException('apiKey and apiSecret are required');
        }
        $this->apiKey    = $apiKey;
        $this->apiSecret = $apiSecret;
        $this->baseUrl   = rtrim($baseUrl, '/');
        $this->timeout   = $timeout;
    }

    /** HMAC-SHA256 over "{timestamp}.{rawBody}" -> hex. */
    private function sign(string $timestamp, string $rawBody): string
    {
        return hash_hmac('sha256', $timestamp . '.' . $rawBody, $this->apiSecret);
    }

    /**
     * Core signed request.
     * @param array<string,mixed>|null $body  JSON body (POST/PUT)
     * @param array<string,mixed> $query      query params (GET)
     * @param array<string,string> $extra     extra headers
     * @return array<string,mixed>
     */
    private function request(
        string $method,
        string $path,
        ?array $body = null,
        array $query = [],
        array $extra = []
    ): array {
        // Serialize ONCE, sign that exact string, send that exact string.
        $rawBody = $body === null ? '' : json_encode($body, JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE);
        $timestamp = (string) time();
        $signature = $this->sign($timestamp, $rawBody);

        $url = $this->baseUrl . $path;
        if (!empty($query)) {
            $url .= '?' . http_build_query($query);
        }

        $headers = [
            'Content-Type: application/json',
            'X-Api-Key: ' . $this->apiKey,
            'X-Timestamp: ' . $timestamp,
            'X-Signature: ' . $signature,
        ];
        foreach ($extra as $k => $v) {
            $headers[] = "$k: $v";
        }

        $ch = curl_init($url);
        curl_setopt_array($ch, [
            CURLOPT_CUSTOMREQUEST  => $method,
            CURLOPT_RETURNTRANSFER => true,
            CURLOPT_HTTPHEADER     => $headers,
            CURLOPT_TIMEOUT        => $this->timeout,
        ]);
        if ($rawBody !== '') {
            curl_setopt($ch, CURLOPT_POSTFIELDS, $rawBody); // send the signed string
        }

        $responseBody = curl_exec($ch);
        if ($responseBody === false) {
            $err = curl_error($ch);
            curl_close($ch);
            throw new GatewayException("cURL error: $err");
        }
        $statusCode = curl_getinfo($ch, CURLINFO_RESPONSE_CODE);
        curl_close($ch);

        $decoded = $responseBody === '' ? [] : json_decode($responseBody, true);
        if ($statusCode >= 400) {
            $msg = is_array($decoded) ? ($decoded['message'] ?? $decoded['error'] ?? 'error') : 'error';
            throw new GatewayException("HTTP $statusCode: $msg");
        }
        return is_array($decoded) ? $decoded : [];
    }

    // ---- Payments ----------------------------------------------------------
    public function createPayment(
        string $amount,
        string $orderId,
        ?string $description = null,
        ?string $idempotencyKey = null
    ): array {
        $body = ['amount' => $amount, 'orderId' => $orderId];
        if ($description !== null) {
            $body['description'] = $description;
        }
        $extra = $idempotencyKey ? ['Idempotency-Key' => $idempotencyKey] : [];
        return $this->request('POST', '/payments', $body, [], $extra);
    }

    public function getPayment(string $paymentId): array
    {
        return $this->request('GET', '/payments/' . rawurlencode($paymentId));
    }

    public function listPayments(?string $status = null, int $page = 1, int $limit = 25): array
    {
        $query = ['page' => $page, 'limit' => $limit];
        if ($status !== null) {
            $query['status'] = $status;
        }
        return $this->request('GET', '/payments', null, $query);
    }

    // ---- Account & payouts -------------------------------------------------
    public function getBalance(): array
    {
        return $this->request('GET', '/balance');
    }

    public function requestPayout(string $amount): array
    {
        return $this->request('POST', '/payouts', ['amount' => $amount]);
    }
}
```


## Usage examples

```php
<?php
// examples.php
require __DIR__ . '/GatewayClient.php';

$client = new GatewayClient(
    getenv('GATEWAY_API_KEY'),
    getenv('GATEWAY_API_SECRET'),
    getenv('GATEWAY_BASE_URL') ?: 'http://localhost:4000/api/v1'
);

// 1) Create a payment (idempotency key prevents double-charge on retry)
$payment = $client->createPayment('50.00', 'order_789', 'Order #789 — Pro plan', 'order_789');
echo "Pay to: {$payment['address']}\n";
echo "Status: {$payment['status']}\n";          // waiting
echo "Expires: {$payment['expiresAt']}\n";
// $payment['qrCode'] is a base64 data URI for an <img> tag

// 2) Retrieve a single payment
$fresh = $client->getPayment($payment['paymentId']);
echo "Now: {$fresh['status']} {$fresh['confirmations']} confs\n";

// 3) List recent confirmed payments
$list = $client->listPayments('confirmed', 1, 25);
echo "Total confirmed: {$list['total']}\n";

// 4) Balance + payout
$balance = $client->getBalance();
echo "Available: {$balance['available']} {$balance['currency']}\n";
if ((float) $balance['available'] > 0) {
    $client->requestPayout($balance['available']);
    echo "Payout queued.\n";
}
```

## Plain PHP webhook receiver

The gateway `POST`s a JSON body to your `webhook_url` when a payment reaches
`confirmed`. The `signature` field = `hex HMAC-SHA256` of the **raw JSON body**
using **your webhook secret**. Verify over the **raw bytes** (`php://input`) and
compare in **constant time** with `hash_equals`.

```php
<?php
// webhook.php  — point your webhook_url at this endpoint

$WEBHOOK_SECRET = getenv('GATEWAY_WEBHOOK_SECRET');

// Read the RAW body exactly as received.
$raw = file_get_contents('php://input');
$parsed = json_decode($raw, true);

if (!is_array($parsed)) {
    http_response_code(400);
    echo json_encode(['error' => 'bad_request']);
    exit;
}

/**
 * The gateway computes `signature` as HMAC over the body with the signature
 * field emptied, then fills in the digest. Recompute over the same canonical
 * form and compare in constant time.
 */
$provided = $parsed['signature'] ?? '';
$unsigned = json_encode(
    array_merge($parsed, ['signature' => '']),
    JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE
);
$expected = hash_hmac('sha256', $unsigned, $WEBHOOK_SECRET);

if (!hash_equals($expected, (string) $provided)) {
    http_response_code(401);
    echo json_encode(['error' => 'invalid_signature']);
    exit;
}

// Signature valid — handle idempotently (retries are possible).
if (($parsed['event'] ?? '') === 'payment.confirmed') {
    error_log(sprintf(
        'Confirmed %s %s %s %s',
        $parsed['paymentId'],
        $parsed['orderId'],
        $parsed['amount'],
        $parsed['txHash'] ?? ''
    ));
    // fulfill the order; make it idempotent on $parsed['paymentId']
}

// Ack quickly with 200 so the gateway stops retrying.
http_response_code(200);
header('Content-Type: application/json');
echo json_encode(['received' => true]);
```

> Verify against the same canonical form your gateway signs. Whatever the form,
> always: verify over the **raw** received bytes, use the **webhook secret**
> (never the API secret), and compare with `hash_equals`.
