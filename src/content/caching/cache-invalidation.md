---
title: "Cache Invalidation"
group: "Caching Patterns"
order: 2
---

# Cache Invalidation

> Cache invalidation is getting stale entries out of the cache before anyone reads them, and it is famously hard because the cache and the source of truth are two separate stores with no shared transaction that drift apart the moment data changes.

## What it is
- Invalidation is the work of removing or refreshing a cached entry once it no longer matches the database. The instant a row changes in Postgres, the copy sitting in Redis is a lie until you act, and that action is invalidation.
- It is hard because the two stores share no transaction, so they drift under concurrency, and one write can stale out many derived keys at once. That is the Phil Karlton joke ("two hard things in CS: cache invalidation and naming things") the Redis client-side-caching docs open with.

> [!KEY] The cached copy is a lie the instant the source row changes, so every strategy is really a bet on how fast and how reliably you notice. Two defaults cover most systems: **put a TTL on everything** as a safety net, and **delete keys on write** rather than overwrite them.

The main approaches, cheapest first, and what each one buys you:

| Approach | How it invalidates | Trade-off |
| --- | --- | --- |
| **TTL expiry** | key self-deletes after N seconds (`SET k v EX 300`) | trivial and self-healing, but only **eventually fresh** |
| **Write-through** | on write, `SET` the fresh value into the cache | no refill miss, but a lost race can **re-cache a stale read** |
| **Explicit delete** | on write, `DEL` the key so the next read refills | **fresh on the next read**, but must cover every write path |
| **Versioned keys** | `INCR` a version so every old-version key misses | **atomic group swap**, no `SCAN`, but orphans need a TTL |
| **Event-based** | Redis pushes "drop this key" to subscribed clients | keeps **multi-node caches** fresh, but adds protocol wiring |

## Key points
- **TTL is your default.** Put an expiry on every key (`SET key val EX 300`) and let Redis auto-delete it. You trade up to one TTL of staleness for a cache that heals itself and never leaks memory. Pick the number from how stale the data may be, not from habit.
- **Delete on write, do not overwrite.** When the row changes, `DEL` the key and let the next read repopulate. `DEL` beats `SET` because a concurrent reader holding an older DB result can otherwise write it back after you. The catch: you must cover every write path.
- **Versioned / namespaced keys** retire a whole family at once. Keep a version like `user:42:ver`, build keys as `user:42:{ver}:profile`, and one `INCR` makes every old key miss - no `SCAN`, no `KEYS`. Orphans still need a TTL or a `maxmemory` policy to disappear.
- **Event-based invalidation** is for app servers holding their own local caches. Redis 6+ ships client-side caching (tracking): `CLIENT TRACKING ON` and Redis pushes an invalidation message when a key you read is modified, expires, or is evicted. RESP3 delivers it on the same connection, while RESP2 redirects to a second connection on the `__redis__:invalidate` pub/sub channel. `BCAST PREFIX user:` subscribes by key prefix.
- **Cache stampede (dogpile)** is the failure mode to name: a hot key expires and every concurrent miss hits the DB at once. Fix it by making the refill happen once - see the Example.
- There is no clean answer, and interviewers know it. TTL plus delete-on-write covers the large majority of systems. Reach for tracking or pub/sub only when caches on several nodes genuinely must agree.

## Example
```python
# read-through with a TTL so the entry self-heals even if a bust is missed
def get_user(uid):
    key = f"user:{uid}"
    hit = r.get(key)
    if hit is not None:
        return json.loads(hit)
    row = db.get_user(uid)
    r.set(key, json.dumps(row), ex=300)      # 5 min TTL = bounded staleness
    return row

# invalidate on write: delete, do not set
def update_user(uid, data):
    db.update_user(uid, data)
    r.delete(f"user:{uid}")                  # next read refills from source of truth
    # avoid r.set(...) here: a concurrent reader can cache a pre-write value

# versioned invalidation: one INCR retires every key built under the old version
r.incr(f"user:{uid}:ver")                    # user:{uid}:{ver}:profile now misses
```

Three stampede mitigations - combine them on a genuinely hot key:

```python
# 1. single-flight lock: only the winner recomputes, the rest briefly wait
def get_hot(key):
    val = r.get(key)
    if val is not None:
        return val
    if r.set(f"lock:{key}", 1, nx=True, ex=5):   # NX = set only if absent
        val = recompute()
        r.set(key, val, ex=300)
        r.delete(f"lock:{key}")
        return val
    time.sleep(0.05)                             # let the winner fill the cache
    return r.get(key) or recompute()

# 2. jittered TTL: spread expiries so keys do not die in lockstep
r.set(key, val, ex=300 + random.randint(0, 60))

# 3. early recompute: refresh ahead of expiry so the key never actually misses
```

## Interview Q&A
- **Why is cache invalidation hard?** The cache and the database are separate stores with no shared transaction, so they drift the moment data changes. One write can invalidate many derived keys, and concurrent reads and writes interleave in racey ways. Nodding to the two-hard-things joke (Phil Karlton) shows you know the lore.
- **Common invalidation strategies?** TTL expiry, write-through update, explicit delete-on-write, versioned/namespaced keys, and event-based invalidation via Redis client-side tracking or pub/sub.
- **What is a cache stampede and how do you stop it?** A hot key expires and many concurrent misses hit the DB together (also called a dogpile). Collapse the refill to one worker with a lock, refresh probabilistically just before expiry, and jitter TTLs so keys do not expire in lockstep.
- **TTL vs explicit invalidation?** TTL is trivial and self-healing but only eventually fresh. Delete-on-write is fresh on the next read, but only if you cover every write path. Most real systems run both.
- **Why delete the key on write instead of setting the new value?** A `SET` on the write path can be overtaken by a concurrent reader that already fetched the old row and writes it back after you, caching stale data. Deleting forces the next read to repopulate from the source of truth.

## Gotchas
> [!WARN] A plain `SET` wipes the key's TTL: the expiry resets to none (TTL becomes -1) and the key now lives **forever**. Use `SET ... EX`, re-apply `EXPIRE`, or pass `KEEPTTL`. Value-mutating ops like `INCR`, `HSET`, and `LPUSH` leave the TTL untouched.

> [!WARN] Never reach for `KEYS pattern` to find things to invalidate: it is **O(N) and blocks the single-threaded server** on a large keyspace. Design key names so you invalidate by deleting a known key or bumping a version, and use `SCAN` (cursor-based) if you truly must iterate.

> [!TIP] To refresh a value while keeping its countdown, use `SET key val KEEPTTL` (Redis 6+), or `GETEX key EX 300` to read and re-arm the TTL in one call.

- Miss one write path and that key stays stale until its TTL saves you, or forever if it has none. Centralize cache reads and writes behind one module so there is a single place to get it right.
- Identical TTLs across many keys make them expire together and manufacture a stampede. Add random jitter (e.g. 300s plus a few percent per key).
- The delete-then-read race: between your DB commit and the `DEL`, a reader can slip in and re-cache the old value. Invalidate after the commit lands, and use a short lock if that window matters for you.

## Revise next
- [Caching strategies](cache-strategies.md) (cache-aside, write-through, write-behind)
- [TTL and eviction policies](ttl-eviction-policies.md) (`maxmemory` with LRU / LFU, plus the newer LRM policy from Redis 8.6)
- Redis client-side caching (`CLIENT TRACKING`, RESP3 invalidation)

*Reviewed against Redis 8.8, July 2026.*
