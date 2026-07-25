---
title: "Cache Strategies"
group: "Caching Patterns"
order: 1
---

# Cache Strategies: Cache-Aside, Write-Through, Write-Behind

> Cache strategies are the read and write paths between your app, the cache, and the DB: cache-aside loads lazily on a miss and is the sane default, write-through keeps the cache warm at the cost of slower writes, and write-behind flushes to the DB asynchronously for speed you pay for in durability.

## What it is
A cache strategy is just where reads and writes go, and in what order. Picking one implicitly decides how much staleness you tolerate, how slow a write can be, and how much a crash costs you.

> [!KEY] A cache strategy is a **routing rule**: it fixes where a **read** goes and where a **write** goes. Everything else - staleness, write latency, what you lose on a crash - falls out of that one choice.

The five strategies split into one read pattern and four write patterns:

| Strategy | Read path | Write path | Consistency / durability | Reach for it when |
| --- | --- | --- | --- | --- |
| **Cache-aside** (lazy loading) | App checks cache, on a **miss reads the DB and backfills** | App writes the DB, then **deletes** the key | Stale for the **TTL window** unless you invalidate | The **default** - caches only what is read, survives a cache outage |
| **Read-through** | **Cache** loads from the DB on a miss, app talks only to the cache | Pair it with a write policy below | Hidden behind the cache, **same staleness** as cache-aside | You have an **inline library** that knows how to reach your DB |
| **Write-through** | Read-through or cache-aside | Writes **cache and DB together, synchronously** | **Cache stays warm**, but not atomic across the two stores | A read right after a write must **never miss** and you accept slower writes |
| **Write-behind** (write-back) | Read-through or cache-aside | Writes cache now, **flushes the DB asynchronously** | **Fast writes, but a crash loses** un-flushed data | Absorbing write spikes on **losable** data (counts, metrics) |
| **Write-around** | Cache-aside | Writes **straight to the DB, skips the cache** | Key caches only on the **next read** | **Write-heavy, rarely re-read** data (logs, events) |

> [!TIP] Plain Redis only gives you **cache-aside**, hand-rolled by your app - it is a fast key-value store that has no idea Postgres exists. **Read-through and write-through** become "the cache does it for you" only when a library or framework sits inline and knows how to talk to your DB.

## Key points
- The default for most services is **cache-aside plus a TTL**. It caches only what is actually read and **fails soft**: if Redis dies, reads fall through to the DB - slower, but alive. Reach past it only when a stale window genuinely hurts.
- Write-through is **not atomic across two stores**. If the DB write lands and the cache write does not, you are inconsistent, so keep a **TTL backstop** even with write-through.
- Write-through, write-behind, and write-around are **write policies** - you still choose a read policy (cache-aside or read-through) alongside each one.
- **Write-behind batches** its flushes, which is exactly what absorbs spikes, but that pending batch is also the data at risk on a crash. AOF/RDB persistence narrows the window, it does not remove it.
- Storing entries as Redis hashes? Redis 8's **`HSETEX` / `HGETEX` / `HGETDEL`** give a single field its own TTL and let you read-and-expire or read-and-delete atomically - handy for sessions, OTPs, and cache fragments that used to force whole-key expiry.

## Example
Cache-aside read with invalidate-on-write - the pattern you reach for most of the time:

```python
r = redis.Redis()

def get_user(uid):
    key = f"user:{uid}"
    cached = r.get(key)
    if cached:
        return json.loads(cached)              # hit
    user = db.get_user(uid)                     # miss: fall back to the DB
    r.set(key, json.dumps(user), ex=300)        # backfill with a 5-min TTL backstop
    return user

def update_user(uid, changes):
    db.update_user(uid, changes)                # source of truth first
    r.delete(f"user:{uid}")                     # invalidate, don't rewrite (dodges the stale race)
```

Wire Redis as a pure cache so a full instance evicts instead of erroring:

```bash
redis-cli CONFIG SET maxmemory 512mb
redis-cli CONFIG SET maxmemory-policy allkeys-lru   # use allkeys-lfu if a few keys run hot
```

## Interview Q&A
- **What is cache-aside?** The app checks the cache and, on a miss, reads the DB and backfills the cache itself. Redis knows nothing about your DB, so the app owns that logic.
- **Write-through vs write-behind?** Write-through writes cache and DB synchronously (consistent on the happy path, slower writes). Write-behind writes the cache now and flushes the DB async (fast, but un-flushed writes are lost if the cache dies).
- **Read-through vs cache-aside?** Same read shape - load on a miss - but read-through hides the DB load inside the cache layer and needs an inline library, while cache-aside keeps that logic in your app.
- **Which is most common, and why?** Cache-aside with a TTL. It is simple, caches only what is read, and survives a cache outage by falling through to the DB.
- **On a cache-aside write, do you update or delete the cached key?** Delete it. Overwriting invites a stale-value race between concurrent writers. Deleting forces a clean reload on the next read.
- **When would you use write-around?** For write-heavy data that is rarely read back, so you do not fill the cache with entries nobody requests.

## Gotchas
> [!WARN] On a cache-aside write, **delete the key - never overwrite it**. Two writers that both rewrite the cache can interleave and leave the older value sitting there. A delete forces the next reader to reload fresh. Write the DB first, then invalidate.

> [!WARN] **Write-behind holds the only copy** of a write until the async flush lands, so a crash drops it. Persistence narrows the window, never closes it. Use it for view counts, metrics, and leaderboards - never orders or payments.

- Cache-aside serves **stale data for the whole TTL window** unless you invalidate on write. Keep TTLs honest and bust the key on updates that matter.
- A cold cache after a deploy, or a batch of keys with **identical TTLs expiring at once**, sends a stampede of misses straight at the DB. Jitter your TTLs, warm the hot keys, and coalesce duplicate misses (single-flight or a short lock).
- Redis defaults to `noeviction`, so a full cache **starts erroring on writes** instead of making room. For a pure cache you must pick a policy:

| `maxmemory-policy` | Evicts | Pick it when |
| --- | --- | --- |
| `noeviction` (default) | **nothing - new writes error** | you never want silent loss (not a pure cache) |
| `allkeys-lru` | **least recently read** key | **general-purpose** cache default |
| `allkeys-lfu` | **least frequently used** key | a **few hot keys** must survive churn |
| `allkeys-lrm` (Redis 8.6+) | **least recently modified** key | **read-heavy** sets - evict stale, not unread |
| `volatile-*` | same rules, **only keys that carry a TTL** | one instance mixes **cache + persistent** keys |

## Revise next
- **[Cache invalidation](cache-invalidation.md)**: naming keys and busting them on write without opening a stale-value race.
- **[TTL and eviction policies](ttl-eviction-policies.md)**: `maxmemory`, the LRU / LFU / LRM families, and jittering expiry to kill stampedes.
- **Redis as a cache**: core [data structures](redis-data-structures.md) (strings, hashes with field-level TTL, sorted sets), AOF/RDB persistence, and why plain Redis leaves cache-aside to your app.

*Reviewed against Redis 8.8, July 2026.*
