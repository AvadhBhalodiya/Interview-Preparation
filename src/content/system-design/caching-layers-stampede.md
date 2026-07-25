---
title: "Caching Layers & Stampede"
group: "Design Fundamentals"
order: 3
---

# Caching Layers and the Stampede Problem

> A cache is a bet that stale data is cheaper than a slow query, and the two ways that bet goes wrong are a stampede - thousands of concurrent misses hitting the database at once when a hot key expires - and invalidation, which is hard because nothing in the system tells you when the cached copy stopped being true.

## What it is
Caching is not one thing in one place. A single API response passes through five or six caches, each with a different owner, TTL, and failure mode, and knowing which one is serving stale data is most of debugging a cache problem.

| Layer | Lives in | Typical TTL | Invalidate by | Watch out for |
| --- | --- | --- | --- | --- |
| **Browser / client** | The user's machine | Minutes to a year | Nothing - you cannot reach it | `Cache-Control: immutable` on a file you later change |
| **CDN / edge** (CloudFront) | ~600 PoPs | Minutes to days | Path invalidation, versioned URLs | Invalidations take minutes and the first 1,000/month are free, then billed |
| **App / in-process** | Gunicorn worker memory | Seconds | Process restart only | Every worker holds a *different* copy |
| **Distributed** (Redis / ElastiCache) | A separate box | Seconds to hours | `DEL`, key version bump | Network hop, and it is a shared point of failure |
| **DB buffer pool** | `shared_buffers` | Until evicted | Automatic (LRU-ish) | Default **128 MB**; should be ~25% of RAM |
| **Materialised view** | Postgres tables | Explicit | `REFRESH MATERIALIZED VIEW CONCURRENTLY` | Refresh cost scales with the view, not the change |

> [!KEY] The in-process layer is the one that surprises people. With 8 Gunicorn workers you have **8 independent caches**, so a `TTL=300` value can be served for five minutes *after* you invalidated Redis, and which copy you get depends on which worker the load balancer picked. Never put authorisation decisions or balances there.

The write patterns are a smaller set than the vocabulary suggests:

| Pattern | Write path | Read path | Cost |
| --- | --- | --- | --- |
| **Cache-aside** (lazy) | App writes DB, then invalidates the key | Miss -> load DB -> populate | Every first read is a miss; a race can cache a stale value |
| **Write-through** | App writes cache *and* DB synchronously | Always a hit | Write latency is the sum of both; caches data nobody reads |
| **Write-behind** (write-back) | App writes cache, a worker flushes to DB later | Always a hit | Fastest writes, and **data loss if the cache dies before the flush** |
| **Refresh-ahead** | Background job recomputes before expiry | Always a hit | Wasted work on keys that go cold |

Cache-aside is the default for a reason: it is the only one where a Redis outage degrades you to "slow" rather than "wrong". Django's cache framework, `functools.lru_cache`, and nearly every `get_or_set` helper implement it.

## Key points
- **A stampede is a concurrency bug, not a capacity problem.** One hot key expires; 3,000 in-flight requests all miss simultaneously; all 3,000 run the same 400 ms aggregation against PostgreSQL. The database now has 3,000 concurrent connections doing identical work, saturates, and the recomputation gets slower, which widens the window, which admits more requests. This is also called dogpile or thundering herd, and it typically takes the database down within seconds.
- **Jitter the TTL or you have engineered a synchronised stampede.** A cache warmed by a deploy or a batch job writes 50,000 keys with an identical `TTL=3600`, and one hour later all 50,000 expire in the same second. `ttl = base + random.randint(0, base // 10)` costs one line and removes an entire class of 3 a.m. pages.
- **Single-flight is the direct fix: one recompute, everyone else waits or serves stale.** Take a short Redis lock with `SET lock:<key> <token> NX EX 30`; the winner recomputes, the losers either block briefly or return the stale value. `NX` makes acquire-if-absent atomic, and the `EX` is mandatory - a lock without a TTL held by a worker that OOMs blocks that key forever.
- **Probabilistic early recomputation avoids the lock entirely.** Store the recompute duration alongside the value and let each reader independently decide to refresh early with probability rising as expiry approaches: refresh when `now - delta * beta * ln(random()) >= expiry` (the XFetch algorithm, Vattani et al., VLDB 2015). With `beta = 1` this makes exactly one reader refresh, on average, before anyone sees a miss - no lock, no coordination.
- **Stale-while-revalidate keeps p99 flat during recomputation.** Give the key a logical expiry inside the value and a physical Redis TTL well beyond it. Past logical expiry you return the stale value immediately and enqueue a Celery task to refresh. Users never wait on a cold cache, at the cost of bounded staleness - which is exactly the trade a dashboard wants and a balance check does not.
- **Invalidation is hard because it is a distributed-systems problem wearing a `DEL` costume.** The cached copy has no idea the underlying row changed. Every strategy is a different way of guessing: TTL guesses on time, explicit deletion guesses that you found every key, and key versioning sidesteps the guess by never mutating a key at all. See [Cache invalidation](../caching/cache-invalidation.md).

> [!TIP] Prefer **versioned keys** to deletion. Cache under `merchant:42:v7:summary` and bump a `merchant:42:version` counter on write. There is no delete to get wrong, no race between the delete and a concurrent populate, and old versions fall out on their own TTL. Deletion is a write you have to get right everywhere; a version bump is one `INCR`.

## Example
Cache-aside with jitter and single-flight - the shape that survives a hot key expiring under load:

```python
import json, random, time, uuid
import redis
from django.db import connection

r = redis.Redis.from_url(settings.REDIS_URL)
BASE_TTL = 300

def merchant_summary(merchant_id: int) -> dict:
    key, lock_key = f"merchant:{merchant_id}:summary", f"lock:merchant:{merchant_id}"

    cached = r.get(key)
    if cached:
        return json.loads(cached)

    # Miss. Exactly one caller wins the lock and recomputes; the rest do NOT
    # pile onto Postgres. NX = set-if-absent (atomic), EX = mandatory TTL so a
    # worker that dies mid-recompute cannot wedge this key forever.
    token = uuid.uuid4().hex
    if r.set(lock_key, token, nx=True, ex=30):
        try:
            value = _expensive_aggregate(merchant_id)      # ~400ms in Postgres
            # Jitter: without it, keys warmed together expire together and you
            # get a synchronised herd one TTL later.
            ttl = BASE_TTL + random.randint(0, BASE_TTL // 10)
            r.set(key, json.dumps(value), ex=ttl)
            return value
        finally:
            # Release only if we still own it - a lock that expired and was
            # re-acquired by someone else must not be deleted by us.
            if r.get(lock_key) == token.encode():
                r.delete(lock_key)

    # Lost the race: wait briefly for the winner rather than querying.
    for _ in range(20):
        time.sleep(0.05)
        cached = r.get(key)
        if cached:
            return json.loads(cached)
    return _expensive_aggregate(merchant_id)   # winner died; degrade, don't 500
```

Stale-while-revalidate, when a flat p99 matters more than freshness:

```python
SOFT_TTL, HARD_TTL = 300, 3600   # physical TTL is 12x the logical one

def dashboard_stats(merchant_id: int) -> dict:
    key = f"stats:{merchant_id}"
    raw = r.get(key)
    if raw:
        payload = json.loads(raw)
        if payload["expires_at"] < time.time():
            # Logically stale. Serve it NOW, refresh out of band. The SETNX
            # guard stops every request in the stale window from queueing a
            # duplicate Celery task.
            if r.set(f"refresh:{key}", 1, nx=True, ex=60):
                refresh_stats.delay(merchant_id)
        return payload["data"]        # never blocks on a cold recompute

    data = _expensive_aggregate(merchant_id)
    r.set(key, json.dumps({"data": data, "expires_at": time.time() + SOFT_TTL}),
          ex=HARD_TTL)
    return data
```

## Interview Q&A
- **What is a cache stampede and how do you prevent it?** A hot key expires and every concurrent request misses at once, so hundreds of identical expensive queries hit the database simultaneously and can take it down. Prevent it with TTL jitter so keys do not expire together, a single-flight lock (`SET NX EX`) so only one caller recomputes, probabilistic early recomputation, or stale-while-revalidate.
- **Cache-aside versus write-through - which do you pick?** Cache-aside by default, because a cache outage only makes you slow, and you never cache data nobody reads. Write-through when reads must always hit and you can absorb the extra write latency; write-behind only when losing the un-flushed window is acceptable, which in a payments ledger it is not.
- **Why is cache invalidation hard?** Because nothing tells the cache its copy became untrue, and a single logical change often maps to many keys across many layers - a merchant rename touches the summary key, list pages, a CDN-cached response, and eight in-process worker caches. Versioned keys avoid the enumeration problem entirely.
- **What TTL would you choose?** One derived from how stale the data may be, not a round number. Seconds for a balance, minutes for a dashboard, hours for reference data - plus jitter. If you cannot state the tolerable staleness, you do not yet know whether the value should be cached.
- **How do you cache a value that must never be stale?** You do not cache the authoritative read. Cache the expensive derived parts around it and read the balance from the primary, or use write-through with invalidation inside the same transaction so cache and database cannot diverge.
- **What happens when Redis goes down?** With cache-aside, every request falls through to PostgreSQL - which is correct but is itself a stampede across every key at once. Guard it with a circuit breaker, short client timeouts (a 5-second Redis timeout turns a cache outage into a total outage), and load-shedding on the expensive endpoints.

## Gotchas
> [!WARN] **A cache that is not sized or evicting is a cache that will refuse writes.** Redis defaults `maxmemory-policy` to `noeviction`, so once `maxmemory` is reached every `SET` returns an OOM error and your cache silently stops accepting new entries while still serving old ones. For a pure cache set `allkeys-lru`; ElastiCache defaults to `volatile-lru`, which only evicts keys that have a TTL - any key you wrote without one is immortal.

> [!WARN] **Cache-aside has a real write-skew race.** Reader A misses and reads the DB; writer B updates the row and deletes the key; reader A then writes its now-stale value into the cache, where it survives for a full TTL with nothing to correct it. Versioned keys make this impossible; a delayed second delete after a few hundred milliseconds is the common patch if you must keep plain deletion.

- **Caching a miss is as important as caching a hit.** Repeated lookups for an ID that does not exist (a scraper walking `/payments/{id}`) bypass the cache every time and hit the database - cache the negative result with a short TTL, or front it with a Bloom filter.
- **Do not cache under a key that omits a permission dimension.** `merchant:42:summary` served to a user who lost access to merchant 42 is a data-leak bug, not a staleness bug. Either include the requester's scope in the key or cache below the authorisation boundary.
- **`REFRESH MATERIALIZED VIEW` without `CONCURRENTLY` takes an `ACCESS EXCLUSIVE` lock** and blocks all readers for the duration. `CONCURRENTLY` needs a unique index on the view and is slower, but it does not stop traffic.
- **In-process caches make deploys look like fixes.** A bug that vanishes after a restart and returns an hour later is almost always a per-worker cache, and it will not reproduce on a single-worker dev server.

## Revise next
- [Cache strategies](../caching/cache-strategies.md): cache-aside, write-through and write-behind in more depth
- [Cache invalidation](../caching/cache-invalidation.md): the deletion, versioning and tagging approaches
- [TTL and eviction policies](../caching/ttl-eviction-policies.md): `maxmemory-policy`, LRU versus LFU, and what eviction actually does
- [Scaling the database](db-scaling.md): caching removes read load; replicas absorb it

*Reviewed against Redis 8 and Django 5.2 cache framework docs, July 2026.*
