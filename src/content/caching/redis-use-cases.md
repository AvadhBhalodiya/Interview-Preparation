---
title: "Redis Use Cases"
group: "Redis in Practice"
order: 5
---

# Redis Use Cases

> Beyond caching, Redis doubles as a rate limiter, session store, pub/sub bus, leaderboard, and lock manager, because each of those is really just a data structure plus a couple of atomic commands.

## What it is
Redis keeps its data in memory as **typed structures** - strings, hashes, lists, sets, sorted sets, and streams, plus newer built-ins like JSON, bitmaps, HyperLogLog, geospatial, vector sets, and an Array type added in 8.8 - and runs commands **single-threaded**, so every command is **atomic**. That atomicity is the real reason it spreads past caching: you get correct behaviour under concurrency without writing locks in your own code.

> [!KEY] For any "can Redis do X?" question, answer in two moves: **name the structure**, then **name the two or three atomic commands**. A leaderboard is a sorted set, a lock is a string `SET` with `NX`, a rate limiter is a counter with a TTL.

The everyday patterns map cleanly onto one structure and a handful of commands:

| Use case | Structure | Key commands / pattern |
| --- | --- | --- |
| Caching | **string / hash** + TTL | `SET key val EX ttl`, cache-aside on hot reads |
| Rate limiting | **string** counter or **sorted set** | `INCR`+`EXPIRE`, `INCREX` (8.8), or ZSET sliding window |
| Sessions | **hash / string** + TTL | one shared TTL'd store for every app node |
| Pub/Sub | **channel** | `PUBLISH` / `SUBSCRIBE`, at-most-once fan-out |
| Queues / Streams | **stream** + consumer groups | `XADD` / `XREADGROUP` / `XACK`, at-least-once + replay |
| Leaderboards | **sorted set** | `ZADD`, `ZRANGE ... REV`, `ZREVRANK`, all O(log n) |
| Distributed locks | **string** token | `SET key token NX PX ttl`, release with `DELEX ... IFEQ` |

> [!TIP] A Redis used as a cache should run with `maxmemory` set and a `maxmemory-policy` of `allkeys-lru` or `allkeys-lfu`, not the default `noeviction` - otherwise a full cache stops accepting writes instead of dropping cold keys.

## Key points
- **Caching** is the load-shedding job, the only one here that exists to spare your database. Cache-aside: check Redis, and on a miss read the source and write it back with `SET key val EX ttl`. The TTL does double duty, bounding staleness and capping memory so cold keys expire themselves.
- **Rate limiting** comes in three tiers. Fixed window is `INCR` a per-window key then `EXPIRE` it: cheap, but a client can burst up to 2x across the boundary. Sliding window logs each request timestamp in a sorted set and counts what falls inside the window, which is accurate but heavier. Redis 8.8's `INCREX` folds increment, cap, and TTL into one atomic command.
- **Sessions** live in a TTL'd hash or serialized string, so idle sessions expire on their own. The payoff is a stateless app tier: any node serves any request, and a deploy signs no one out. `HEXPIRE` (7.4+) can even expire individual hash fields.
- **Pub/Sub** is `PUBLISH` to a channel and every connected `SUBSCRIBE`r gets it, at-most-once. Fine for cache-invalidation signals, presence, and live notifications where a dropped message is survivable.
- **Streams** persist messages in an append-only log, and consumer groups (`XADD`, `XREADGROUP`, `XACK`) add at-least-once delivery, per-message acks, and replay. This is the shape for job queues and event pipelines, and how Redis backs task brokers.
- **Leaderboards** are what a sorted set is built for. `ZADD` sets a score, `ZINCRBY` bumps it atomically, `ZRANGE board 0 9 REV WITHSCORES` reads the top ten, and `ZREVRANK` gives a player's position, all O(log n). (`ZREVRANGE` still runs but has been the deprecated spelling of `ZRANGE ... REV` since 6.2.)
- **Distributed locks** use `SET key token NX PX ttl` to grab a mutex that auto-expires, so a crashed holder cannot wedge the resource forever. Release by deleting only if the token still matches: `DELEX key IFEQ token` on 8.4+, or a Lua compare-and-delete on older servers. Plain `DEL` is a latent bug that eventually deletes someone else's lock.
- **Also worth knowing:** `INCR` for counters and metrics, and `HyperLogLog` (`PFADD` / `PFCOUNT`) for approximate unique counts (millions of uniques in about 12 KB, for a small error margin).

## Example
```python
# Fixed-window rate limit: 100 requests per minute per user.
key = f"rl:{user_id}:{minute}"
n = r.incr(key)                 # atomic, creates the key at 1 on the first hit
if n == 1:
    r.expire(key, 60)           # set the TTL only when the window is created
if n > 100:
    raise TooManyRequests
# INCR and EXPIRE are two round trips. A crash in between leaves the key with
# no TTL, quietly blocking that user forever, so pipeline them or use INCREX.
```

Redis 8.8 collapses that whole pattern into one atomic command:

```python
# INCREX does increment + cap + TTL in one shot, no Lua needed.
# Returns [new_value, actual_increment]. actual_increment == 0 means rejected.
new_val, applied = r.execute_command(
    "INCREX", f"rl:{user_id}", "BYINT", 1, "UBOUND", 100, "EX", 60, "ENX",
)
if applied == 0:
    raise TooManyRequests       # cap already reached for this window
```

```python
# Leaderboard on a sorted set: the score is the sort key, reads stay ordered.
r.zincrby("board", 50, "ann")                        # atomic score += 50
r.zrange("board", 0, 2, desc=True, withscores=True)  # top 3 -> [('ann', 4250.0), ...]
r.zrevrank("board", "ann")                           # ann's 0-based rank from the top
# desc=True emits ZRANGE ... REV on the wire (the modern form of ZREVRANGE).
```

```python
# Distributed lock: SET NX PX is one atomic call (only-if-absent + auto-expiry).
token = uuid4().hex                                  # unique owner token
got = r.set("lock:job", token, nx=True, px=10_000)   # None if already held
if got:
    try:
        do_work()
    finally:
        r.execute_command("DELEX", "lock:job", "IFEQ", token)  # 8.4+ CAS delete
```

## Interview Q&A
- **How would you rate limit with Redis?** Fixed window is `INCR` plus `EXPIRE` on a per-user, per-window key. For strictness at the boundary, a sorted set of timestamps gives a true sliding window. On Redis 8.8, `INCREX` does the whole thing atomically in one command.
- **Why put sessions in Redis instead of app memory?** To keep the app tier stateless. In-process sessions break behind a load balancer (the next request may hit a different node) and vanish on redeploy. A shared, TTL'd store fixes both.
- **How do you build a leaderboard?** A sorted set. `ZADD` / `ZINCRBY` to write scores, `ZRANGE ... REV` for top-N, `ZREVRANK` for a player's rank, all O(log n).
- **Pub/Sub vs Streams, when each?** Pub/Sub is at-most-once, fire-and-forget fan-out, fine for signals you can afford to miss. Streams persist messages and add consumer groups with acks and replay, so reach for them when every message must be processed.
- **How do you release a distributed lock safely?** Store a unique token as the value and delete only if it still matches (`DELEX ... IFEQ`, or a Lua compare-and-delete). Otherwise a slow client whose lock already expired deletes the next holder's lock.

Pub/Sub and Streams both fan messages out, but they split on whether a message survives an absent consumer:

| Aspect | Pub/Sub | Streams |
| --- | --- | --- |
| Delivery | **at-most-once**, fire-and-forget | **at-least-once**, acked |
| Persistence | **none**, nothing is stored | **append-only log**, replayable |
| Offline consumer | message is **lost** | message **waits** in the log |
| Consumer groups | no | **yes** (`XREADGROUP` / `XACK`) |
| Reach for it when | loss is survivable (signals, presence) | **every message must be processed** (jobs, events) |

## Gotchas
> [!WARN] A single-node `SET ... NX PX` lock is a **best-effort mutex, not a correctness guarantee**. Its TTL runs on the wall clock, so a GC pause or clock jump can expire the lock while the holder still believes it owns it, handing the same lock to two clients. For correctness-critical work add a **fencing token** (a monotonic number the protected resource checks and rejects if stale). Multi-node **Redlock** is debated (Kleppmann vs antirez) and still does not remove the need for fencing.

> [!WARN] **Pub/Sub has no memory.** A subscriber disconnected or restarting during a `PUBLISH` never sees that message, and there is no backlog to replay. If loss is not acceptable, that is your cue to move to Streams.

- Fixed-window limiters leak at the edges: 100 requests just before the window rolls plus 100 just after is 200 in a couple of seconds. Use a sliding window or token bucket when the limit has to be strict.
- Do not treat Redis as the only home for data you cannot lose. Eviction under `maxmemory` and the default once-per-second AOF fsync both mean data can disappear on a bad day. Sessions and locks that must survive need persistence configured.
- `INCREX` is new in 8.8 open source and is not yet available on Redis Software or Redis Cloud. Confirm support before depending on it, and keep the Lua or `INCR`+`EXPIRE` fallback for older servers.

## Revise next
- [Redis data structures](redis-data-structures.md), including newer types (JSON, streams, vector sets)
- [Cache strategies](cache-strategies.md) and [invalidation](cache-invalidation.md), plus `maxmemory` [eviction policies](ttl-eviction-policies.md)
- [Celery](../task-processing/celery-architecture.md) / [task queues](../task-processing/message-brokers-redis-rabbitmq-sqs.md) (Redis as broker)
- Redis licensing: AGPLv3 since Redis 8, and the CNCF-backed Valkey fork

*Reviewed against Redis 8.8, July 2026.*
