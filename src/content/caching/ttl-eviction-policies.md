---
title: "TTL & Eviction"
group: "Caching Patterns"
order: 3
---

# TTL and Eviction Policies (LRU, LFU)

> TTL is a per-key expiry that lets cached data age out on its own. Eviction is the separate thing Redis does under memory pressure, deciding which keys to drop once it hits `maxmemory` (usually an approximated LRU or LFU).

## What it is
**TTL** and **eviction** both delete keys, but they answer different questions and fire for different reasons.

- **TTL** is a per-key **expiry** you attach with `EXPIRE` or the `EX`/`PX` option on `SET`. When the countdown hits zero Redis deletes the key for you - no cron, no cleanup code. TTL is about **freshness**: stopping stale data from living forever.
- **Eviction** is what Redis does when it runs out of room. Once memory reaches `maxmemory`, it drops keys per `maxmemory-policy` to make space for new writes. Eviction is about **surviving a memory cap**, not freshness.

> [!KEY] TTL and eviction are **independent**. A key can be **evicted long before its TTL** runs out (you are over the memory cap), and an **expired key can linger** in memory until something reaps it. Interviewers poke exactly here - never conflate the two.

## Key points
Eight policies: `allkeys-*` may drop **any key**, `volatile-*` only keys that **carry a TTL**, and the suffix decides how the victim is picked.

| `maxmemory-policy` | Candidate keys | Victim chosen by |
| --- | --- | --- |
| `noeviction` (default) | none | **nothing is evicted** - data-adding writes fail with an OOM error, reads still work |
| `allkeys-lru` | **all keys** | least **recently used** |
| `allkeys-lfu` | **all keys** | least **frequently used** |
| `allkeys-random` | **all keys** | a **random** key |
| `volatile-lru` | **only keys with a TTL** | least recently used |
| `volatile-lfu` | **only keys with a TTL** | least frequently used |
| `volatile-ttl` | **only keys with a TTL** | **shortest remaining TTL** (soonest to expire) |
| `volatile-random` | **only keys with a TTL** | a random key |

- **Redis 8.6 added LRM** (least recently modified): `allkeys-lrm` / `volatile-lrm` are LRU whose clock **advances only on writes, not reads**, so they evict data that has not changed lately regardless of how often it is read.
- **Eviction only fires once `maxmemory` is set.** The default is `0` (unlimited) on 64-bit builds, so no policy runs until you cap memory. Set the cap first, then pick `maxmemory-policy`.
- **The default `noeviction` is a cache trap.** It is right for a system of record but wrong for a cache, because it starts erroring on writes instead of freeing space. For a cache, `allkeys-lru` is the sane default.
- **`volatile-*` needs TTLs to do anything.** If few keys carry an expiry it has almost nothing to evict and **behaves like `noeviction`**. A TTL also costs a few bytes per key, so `allkeys-lru` is **leaner** than `volatile-lru` for a pure cache.
- **LRU evicts by recency, LFU by frequency.** Reach for `allkeys-lfu` when a hot subset stays hot and you do not want a one-off bulk scan to flush it. LFU's counter decays over time (`lfu-log-factor`, `lfu-decay-time`), so yesterday's hot key will not stay un-evictable forever.
- **LRU, LFU, and LRM are approximated by sampling, not exact.** Redis samples `maxmemory-samples` keys (default `5`) and evicts the worst of that sample. Raise it toward `10` for closer-to-true ordering at a little more CPU.
- **In-place mutations keep the TTL, a full overwrite wipes it.** `INCR`, `LPUSH`, `HSET` leave the countdown alone, but `SET` and `GETSET` reset the key to no-expiry (use `SET ... KEEPTTL` to keep it). `TTL` returns the seconds left, `-1` if the key has no expiry, `-2` if it is already gone. Redis 7's `EXPIRE ... GT` only pushes a TTL further out, never shortening it.
- **Expiry runs two ways:** passively when a client touches the key, and actively via a background job that samples random TTL'd keys and reaps the dead ones. Neither is instant, so an expired key can still occupy memory and count toward `maxmemory` for a moment.

> [!TIP] Set the TTL in the same write - `SET key val EX 300` - not a separate `EXPIRE` afterwards. A two-step write leaves a window where the key is immortal if that second call fails.

## Example
```bash
# value + TTL in one atomic write (30 min) - no immortal-key window
SET session:abc "{...}" EX 1800
TTL  session:abc               # seconds left; -1 = no expiry, -2 = already gone
PERSIST session:abc            # drop the expiry, make the key stick around

# turn this instance into a bounded LRU cache
CONFIG SET maxmemory 2gb
CONFIG SET maxmemory-policy allkeys-lru
CONFIG SET maxmemory-samples 10   # closer-to-true LRU, a little more CPU
```

Spread expiries so a wave of keys does not all die in the same second:

```python
import random
# avoid: 10k keys written together all expire at once -> DB stampede
r.set(key, val, ex=3600)

# good: jitter the TTL ~10-20% so expiries spread out over time
r.set(key, val, ex=3600 + random.randint(0, 600))
```

## Interview Q&A
- **TTL vs eviction - same thing?** No. TTL is a per-key expiry for freshness. Eviction is what Redis does when it hits `maxmemory`. A key can be evicted before its TTL, and an expired key can linger until it is reaped.
- **`allkeys-*` vs `volatile-*`?** `allkeys-*` can evict any key. `volatile-*` only evicts keys that carry a TTL, so if almost nothing has a TTL it behaves like `noeviction` and you can still OOM.
- **LRU vs LFU (vs LRM)?** LRU drops the least recently accessed key, LFU the least frequently accessed. LFU wins when some keys are permanently hot and you do not want a big sequential scan to evict them. Redis 8.6 adds LRM (least recently modified), which tracks writes only and ignores reads.
- **What is the default policy, and why is it a cache trap?** `noeviction`. When memory is full it rejects data-adding writes with an error instead of freeing space - safe for a datastore, usually wrong for a cache. Switch to `allkeys-lru` (or `allkeys-lfu`).
- **Is Redis LRU exact?** No. It samples `maxmemory-samples` keys (default `5`) and evicts the worst one. Raise it toward `10` for closer-to-true LRU at some CPU cost - same story for LFU and LRM.

## Gotchas
> [!WARN] **`volatile-*` can only evict keys that have a TTL.** If few keys carry one it acts like `noeviction` and you OOM despite "having an eviction policy set". The same growth-until-writes-fail trap hits the default `noeviction` when you set no `maxmemory` cap.

> [!WARN] **Synchronized TTLs cause stampedes.** Write 10k keys with an identical one-hour TTL and they all expire in the same second, dropping the whole load onto your DB at once. Add roughly **10-20% jitter** to spread the expiries out.

- A **full overwrite silently drops the TTL**: `SET key newval` on a key that had an expiry makes it immortal again. Reattach the TTL on every write, or pass `KEEPTTL` when you mean to keep it.
- **Eviction ordering is sampled, not perfect.** If evictions look wrong, check `evicted_keys`, `keyspace_hits`/`keyspace_misses`, and `expired_keys` in `INFO stats`, then consider a higher `maxmemory-samples` or a different policy.
- **Replicas do not expire keys on their own.** A replica waits for the `DEL` from the primary, so between logical expiry and that delete a stale value can still be read off a replica. Do not treat a replica read as guaranteed-fresh.
- **Big writes can briefly blow past `maxmemory`** (a large `SINTERSTORE`, say), and the replication/AOF buffer is not counted against the cap. Leave RAM headroom rather than setting `maxmemory` to your full available memory.

## Revise next
- [Cache invalidation](cache-invalidation.md) and stampede protection (locks, early recompute)
- [Redis data structures](redis-data-structures.md) and when each one fits
- [Cache strategies](cache-strategies.md) (cache-aside, write-through, write-behind)

*Reviewed against Redis 8.8, July 2026.*
