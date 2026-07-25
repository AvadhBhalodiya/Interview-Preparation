---
title: "Rate Limiting"
group: "API Design"
order: 5
---

# Rate Limiting

> Rate limiting caps how many requests a client can make in a window so one caller can't starve or topple the service. You key it by API key or user (rarely raw IP), reject the overflow with 429 Too Many Requests plus Retry-After, and enforce it at the edge with something like a token bucket in Redis.

## What it is
- Restricting request volume per client over a time window. The point isn't only blocking bad actors. It's protecting **availability and fairness** so one noisy client (a runaway retry loop, a scraper, a bad deploy) can't eat the capacity everyone else needs.
- Enforced against an **identity key** (API key, authenticated user id, or IP), usually at the gateway or edge before the request touches anything expensive.
- **429 Too Many Requests** is the signal, defined in **RFC 6585** (not RFC 9110). **RFC 9110** is where `Retry-After` lives, which tells the client how long to wait.

> [!KEY] Rate limiting is one cheap question asked early: *has this identity spent its quota for the current window?* If yes, reply 429 with Retry-After. The rest is detail: **which algorithm** shapes the burst, **where** you ask it (the edge), and **how** servers share one atomic counter (Redis).

The response you owe a throttled client, and where each field is defined:

| Field | Source | Carries |
| --- | --- | --- |
| `429 Too Many Requests` | **RFC 6585** | The status code itself |
| `Retry-After` | **RFC 9110** | When to come back: `delay-seconds` (e.g. `30`) **or** an HTTP-date |
| `RateLimit-Policy` | IETF draft (Standards Track) | The **static** policy: `q` quota, `w` window seconds |
| `RateLimit` | IETF draft (Standards Track) | The **live** state: `r` remaining, `t` seconds until reset |

> [!TIP] The `RateLimit` and `RateLimit-Policy` structured fields are still an IETF draft, so don't treat the exact syntax as frozen. In the wild you'll mostly still see the older `X-RateLimit-*` variants (GitHub, Stripe).

## Key points
Pick the algorithm by how much burst you tolerate and how much state you can afford to keep:

| Algorithm | How it works | Burst | Memory | Accuracy |
| --- | --- | --- | --- | --- |
| **Token bucket** | Refill R tokens/sec, cap at bucket size B, spend one per request | **bursts up to B**, then steady R | **O(1)**: count + timestamp | good average rate |
| **Leaky bucket** | A FIFO queue drained at a fixed rate | **no burst**: constant outflow | **O(1)**: level + timestamp | strict constant rate |
| **Fixed window** | One counter per clock interval, reset at the boundary | **~2x at the boundary** | **O(1)**: single counter | coarse |
| **Sliding-window log** | Store a timestamp per request, count those in the trailing window | none: **exact** cutoff | **O(N)**: every timestamp | **exact** |
| **Sliding-window counter** | Weight the previous window's count by overlap, add the current | smooths the boundary | **O(1)**: two counters | close **approximation** |

- **Reach order:** token bucket is the sane default (steady average, tolerates a short burst). Sliding-window counter when the boundary burst matters but you can't afford a log. Fixed window when dead simple beats precise. Leaky bucket when you specifically want to flatten spiky traffic.
- **Key on identity, not on a connection.** An API key or user id survives NAT, mobile carriers, and corporate proxies where thousands of real users share one egress IP. Fall back to IP only for anonymous traffic. Tier the quotas (free vs paid) and often set them per-endpoint, since a cheap GET and an expensive search shouldn't draw from one budget.
- **Enforce as early as you can:** gateway, load balancer, or middleware (nginx `limit_req`, a cloud API gateway, DRF throttles). Rejecting after you've already hit the database defeats the point.
- **Centralize the counters** so the limit holds across every app instance. Redis is the usual home: `INCR` + `EXPIRE` for window counters, or a Lua token bucket. The one rule is to make the check atomic (see Gotchas).
- **It's a security control too.** The OAuth 2.0 Security BCP (**RFC 9700**, which the in-progress OAuth 2.1 leans on) calls for throttling the token endpoint specifically, to blunt credential and authorization-code guessing.
- **Not every protocol speaks 429.** gRPC returns `RESOURCE_EXHAUSTED` (code 8) for a quota or rate limit, and `UNAVAILABLE` (code 14) for transient overload the client should retry.
- **Pair server limits with client backoff:** exponential backoff plus jitter, honor `Retry-After`, and on a retried non-idempotent write send an `Idempotency-Key` (per the IETF draft) so a retry after a 429 or 503 doesn't double-charge.

## Example
```http
HTTP/1.1 429 Too Many Requests
Retry-After: 30
RateLimit-Policy: "default";q=100;w=60
RateLimit: "default";r=0;t=30
Content-Type: application/json

{"error": "rate_limited", "message": "Quota exhausted, retry in 30s"}
```
If you send both `Retry-After` and `RateLimit` on a 429, a conforming client honors `Retry-After` first. The server side, in Redis:
```lua
-- Atomic fixed-window limiter, one round trip via EVAL.
-- KEYS[1]=ratelimit:{user}   ARGV[1]=limit   ARGV[2]=window_seconds
local n = redis.call('INCR', KEYS[1])
if n == 1 then
  redis.call('EXPIRE', KEYS[1], ARGV[2])   -- set the TTL only when the window is created
end
return (n <= tonumber(ARGV[1])) and 1 or 0  -- 1 allow, 0 reject
```
The Lua wrapper is what makes it correct: `INCR` and `EXPIRE` land together. Redis 8.8+ folds increment, cap, and TTL into one native command - `INCREX ratelimit:{user} BYINT 1 UBOUND 100 EX 60 ENX` returns `[count, 0]` once the cap is hit - so the script isn't strictly needed there.

## Interview Q&A
- **What status code, and what must you tell the client?** 429 Too Many Requests, with `Retry-After` so a well-behaved client knows when to come back instead of hammering you. Advertising `RateLimit`/`RateLimit-Policy` also lets clients self-throttle before they hit the wall.
- **Token bucket vs fixed window?** Token bucket refills at a steady rate and lets a client **burst up to the bucket size**, so it's smooth and forgiving. Fixed window just counts per clock interval - trivial to build, but it leaks up to **~2x** the limit across a boundary. Default to token bucket.
- **What do you key the limit on?** An identity you control: API key or user id, tiered by plan. IP only as a fallback for anonymous traffic, because NAT and proxies pack many users behind one address.
- **Where does it run, and why there?** At the edge or gateway, before the request does real work. If you've already queried the DB before rejecting, you've paid the cost you were trying to avoid.
- **How do you keep it correct across many app servers?** Share the counter (Redis) and do the check atomically in one round trip: a Lua script, or a single command like `INCREX` or redis-cell's `CL.THROTTLE`. A read-then-write in application code races and lets clients over-spend.

## Gotchas
> [!WARN] **The atomicity trap.** `INCR` then a separate `EXPIRE` is two commands. If the process dies between them the counter lives on with **no TTL**, and that client is locked out forever. Commit both together: a Lua script, `SET ... NX EX`, or `INCREX`.

> [!WARN] **Fixed window's boundary burst.** A client can fire the full limit at 0:59 and again at 1:00, briefly pushing **~2x** through. When the limit is a hard ceiling (payments, a fragile downstream), use sliding-window or token bucket.

- **IP limits punish the wrong people.** Office NAT, mobile carriers, and CGNAT put thousands of real users on one address, so an IP cap throttles innocents while barely slowing a distributed attacker. Prefer per-key or per-user.
- **Silent 429s make things worse.** A 429 with no `Retry-After` and no `RateLimit` fields leaves clients guessing, so they retry aggressively right into the overload. Always say when to come back, and add jitter so everyone you rejected doesn't retry in the same instant.
- **GraphQL breaks naive counting.** It's a single POST endpoint, and one query can ask for a trivial or a catastrophic amount of nested data, so counting requests is meaningless. Assign each field a cost, sum the query's cost with static analysis before executing it, and meter that against a points budget. GitHub and Shopify both do exactly this.

## Revise next
- [Redis use cases](../caching/redis-use-cases.md) (rate limiting)
- [Idempotency](idempotency-http-methods.md) & retries
- [DRF throttling](../drf/pagination-filtering-throttling.md)

*Reviewed against RFC 6585 (429), RFC 9110 (Retry-After), and the IETF RateLimit header fields draft, July 2026.*
