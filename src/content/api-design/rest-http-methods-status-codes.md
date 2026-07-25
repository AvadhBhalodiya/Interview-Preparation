---
title: "REST & HTTP Methods"
group: "REST Fundamentals"
order: 1
---

# REST Principles, HTTP Methods & Status Codes

> REST models your domain as resources at stable URIs, acts on them with the standard HTTP verbs, and reports each outcome with an honest status code so a client knows what happened without parsing your error prose.

## What it is
- An architectural style Roy Fielding described in 2000, not a protocol or a library you install. Its whole trick is reusing HTTP's built-in semantics instead of inventing a new vocabulary on top.
- The model has three moving parts: **resources** are the nouns you address by URI, **methods** are the verbs that act on them, and **status codes** are how the server reports the outcome. Get those three honest and most of "good API design" falls out for free.
- Worth saying out loud: almost nothing in production is fully RESTful. The hypermedia constraint (**HATEOAS**) is nearly always dropped, and what people call a "REST API" is usually clean JSON-over-HTTP. That is fine, but naming the gap shows you actually know the model.

> [!KEY] REST is not a framework. It is three honest parts working together: **resources** (nouns at stable URIs), **methods** (the verbs), and **status codes** (the outcome). Reuse HTTP's vocabulary instead of inventing your own on top.

## Key points
- **Stateless** is the load-bearing constraint. Every request carries what the server needs, credentials included, and the server keeps no session between calls. That is exactly what lets ten identical instances sit behind a load balancer without caring which one answers.
- **Name resources as plural nouns, act with the method**: `/users/42/orders`, never `/getUserOrders`. The verb already lives in the HTTP method, so repeating it in the path does the same job twice.

The seven methods, scored on the three properties interviewers actually test - **safe** (read-only, no intended change), **idempotent** (one call or ten leaves the same state), and **cacheable**:

| Method | Purpose | Safe | Idempotent | Cacheable |
| --- | --- | --- | --- | --- |
| `GET` | Read a resource | Yes | Yes | **Yes** |
| `HEAD` | Like `GET` but headers only, no body | Yes | Yes | **Yes** |
| `OPTIONS` | Discover allowed methods / CORS preflight | Yes | Yes | No |
| `POST` | Create, or trigger an action | **No** | **No** | Only if explicitly marked |
| `PUT` | Replace the whole resource | No | **Yes** | No |
| `PATCH` | Partial update (RFC 5789) | No | **No\*** | No |
| `DELETE` | Remove the resource | No | **Yes** | No |

\* `PATCH` can be written to be idempotent, but the spec never promises it - a JSON-Patch `add` to an array appends on every call. `TRACE` is also safe and idempotent but is usually disabled for security.

Every response reports its outcome in the status line. The class (first digit) is the headline, and the exact code is the detail:

| Code | Class | When to use it |
| --- | --- | --- |
| `200 OK` | 2xx success | Succeeded and a body follows |
| `201 Created` | 2xx | New resource created - **MUST carry `Location`** |
| `202 Accepted` | 2xx | Accepted for async work, not finished yet |
| `204 No Content` | 2xx | Success with an **empty body** (typical `DELETE`) |
| `301 Moved Permanently` | 3xx redirect | Moved for good - may rewrite `POST`→`GET` |
| `304 Not Modified` | 3xx | Conditional `GET` hit the cache (`If-None-Match`) |
| `307 / 308` | 3xx | Redirect that **keeps the method and body** |
| `400 Bad Request` | 4xx client | Server **could not parse** the request |
| `401 Unauthorized` | 4xx | **Not authenticated** - MUST send `WWW-Authenticate` |
| `403 Forbidden` | 4xx | Authenticated but **not permitted** |
| `404 Not Found` | 4xx | No resource at that URI |
| `409 Conflict` | 4xx | Clashes with current state (duplicate, race) |
| `412 Precondition Failed` | 4xx | `If-Match` lost - someone else edited first |
| `422 Unprocessable Content` | 4xx | Parsed fine, **broke a business rule** |
| `429 Too Many Requests` | 4xx | Rate limit hit (RFC 6585) - send `Retry-After` |
| `500 Internal Server Error` | 5xx server | Unexpected fault on your side |
| `502 / 504` | 5xx | Upstream returned garbage, or timed out |
| `503 Service Unavailable` | 5xx | Overloaded or draining - send `Retry-After` |

- **PUT replaces, PATCH patches.** PUT sends the whole resource and is idempotent, so the same body twice yields the same result. PATCH sends a partial change and makes no idempotency promise.
- **400 vs 422** and **401 vs 403** are the two pairs interviewers swap. 400 could not parse, 422 parsed then failed a rule. 401 does not know who you are, 403 knows and still says no. OAuth 2.1 maps this cleanly: an expired token is `invalid_token` (401), and a valid token missing a scope is `insufficient_scope` (403).
- **Conditional requests are cheap safety.** Hand out an `ETag`. Clients then send `If-None-Match` for a cheap `304`, or `If-Match` for optimistic concurrency (a `412` when someone else edited first).

> [!TIP] Two IETF drafts formalize what big APIs already ship: the `Idempotency-Key` header makes POST/PATCH safe to retry, and the `RateLimit` / `RateLimit-Policy` response headers let a client slow down before it earns a `429`.

## Example
A create with a client-supplied idempotency key, and the successful reply:
```http
POST /v1/users HTTP/1.1
Content-Type: application/json
Idempotency-Key: 6f9d2c1a-... (client-generated UUID)

{ "email": "a@b.co" }

HTTP/1.1 201 Created
Location: /v1/users/42
Content-Type: application/json

{ "id": 42, "email": "a@b.co" }
```
Retry that exact request with the same key and the server replays the stored `201` instead of creating a second user. Reuse the key with a different body and that is a client bug, so answer `422`. A retry that lands while the first is still in flight gets `409`.

A validation failure on a well-formed request keeps the parse-versus-semantics split honest:
```http
HTTP/1.1 422 Unprocessable Content
Content-Type: application/json

{ "errors": [ { "field": "email", "message": "already registered" } ] }
```

## Interview Q&A
- **What actually makes an API RESTful?** Stateless requests, resources addressed by URI, and a uniform interface of standard methods plus status codes. The credibility add: full REST also wants **HATEOAS**, where responses carry the links that drive the next action. Almost no one ships that, so naming it makes you sound like you have built one.
- **Safe vs idempotent?** **Safe** means no intended state change (`GET`, `HEAD`, `OPTIONS`). **Idempotent** means repeating the call lands the same state (adds `PUT`, `DELETE`). `POST` is neither, which is the root of every "did my retry double-charge?" bug.
- **401 vs 403?** 401 is **not authenticated** (missing or bad credentials, plus a `WWW-Authenticate` header). 403 is **authenticated but not permitted**. Swap them and clients re-auth when they should give up, or the reverse.
- **400 vs 422?** 400 means the server **could not parse** it. 422 means it **parsed fine and failed** a semantic or business rule.
- **PUT vs PATCH?** PUT **replaces** the whole resource and is idempotent. PATCH **updates part** of it and is not guaranteed to be.
- **How do you make a POST safe to retry?** An **idempotency key**: the client sends a unique UUID in `Idempotency-Key`, and the server stores it against the first response so a retry replays the original result instead of acting twice. This is how Stripe-style payment APIs avoid double charges, and it is now an IETF draft covering `POST` and `PATCH`.

## Gotchas
> [!WARN] A network timeout never tells the client whether the first `POST` landed, and `POST` is neither safe nor idempotent. Without an `Idempotency-Key`, "just retry" quietly becomes a duplicate order or a double charge.

> [!WARN] Returning `200` with the error buried in the body defeats the whole point, because a REST client reads the status line first. GraphQL deliberately returns `200` with a top-level `errors` array - that is its contract, not REST's, so do not blend the two.

- **Verbs in the path** (`/createUser`, `/deleteOrder`). That is exactly what the method is for.
- **`201` without a `Location`, or a `204` that ships a body.** RFC 9110 spells out both with a MUST.
- **Reaching for 401 when you mean 403**, or firing `429` with no `Retry-After`, which just invites a retry storm.
- **Assuming every redirect keeps the method.** `301` / `302` may turn a `POST` into a `GET`. Use `307` / `308` when the method and body must survive.

## Revise next
- **[Idempotency keys](idempotency-http-methods.md)** for safe `POST` / `PATCH` retries (IETF `Idempotency-Key` draft), and the `RateLimit` / `RateLimit-Policy` headers draft
- **[Pagination](pagination-offset-cursor.md)**: cursor vs offset, the GraphQL Cursor Connections spec (`edges` / `pageInfo`), and Google AIP-158 (`page_token` / `next_page_token`)
- **Conditional requests**: `ETag`, `If-Match`, `If-None-Match`, and optimistic concurrency
- **[Versioning and deprecation](api-versioning.md)**: URI vs header versioning, plus the `Deprecation` (RFC 9745) and `Sunset` (RFC 8594) headers with `Link` relations (RFC 8288)
- **Error-model contrasts**: gRPC's own status set (`NOT_FOUND`, `PERMISSION_DENIED`, `UNAVAILABLE`, ...) over HTTP/2, and GraphQL's `200`-plus-`errors`
- **[Auth](authn-authz-oauth-jwt.md) and [webhooks](webhooks.md)**: OAuth 2.1 bearer tokens, JWT best practices (RFC 8725), and Standard Webhooks HMAC signatures
- **DRF / FastAPI** status codes and serializers

*Reviewed against HTTP RFC 9110, RFC 5789 (PATCH), RFC 6585 (429), the IETF Idempotency-Key draft, and OAuth 2.1 - July 2026.*
