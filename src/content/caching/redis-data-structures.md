---
title: "Redis Data Structures"
group: "Redis in Practice"
order: 4
---

# Redis Data Structures

> Redis is a data-structure server: beyond plain strings you get hashes, lists, sets, and sorted sets - plus streams, bitmaps, HyperLogLog, geo, JSON and more - each with commands tuned to one access pattern, so the work runs server-side instead of in a read-modify-write round trip.

## What it is
- Redis is not a key-value store that only holds strings. The value itself is a **typed structure** - a hash, a list, a sorted set - and each one ships with commands that read and mutate it **in place**.
- The whole trick: match the structure to your access pattern and the operation runs server-side in **O(1)** or **O(log n)**, instead of fetching a blob, changing it in your app, and writing it back (slower, and it races with every other client doing the same).

> [!KEY] Pick the **structure that matches the access pattern**, not the one that matches your object. Each value is typed and every mutation is **atomic and server-side**, so you skip the fetch-modify-write round trip that races under load.

## Key points
Nine structures cover almost every job, each with a handful of commands and a natural use case:

| Type | Stores | Typical commands | Use case |
| --- | --- | --- | --- |
| **String** | bytes or a 64-bit int, up to 512 MB | `GET` `SET` `INCR` | cache values, **atomic counters**, IDs, flags |
| **Hash** | field-to-value map under one key | `HSET` `HGET` `HGETALL` `HEXPIRE` | an **object/record** (`user:42`), per-field updates |
| **List** | ordered linked list of strings | `LPUSH` `RPUSH` `BRPOP` `LTRIM` | **queues and stacks**, capped "latest N" feeds |
| **Set** | unordered **unique** members | `SADD` `SISMEMBER` `SINTER` | tags, unique visitors, **set math** (mutual friends) |
| **Sorted set** | members ordered by a **score** | `ZADD` `ZREVRANGE` `ZRANK` | **leaderboards**, priority queues, sliding windows |
| **Bitmap** | bits packed into a string | `SETBIT` `GETBIT` `BITCOUNT` | **one bit per user** daily-active flags |
| **HyperLogLog** | approximate cardinality (~12 KB) | `PFADD` `PFCOUNT` `PFMERGE` | **unique counts** at any scale, tiny memory |
| **Geospatial** | members with lon/lat | `GEOADD` `GEOSEARCH` `GEODIST` | **"nearby" / radius** queries |
| **Stream** | append-only log + consumer groups | `XADD` `XREADGROUP` `XACK` | **event logs**, durable work queues |

- **Big five vs the rest.** Strings, hashes, lists, sets, and sorted sets are the workhorses. Redis 8 also bundles into open-source core (no separate modules): **JSON** with JSONPath, **time series**, the **probabilistic** family (Bloom, Cuckoo, count-min, top-k, t-digest), **vector sets** for semantic search, and an index-addressable **Array** type (`ARSET`/`ARGET`, 8.8).
- **Atomic counters** need no lock: `INCR`/`INCRBY` do the read-modify-write in one step, so two clients can never lose an update. `SET key val EX 3600` bakes a TTL straight into the write.
- **Hashes since 7.4** can expire individual fields with `HEXPIRE`, which is handy for per-field session data.

> [!TIP] Redis 8.0 (May 2025) folded the once-paid Stack modules - JSON, Search, time series, probabilistic - into the core and relicensed under **AGPLv3** (OSI-approved), reversing the 2024 SSPL move that spawned the BSD-licensed, CNCF-backed **Valkey** fork.

## Example
```bash
SET    session:42 "tok" EX 3600            # string: value with a 1-hour TTL
INCR   page:views                          # string: atomic counter, no race
HSET   user:42 name "Ann" age 30           # hash: one key per object
LPUSH  queue:emails "job1"                 # list: push onto a work queue
BRPOP  queue:emails 5                      # list: blocking pop, 5s timeout
SADD   tags:post:9 redis cache             # set: unique tags, dupes ignored
ZADD   board 4200 "ann"                    # sorted set: member + score
ZREVRANGE board 0 9 WITHSCORES             # sorted set: top 10 by score
PFADD  visitors:today 42 43                # HyperLogLog: ~12 KB regardless of N
```

A fixed-window rate limiter in one atomic command, new in Redis 8.8:

```python
# INCREX folds INCR + bounds + EXPIRE into a single atomic call.
# UBOUND caps the window. ENX sets the 60s TTL only when the window is created.
new_val, applied = r.execute_command(
    "INCREX", f"ratelimit:{user_id}",
    "BYINT", 1, "UBOUND", 100, "EX", 60, "ENX",
)
if applied == 0:                 # 2nd return value 0 -> request is over the cap
    raise TooManyRequests
```

## Interview Q&A
- **Name Redis's core data structures.** Strings, hashes, lists, sets, and sorted sets. Everything else (streams, bitmaps, HyperLogLog, geo, JSON, time series, probabilistic types, vector sets, arrays) sits alongside those five or builds on them.
- **When would you reach for a sorted set over a set?** When the requirement is "ordered by some number": leaderboards, priority queues, or a sliding-window rate limiter keyed on a timestamp score. If you do not need ordering, a plain set is cheaper in memory and CPU.
- **Hash or a serialized string for an object?** Hash, nearly always. You update one field without rewriting the rest, it stays compact for small objects, and you can TTL fields individually with `HEXPIRE`. A JSON string blob forces a full read-modify-write on every change and races when two clients write at once.
- **What changed with Redis 8?** It pulled JSON, Search, time series, probabilistic types, and vector sets into open-source core (they used to be Stack modules), and 8.8 added an `Array` type plus `INCREX`, a one-command window-counter rate limiter. Licensing moved back to AGPLv3 - see the tip above.

## Gotchas
> [!WARN] `KEYS *` is O(N) over the whole keyspace, and Redis runs commands on a **single thread**, so it stalls every other client until it finishes. Use `SCAN` (cursor-paginated) instead. The same trap hides in `HGETALL`, `SMEMBERS`, and `LRANGE 0 -1` on a huge collection.

> [!WARN] Using the **wrong structure** for the access pattern is the quiet killer: scanning a list for membership is O(N) where a set gives O(1) `SISMEMBER`, and sorting results in your app is wasted work when a sorted set keeps them ordered for free.

For an object, a serialized blob and a hash behave very differently once two writers overlap:

| Approach | Update cost | Concurrency |
| --- | --- | --- |
| **JSON string blob** | full **read-modify-write** per edit | overlapping writers -> **lost update** |
| **Hash** or **JSON type** (JSONPath) | **one field** in place | field writes **do not clobber** each other |

- Big collections bite you: cap lists with `LTRIM`, and shard a huge set or hash across many keys so no single command goes O(N).
- Indexing into the middle of a list is O(N) - it is a linked list, not an array. Reach for the `Array` type or a different model when you need random access.

## Revise next
- **[Redis use cases](redis-use-cases.md)**: caching, sessions, queues, rate limiting, leaderboards, pub/sub.
- **[TTL & eviction policies](ttl-eviction-policies.md)**: the eight `maxmemory-policy` options (`noeviction`, `allkeys`/`volatile` x `lru`/`lfu`/`random`, and `volatile-ttl`) and when each fits.
- **[Cache strategies](cache-strategies.md)**: cache-aside, write-through, write-behind, and stampede control.

*Reviewed against Redis 8.8, July 2026.*
