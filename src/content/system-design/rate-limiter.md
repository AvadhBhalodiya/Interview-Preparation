---
title: "Design a Rate Limiter"
group: "Classic Designs"
order: 11
---

# Design a Distributed Rate Limiter

> A rate limiter answers one question - has this identity spent its quota for the current window - in under a millisecond, from any of your app instances, using one shared atomic counter; the interview is about which algorithm shapes the burst, where in the stack you ask, and what the system does when the counter store dies.

## What it is
Rate limiting on a single process is a dictionary. The design problem appears the moment you run twenty pods behind an ALB: the counter has to be **shared and atomic**, the check sits on the hot path of every request, and the store you added must not become a new single point of failure.

Five algorithms, ordered by how much burst they let through:

| Algorithm | State per key | Burst behaviour | Accuracy | Cost |
| --- | --- | --- | --- | --- |
| **Fixed window** | One counter | **Up to 2x at the boundary** | Coarse | Cheapest: `INCR` + `EXPIRE` |
| **Sliding window log** | A timestamp per request | **None - exact cutoff** | **Exact** | **O(N) memory**, N = limit |
| **Sliding window counter** | Two counters | Smoothed across the boundary | Close approximation | O(1), one Lua call |
| **Token bucket** | Tokens + last-refill timestamp | **Burst up to bucket size B**, then steady R | Good average rate | O(1) |
| **Leaky bucket** | Level + timestamp | **None - constant outflow** | Strict constant rate | O(1) |

> [!KEY] **Token bucket is the default** because real clients are bursty and a limit that forbids all burst feels broken. Reach for the **sliding window counter** when a boundary spike would hurt a fragile downstream, and the **log** only when you must be exact and the limit is small enough that storing every timestamp is affordable.

The sliding window counter is the one worth being able to derive out loud: `estimate = previous_window_count * (fraction of the previous window still inside the trailing window) + current_window_count`. Two integers, no per-request storage, and the boundary spike disappears.

## Key points
- **Enforce as early as the decision is available.** A limit you can evaluate without knowing the user belongs at the edge; a per-plan quota needs the authenticated identity and therefore lives in the app or gateway.

| Layer | Example | Sees | Good for |
| --- | --- | --- | --- |
| **Edge / WAF** | CloudFront, AWS WAF rate-based rules (**1/2/5/10-minute** evaluation windows, approximate) | IP, path, headers | **Blunting floods**, not per-user quota |
| **Gateway** | nginx `limit_req` (leaky bucket with `burst` + `nodelay`), API Gateway usage plans (token bucket: rate + burst) | API key, route | The default home: **rejects before your app pays anything** |
| **Application** | DRF `UserRateThrottle`, a FastAPI dependency | User, plan, per-endpoint cost | Business rules the gateway cannot express |

- **Key on identity, and make the key composite.** `rl:{tier}:{user_id}:{endpoint_group}` beats a single global bucket, because a cheap `GET /health` and an expensive `POST /reports` should not draw from one budget. Raw IP is the fallback for anonymous traffic only - corporate NAT and CGNAT put thousands of real users behind one address, so an IP limit punishes innocents while a distributed attacker barely notices.
- **Atomicity is the whole implementation.** `INCR` then a separate `EXPIRE` is two commands; a crash between them leaves a counter with **no TTL** and locks that client out permanently. Put the read-modify-write in a **Lua script** (Redis runs it atomically, single-threaded) or use a single command that does both. Do all of a request's limit checks in **one** `EVAL` - three round trips at 0.5 ms each is 1.5 ms added to every request.
- **Decide fail-open or fail-closed before Redis decides for you.** The limiter is now on the path of every request, so its failure mode is a design choice, not an accident.

| Redis unreachable | Behaviour | Choose when |
| --- | --- | --- |
| **Fail open** | Allow everything, log loudly | The limit protects **fairness**; an outage plus a locked-out API is worse |
| **Fail closed** | Reject with 429/503 | The limit protects a **fragile downstream** - a payment provider, a legacy core banking API |
| **Local fallback** | Per-pod in-memory bucket at `limit / pods` | You want degradation, not a cliff. Best default |

- **Stack multiple windows rather than picking one number.** `10/second` stops a hot loop, `1000/hour` stops sustained abuse; evaluate both and return the **most restrictive** `Retry-After`. Publish the state so clients can self-throttle: `429` plus `Retry-After`, plus `RateLimit`/`RateLimit-Policy` (or the older `X-RateLimit-*` that GitHub and Stripe still emit).
- **Derive "now" from Redis, not from the pod.** Pass `redis.call('TIME')` into the script instead of each app server's clock. NTP drift of a few hundred milliseconds across a fleet quietly widens or narrows the window per pod.

## Example
A sliding window log in Lua - exact, and correct under concurrency because the whole script is one atomic step:

```lua
-- KEYS[1] = rl:user:42:search   ARGV[1] = limit   ARGV[2] = window_ms
local now    = redis.call('TIME')                       -- Redis clock: every pod agrees
local now_ms = now[1] * 1000 + math.floor(now[2] / 1000)
local cutoff = now_ms - tonumber(ARGV[2])

redis.call('ZREMRANGEBYSCORE', KEYS[1], 0, cutoff)      -- drop anything outside the window
local used = redis.call('ZCARD', KEYS[1])
if used >= tonumber(ARGV[1]) then
  local oldest = redis.call('ZRANGE', KEYS[1], 0, 0, 'WITHSCORES')
  return {0, math.ceil((oldest[2] + ARGV[2] - now_ms) / 1000)}   -- {deny, Retry-After}
end

redis.call('ZADD', KEYS[1], now_ms, now_ms .. ':' .. redis.call('INCR', 'rl:seq'))
redis.call('PEXPIRE', KEYS[1], ARGV[2])                 -- key evaporates when the window does
return {1, 0}
```

The FastAPI side - one round trip, and the response contract a client can act on:

```python
async def enforce_limit(request: Request, user=Depends(current_user)) -> None:
    key = f"rl:{user.tier}:{user.id}:{request.scope['route'].name}"
    try:
        allowed, retry_after = await redis.evalsha(SLIDING_LOG_SHA, 1, key, "100", "60000")
    except RedisError:
        # Fail open, but never silently: this is the alert that says the limiter is blind.
        logger.error("rate_limiter_unavailable", extra={"key": key})
        return
    if not allowed:
        raise HTTPException(
            status_code=429,
            headers={"Retry-After": str(retry_after), "RateLimit-Policy": '"api";q=100;w=60'},
        )
```

## Interview Q&A
- **Which algorithm and why?** Token bucket by default - it allows a short burst up to the bucket size and then settles at the refill rate, which matches how real clients behave. Sliding window counter when a boundary spike would hurt something downstream, since it costs two integers instead of a timestamp per request.
- **How do you make the check correct across twenty pods?** One shared counter in Redis, mutated by a Lua script so the read-modify-write is atomic. The tempting alternative - each pod enforcing `limit / 20` - breaks as soon as the load balancer distributes unevenly, and it is impossible to express a limit of 10 across 20 pods at all.
- **What happens when Redis goes down?** A deliberate choice. Fail open for fairness limits, fail closed when the limit shields a fragile downstream, and in both cases fall back to a per-pod in-memory bucket so you degrade instead of falling off a cliff. Whichever you pick, alarm on it, because a silently disabled limiter is invisible until the bill arrives.
- **Per-user or per-IP?** Per-user or per-API-key whenever the caller is authenticated: it survives NAT, mobile carriers and proxies. IP only for anonymous endpoints like login and signup - and there the point is credential stuffing, so pair it with a per-account attempt counter so an attacker rotating IPs still gets stopped.
- **How do you rate limit something like a GraphQL endpoint or a bulk API?** Counting requests is meaningless when one request can cost a thousand times another. Assign a cost per query or per item, deduct the cost from the bucket rather than one token, and reject when the balance goes negative. GitHub and Shopify both meter points, not calls.

## Gotchas
> [!WARN] **The non-atomic counter is the classic bug.** `GET`, compare, `SET` in application code lets two pods both read 99 and both allow the request. It looks fine in a single-process test and leaks over the limit under exactly the load you built the limiter for. One Lua script, or nothing.

> [!WARN] **A hot key is a hot shard.** In Redis Cluster every request for one enterprise tenant hashes to a single slot on a single node, so your biggest customer becomes a single-node throughput ceiling. Shard the key (`rl:{tenant}:{0..9}` at a tenth of the limit each, picked at random) or give that tenant a dedicated node.

- **Rejections still cost you.** A 429 is cheap, but it is not free - a client in a retry loop can still saturate your gateway with requests you reject. That is what the edge layer is for.
- **Retry-After with no jitter synchronises the herd.** Every rejected client returns at the same second and you get a thundering herd, so spread the value slightly per client.
- **Limits scoped per pod drift after autoscaling.** Any design that divides a global limit by the instance count silently changes the effective limit each time the ASG scales, and nobody notices until it scales down.
- **Do not put the limiter on the same Redis as your cache.** An eviction policy of `allkeys-lru` will happily evict rate-limit keys under memory pressure, resetting counters exactly when traffic is highest.

## Revise next
- [Rate limiting](../api-design/rate-limiting.md): the HTTP contract, status codes and headers in detail
- [Redis data structures](../caching/redis-data-structures.md) - sorted sets, `EXPIRE`, and Lua atomicity
- [DRF throttling](../drf/pagination-filtering-throttling.md) for the framework-level implementation
- [Design an API gateway](api-gateway.md): the layer where the limiter usually lives

*Reviewed against the Redis command reference, nginx `limit_req`, and the IETF RateLimit header fields draft, July 2026.*
