---
title: "Webhooks"
group: "Security & Integration"
order: 7
---

# Webhooks

> A webhook is a reverse API: instead of polling, the provider POSTs an event to a URL you registered, and your job is to verify the signature over the raw body, answer 2xx fast, and process it idempotently.

## What it is
The choice underneath a webhook is push vs pull, and it decides latency, wasted requests, and who opens the connection:

| Dimension | Polling | Webhook |
| --- | --- | --- |
| Who acts | **You** send `GET /events` on a timer | **Provider** POSTs to a URL you registered |
| Freshness | Always **up to one interval stale** | Lands **within seconds** of the event |
| Cost | Burns requests, **mostly empty** responses | One request **per real event** |
| Roles | **Normal** - you are the client | **Flipped** - your endpoint is the server |
| Failure | Miss a tick, **recover next poll** | **At-least-once** - needs retries plus idempotency |

> [!KEY] A webhook is an **inverted API call**: the provider becomes the client and your endpoint becomes the server. Trust nothing until the **HMAC over the raw bytes** verifies.

There is no special protocol. Per **RFC 9110** a POST just asks the target resource to process the enclosed representation under its own semantics, so the entire contract lives in the payload and headers the provider defines. You read their docs, not an RFC.

## Key points
- **Verify authenticity before you trust a byte.** The provider HMAC-signs the request with a **shared secret** and puts the digest in a header. Recompute the HMAC yourself and **constant-time compare** it. A mismatch is a `401`, no exceptions.
- **Sign over the raw body, never a re-serialized copy.** This is the number-one verification bug: your framework parses the JSON, you re-encode it, one byte of whitespace or key order shifts, and the digest no longer matches. **Capture the raw bytes** before anything deserializes them.

The major schemes differ only in the header name and exactly which bytes get signed:

| Scheme | Header | Signs | Encoding |
| --- | --- | --- | --- |
| **Standard Webhooks** | **`webhook-signature`** | **`id.timestamp.body`** | HMAC-SHA256, **`v1,<base64>`** |
| **Stripe** | **`Stripe-Signature`** | **`timestamp.body`** | HMAC-SHA256, **hex** |
| **GitHub** | **`X-Hub-Signature-256`** | **`body` only** | HMAC-SHA256, **hex** |

- **Fold the timestamp into the signed string and reject stale deliveries.** A signature alone does not stop **replay** - a captured valid POST stays valid forever. Standard Webhooks signs `id.timestamp.payload` and expects you to drop anything outside a **tolerance window** (Stripe defaults to 5 minutes). Never set the tolerance to `0`, or normal clock skew fails every request.
- **Ack fast with a 2xx, then do the work off the request path.** Budgets are tight - Stripe treats a slow handler as a failure, with a practical ceiling around **20 seconds**. Validate, enqueue, return. **`202 Accepted`** is the honest code (RFC 9110: accepted for processing, not yet complete), though any 2xx passes.
- **Assume retries, so stay idempotent.** Any non-2xx or timeout triggers **redelivery** - Stripe retries with exponential backoff for up to three days. The **event id is stable** across retries, so use it as your dedupe key. This is the receiver-side mirror of the sender's `Idempotency-Key` header (still an IETF draft, `draft-ietf-httpapi-idempotency-key-header`).
- **Never assume ordering or exactly-once.** Delivery is **at-least-once**: events arrive duplicated, out of order, or interleaved. Dedupe on the id, and when order matters compare the event's own version or timestamp and **drop stale updates** instead of trusting arrival order.
- **Lock the endpoint down.** HTTPS only, and support **zero-downtime secret rotation** - Standard Webhooks and Stripe carry a space-delimited list of signatures so the old and new secret both validate during a rollover.

> [!TIP] Prove your dedupe path before shipping. Most providers ship a replay button or CLI (`stripe trigger`, GitHub's "Redeliver") that re-fires a real delivery, so you can watch a duplicate hit your handler and get dropped.

## Example
```python
import hmac, hashlib, time, base64, json

TOLERANCE = 300  # seconds; anything older is treated as a replay

def verify(body: bytes, headers, secret: bytes) -> bool:
    ts = headers["webhook-timestamp"]
    if abs(time.time() - int(ts)) > TOLERANCE:
        return False                                          # note: stale delivery, likely replayed
    signed = f"{headers['webhook-id']}.{ts}.".encode() + body # sign the RAW bytes, not re-serialized JSON
    expected = hmac.new(secret, signed, hashlib.sha256).digest()
    # header is a space-delimited list ("v1,<b64> v1,<b64>") so rotation keeps old + new valid
    for part in headers["webhook-signature"].split():
        _, _, sig = part.partition(",")
        if hmac.compare_digest(expected, base64.b64decode(sig)):   # constant-time compare
            return True
    return False

@app.post("/webhook")
def webhook():
    body = request.get_data()                     # good: raw bytes; avoid: request.json (it re-parses)
    if not verify(body, request.headers, SECRET):
        return "", 401
    event = json.loads(body)                       # safe to parse now, after the signature checks out
    if first_time(event["id"]):                    # atomic claim (INSERT ... ON CONFLICT / Redis SETNX)
        enqueue(event)                             # heavy work runs on a worker, not this request
    return "", 202                                 # accepted for processing (RFC 9110); any 2xx works
```

## Interview Q&A
- **What is a webhook, and when do you pick it over polling?** A provider-initiated POST to your URL when an event fires. Reach for it when you need near-real-time reaction and the event rate is bursty or unpredictable. Keep polling only when you own both sides and want something dead simple, or the provider offers no hook - your poll interval is the floor on latency and the ceiling on wasted calls.
- **How do you know a delivery is genuine?** Recompute the HMAC over the **raw body** (plus id and timestamp, exactly as the provider specifies) with the shared secret, and constant-time compare against the header. Then reject anything outside the timestamp tolerance so an old capture cannot be replayed.
- **Why must the handler be idempotent, and how?** Retries on any non-2xx or timeout mean the same event lands more than once. Dedupe on the provider's stable event id with an **atomic claim** - a unique constraint with `INSERT ... ON CONFLICT`, or a Redis `SETNX`. A check-then-insert races two concurrent deliveries and lets both through.
- **Your handler needs three seconds of work - what do you return?** A 2xx immediately (`202` is the precise one), and push the work onto a queue. Blocking the response burns the provider's timeout budget and earns a retry storm, which idempotency then has to clean up.

## Gotchas
> [!WARN] Verifying against **re-serialized JSON instead of the raw bytes** is the classic false negative. In Express add `express.raw()` on the webhook route. In Flask read `request.get_data()` before anything touches `request.json`.

> [!WARN] Deduping with **check-then-insert instead of an atomic upsert** double-processes: two retries racing each other both pass the "have I seen this id?" check, then both insert. Claim the id atomically with `INSERT ... ON CONFLICT DO NOTHING` or `SETNX`.

- **Comparing signatures with `==`.** Use a constant-time compare like `hmac.compare_digest`. A plain string compare leaks timing.
- **A signature check with no timestamp check.** You have authenticated the payload but not its freshness, so a replayed capture sails through. Sign the timestamp too and keep a tolerance window, just not `0`. GitHub's `X-Hub-Signature-256` signs the body only, so lean on its `X-GitHub-Delivery` id for dedupe.
- **Treating delivery as exactly-once and in-order.** Dedupe by id, and use the event's version or timestamp to resolve ordering.
- **Doing the real work inside the handler.** Timeouts become retries become duplicates. Ack fast, process async.

## Revise next
- **[AuthN vs AuthZ](authn-authz-oauth-jwt.md)**: HMAC signatures prove who sent the request, bearer tokens and scopes decide what they may do.
- **[Idempotency keys](idempotency-http-methods.md), retries, and exponential backoff**: the sender-side `Idempotency-Key` contract that mirrors the dedupe you do on receipt.
- **[Message queues](../task-processing/message-brokers-redis-rabbitmq-sqs.md) and event-driven design**: the durable buffer that lets you return 2xx now and process the event later.

*Reviewed against RFC 9110, the IETF Idempotency-Key draft, and the Standard Webhooks spec (Stripe and GitHub as references), July 2026.*
