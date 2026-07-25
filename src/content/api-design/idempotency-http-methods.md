---
title: "Idempotency (HTTP)"
group: "REST Fundamentals"
order: 2
---

# Idempotency (Which HTTP Methods Are Idempotent?)

> A method is idempotent when firing the same request once or a hundred times leaves the server in the same final state. RFC 9110 makes GET, HEAD, OPTIONS, TRACE, PUT, and DELETE idempotent while POST and PATCH are not, and that one property decides whether a request that timed out is safe to just resend.

## What it is
A per-method promise in HTTP (RFC 9110, section 9.2.2): the intended effect of **N identical requests** on the server is the same as for **one**. Run it once or ten times and the resource lands in the same place.

Why it matters: networks lose responses. A request can succeed on the server while the caller sees only a timeout. If the method is idempotent, the client (or a retry library, or a queue redelivering a job) can resend and nothing breaks. If it is not, a blind retry double-charges the card.

> [!KEY] Idempotency is a promise about **server state after N identical requests**, never about the **response you get back**. A retry that returns a fresh 404 or a replayed 201 is still perfectly idempotent.

Each method's guarantees fall straight out of RFC 9110, sections 9.2.1 (safe), 9.2.2 (idempotent), and 9.2.3 (cacheable):

| Method | Safe | Idempotent | Cacheable |
| --- | --- | --- | --- |
| GET, HEAD | **Yes** | Yes | Yes |
| OPTIONS, TRACE | **Yes** | Yes | No |
| PUT | No | **Yes** | No |
| DELETE | No | **Yes** | No |
| POST | No | **No** | Only if marked fresh |
| PATCH | No | **No** | No |
| CONNECT | No | **No** | No |

Safe methods change no state at all, which is why GET and HEAD responses are cacheable and prefetchable. POST responses are cacheable per RFC 9110 only when explicitly marked fresh, so real caches store only GET and HEAD.

> [!TIP] Mnemonic: the idempotent set is **the four safe methods plus PUT and DELETE**. The methods that create or partially mutate, POST and PATCH, are exactly the ones left out.

## Key points
- **Safe** is the stricter subset: GET, HEAD, OPTIONS, TRACE change no state, so every safe method is idempotent. The reverse fails - PUT and DELETE do write, they just converge to the same result each time.
- **DELETE stays idempotent even when the second call 404s.** After one delete or five the resource is gone and stays gone, so the state is identical. The 404 is information, not a side effect. This one trips people up, so have the answer ready.
- **PATCH is not idempotent in general** (RFC 5789 says so outright). A patch that sets a field is idempotent by luck. A patch that says "increment balance by 10" is not. Force the guarantee with a conditional request: send `If-Match` with the ETag you read, so a stale second attempt fails the precondition instead of applying twice.
- The three write methods differ on what each one promises:

| Aspect | PUT | POST | PATCH |
| --- | --- | --- | --- |
| Effect | **Replace** the whole resource | **Create or process** under the resource's rules | **Partial** update |
| Idempotent? | **Yes** | **No** | **No** (payload-dependent) |
| Typical target | A **known** resource URI | A **collection** endpoint | An **existing** resource |

- The `Idempotency-Key` retry pattern: the client generates a UUID key and the server dedupes on it. The first request runs and its response is stored under the key, later retries carrying the same key replay that stored response. The server sets the key's **scope and retention**, so a replay is only guaranteed inside that window. This is the **Stripe pattern**, now written up in an IETF draft.

## Example
```http
# first attempt
POST /v1/payments HTTP/1.1
Idempotency-Key: "5f3a1c9e-3b2a-4c1d-9e8f-7a6b5c4d3e2f"
Content-Type: application/json

{ "amount": 5000, "currency": "usd" }

# 201 Created, charged once. The server records this response under the key.
```

The IETF Idempotency-Key draft pins each retry scenario to a status code:

| Retry scenario | Server response |
| --- | --- |
| Same key, same body, original still running | **409 Conflict** |
| Same key, same body, original completed | **Replays the stored 201** (no second charge) |
| Same key, **different** body | **422 Unprocessable Content** |
| Required key missing | **400 Bad Request** |

The draft models the value as a structured-field String (RFC 8941), so it is double-quoted as shown. Real deployments vary: Stripe sends the same header unquoted, so match your provider rather than the draft's punctuation.

## Interview Q&A
- **Which methods are idempotent?** GET, HEAD, OPTIONS, TRACE, PUT, DELETE. POST and PATCH are not. The quick mnemonic is "the safe methods, plus PUT and DELETE."
- **Safe vs idempotent?** Safe means no state change at all (GET, HEAD, OPTIONS, TRACE), which is what makes a response cacheable. Idempotent means repeatable to the same end state, which also covers the writes PUT and DELETE. Safe is a subset of idempotent.
- **Why is DELETE idempotent if the second call 404s?** Because idempotency is defined on server state, not the response. The resource is gone after the first call and stays gone. The 404 just reports that it was already gone.
- **How do you make a POST safe to retry?** The client sends an `Idempotency-Key`. The server processes once, stores the result under the key, and replays it on any retry carrying the same key. Reject a reused key that arrives with a different body.
- **Is PATCH idempotent?** Not by default. It depends on the payload, and an increment is the classic non-idempotent case. Gate it with `If-Match` and an ETag when you need the guarantee.

## Gotchas
> [!WARN] **POST is not idempotent** - retrying one with no key is exactly how you get double charges and duplicate orders. Anything that moves money or creates a record needs an `Idempotency-Key`, especially behind a queue or an HTTP client that retries on its own.

> [!WARN] **Idempotent does not mean "returns the same response," and it is not a free pass for side effects.** Body and status can differ across retries, only server state has to converge. If your PUT handler also fires a webhook or appends an audit row on every call, those extra effects are yours to dedupe. RFC 9110 explicitly lets a server log or version each request.

- The `Idempotency-Key` header is still an IETF draft (draft-07), not a ratified RFC, and that latest version expired in April 2026. Build against whatever your provider actually ships (Stripe, PayPal, Shopify each have their own flavor) rather than assuming the header is universal.
- gRPC and GraphQL do not inherit idempotency from the HTTP method, because everything rides on POST. gRPC leaves it to you: a retry policy lists retryable status codes (such as `UNAVAILABLE`) and trusts that you only enabled retries on calls whose effect is actually idempotent. GraphQL runs every mutation through one POST endpoint and executes top-level mutation fields serially, so dedup lives in the payload (a `clientMutationId` or a key in the input), not in a header.

## Revise next
- [REST and HTTP methods / status codes](rest-http-methods-status-codes.md) (RFC 9110)
- [Rate limiting](rate-limiting.md), retries, and exponential backoff (the IETF RateLimit header draft, `Retry-After`)
- [Background-task idempotency](../task-processing/idempotency-background-tasks.md) (Celery and queue consumers)

*Reviewed against HTTP RFC 9110 (section 9.2.2), RFC 5789 (PATCH), and the IETF Idempotency-Key header draft-07, July 2026.*
