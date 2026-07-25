---
title: "Scaling the Database"
group: "Design Fundamentals"
order: 2
---

# Scaling the Database

> Database scaling is a ladder you climb in order - indexes and query fixes, then read replicas, then a bigger box, then partitioning, then sharding - and every rung you skip costs you an order of magnitude more operational pain than the one you skipped it for.

## What it is
"The database is slow" is almost never a capacity problem the first three times you hear it. It is a missing index, an N+1, or a query pulling 400k rows to count them. The ladder exists because each rung is cheaper, more reversible, and more likely to be the actual cause than the one above it.

> [!KEY] Climb in order, and stop as soon as it is fast enough. **Sharding is the last rung for a reason**: it is the only step that permanently removes capabilities from your database - cross-shard joins, foreign keys, and multi-row transactions all stop working the day you shard, and you never get them back.

| Rung | Typical win | What it costs | Reversible? |
| --- | --- | --- | --- |
| **1. Indexes and query fixes** | 10x-1000x on the offending query | Write amplification, disk | Yes - `DROP INDEX` |
| **2. Read replicas** | Scales *read* throughput near-linearly | Replica lag, read-your-writes bugs | Yes |
| **3. Vertical (bigger instance)** | 2x-4x everything, zero code change | Money, a failover reboot, a hard ceiling | Yes |
| **4. Partitioning** | Cheap archival, smaller indexes, pruning | PK must include the partition key | Painful |
| **5. Sharding** | Scales *writes* horizontally | Cross-shard joins, hot shards, resharding | Effectively no |

Two things sit *beside* the ladder rather than on it and are worth doing early: **connection pooling** (PgBouncer in transaction mode - PostgreSQL's `max_connections` defaults to 100 and each backend is a full OS process, so 500 Gunicorn workers against RDS will exhaust it long before CPU is the issue) and **caching** ([Caching layers and stampede](caching-layers-stampede.md)), which removes read load rather than absorbing it.

## Key points
- **Measure before you climb, with `pg_stat_statements`, not with intuition.** Sort by `total_exec_time` rather than `mean_exec_time` - the query that takes 4 ms but runs 90,000 times a minute is your problem, not the 2-second report that runs hourly. Then `EXPLAIN (ANALYZE, BUFFERS)` the top three; see [EXPLAIN and query plans](../databases/explain-analyze.md).
- **Composite index column order is equality first, then range, then sort.** An index on `(status, created_at)` serves `WHERE status='pending' ORDER BY created_at` perfectly; `(created_at, status)` cannot use the second column to seek. And a **partial index** - `WHERE status = 'pending'` - on a table where 0.1% of rows are pending is a fraction of the size and stays in cache. Details in [Indexing with B-trees](../databases/indexing-btree.md).
- **Read replicas scale reads and nothing else.** Every write still goes to the single primary and is replayed on every replica, so adding replicas adds *zero* write capacity and slightly increases primary load. They also hand you asynchronous replication and its consequences - stale reads, read-your-writes violations - covered in [Consistency and CAP](consistency-cap-retries.md).
- **Vertical scaling is underrated and you should do it before partitioning.** An RDS `db.r6g.2xlarge` to `db.r6g.8xlarge` bump is a parameter change and a maintenance-window reboot (Multi-AZ failover, roughly 60-120 seconds) and it buys you 4x CPU and RAM. Engineers skip it because it feels like giving up, then spend two quarters on a sharding project that a $900/month instance would have deferred by two years.
- **Partitioning splits one table across many; sharding splits one database across many servers.** This is the distinction interviewers probe. Declarative partitioning (PostgreSQL 10+, `PARTITION BY RANGE | LIST | HASH`) keeps everything in one database - joins, transactions, and foreign keys all still work. The planner prunes irrelevant partitions, indexes get smaller, and archival becomes `DROP TABLE payments_2024_01` instead of a `DELETE` that leaves 40 GB of bloat for `VACUUM` to chew through.
- **The shard key is the decision you cannot walk back.** It must be high-cardinality, evenly distributed, and - the part people miss - **present in the majority of your queries**, because any query without it becomes a scatter-gather across every shard. In fintech, `merchant_id` is the tempting choice and often the wrong one: one enterprise merchant doing 60% of volume gives you a hot shard that no amount of rebalancing fixes.

> [!TIP] Shard into **logical buckets, not physical servers**. Hash the key into 1024 buckets on day one and map ranges of buckets to the 4 servers you actually have. Growing to 8 servers then moves bucket ranges - a data migration - instead of rehashing every row, which is a rewrite of the entire dataset.

## Example
Start at rung 1, and let the database tell you where it hurts:

```sql
-- Rung 1: find the real cost centres. total_exec_time, not mean.
SELECT
  calls,
  round(total_exec_time::numeric, 1) AS total_ms,
  round(mean_exec_time::numeric, 2)  AS mean_ms,
  round(100 * total_exec_time / sum(total_exec_time) OVER (), 1) AS pct,
  query
FROM pg_stat_statements
ORDER BY total_exec_time DESC
LIMIT 10;

-- A partial index: settlements pending is ~0.1% of a 200M-row table, so this
-- index is ~200k entries instead of 200M and stays resident in shared_buffers.
CREATE INDEX CONCURRENTLY idx_payments_pending
  ON payments (created_at)
  WHERE status = 'pending';
-- CONCURRENTLY avoids the ACCESS EXCLUSIVE lock that would stall writes for
-- the whole build. It costs two table scans and can leave an INVALID index
-- if it fails - check indisvalid in pg_index afterwards.
```

Rung 4, partitioning a payments table by month - the shape that makes archival free:

```sql
CREATE TABLE payments (
    id            bigserial,
    merchant_id   bigint      NOT NULL,
    amount_minor  bigint      NOT NULL,
    status        text        NOT NULL,
    created_at    timestamptz NOT NULL,
    -- The partition key MUST be in every unique constraint, including the PK.
    -- This is the constraint that surprises people: you cannot keep a bare
    -- PRIMARY KEY (id) on a partitioned table.
    PRIMARY KEY (id, created_at)
) PARTITION BY RANGE (created_at);

CREATE TABLE payments_2026_07 PARTITION OF payments
    FOR VALUES FROM ('2026-07-01') TO ('2026-08-01');

-- Pruning only happens when the WHERE clause mentions the partition key.
-- This one touches a single partition:
EXPLAIN SELECT sum(amount_minor) FROM payments
 WHERE created_at >= '2026-07-01' AND created_at < '2026-08-01';

-- This one scans all 60 partitions, and is the mistake that makes teams
-- conclude "partitioning didn't help":
EXPLAIN SELECT sum(amount_minor) FROM payments WHERE merchant_id = 42;
```

Rung 5, application-level sharding through a bucket map so resharding stays a data move:

```python
import hashlib
from django.db import connections

LOGICAL_BUCKETS = 1024
# 4 physical shards today. Doubling to 8 re-slices this dict; it does not
# rehash a single row.
BUCKET_MAP = {range(0, 256): "shard0", range(256, 512): "shard1",
              range(512, 768): "shard2", range(768, 1024): "shard3"}

def shard_for(merchant_id: int) -> str:
    # md5, not hash() - Python's hash() is salted per process since 3.3 and
    # would route the same merchant to a different shard on every restart.
    digest = hashlib.md5(str(merchant_id).encode()).digest()
    bucket = int.from_bytes(digest[:4], "big") % LOGICAL_BUCKETS
    for rng, alias in BUCKET_MAP.items():
        if bucket in rng:
            return alias
    raise LookupError(bucket)

def merchant_payments(merchant_id: int):
    # Single-shard query: fast. Anything WITHOUT merchant_id in the predicate
    # has to fan out to all four and merge in Python - that is the tax.
    with connections[shard_for(merchant_id)].cursor() as cur:
        cur.execute(
            "SELECT id, amount_minor FROM payments WHERE merchant_id = %s",
            [merchant_id],
        )
        return cur.fetchall()
```

## Interview Q&A
- **How would you scale a database that is falling over?** In order: profile with `pg_stat_statements` and fix the top queries and indexes, then add read replicas if the load is read-heavy, then scale the instance vertically, then partition large tables, and only shard if writes genuinely exceed one primary. Most production incidents stop at the first rung.
- **What is the difference between partitioning and sharding?** Partitioning splits one table into pieces inside one database - joins, transactions and foreign keys still work, and the planner prunes partitions. Sharding splits data across separate database servers, which scales writes but gives up cross-shard joins, cross-shard transactions and foreign keys.
- **How do you choose a shard key?** High cardinality, even distribution, and present in most query predicates. Test it against your actual query log: if more than a small fraction of queries lack the key, every one of those becomes a scatter-gather and you have built a slower distributed database.
- **What breaks after you shard?** Joins across shards, foreign keys, `ORDER BY ... LIMIT` over the whole dataset, `COUNT(*)`, and multi-row transactions. You replace them with denormalisation, application-side merges, and sagas or two-phase commit - each of which is a new source of bugs.
- **Do read replicas help with write-heavy load?** No. Every write still lands on the single primary and is then replayed on each replica, so replicas add read capacity and marginally *increase* primary work. Write scaling means sharding, batching, or moving the write elsewhere.
- **Why not just shard from day one?** Because it costs you relational guarantees permanently, and the shard key you pick before you know your access patterns is almost always wrong. Resharding a live payments dataset is a multi-month project with a dual-write window and a backfill.

## Gotchas
> [!WARN] **`CREATE INDEX` without `CONCURRENTLY` takes an `ACCESS EXCLUSIVE` lock** and blocks every read and write on that table for the whole build - minutes to hours on a large table. In Django, a bare `AddIndex` migration does exactly this. Use `AddIndexConcurrently` from `django.contrib.postgres.operations`, and set `atomic = False` on the migration, because `CONCURRENTLY` cannot run inside a transaction block.

> [!WARN] **Indexes are not free - they are a tax on every write.** Each index on a table is an extra structure to update on `INSERT`, `UPDATE` and `DELETE`, and unused indexes still cost that write amplification plus disk plus `VACUUM` time. Audit with `pg_stat_user_indexes` for `idx_scan = 0` and drop what nothing reads.

- **A hot shard cannot be fixed by adding shards.** If one merchant is 60% of volume, splitting into 16 shards leaves that merchant's shard at 60% of the load and 15 shards idle. The fix is a composite key (`merchant_id` plus a sub-bucket) decided up front, not more hardware later.
- **Partitioning a table with the wrong key is worse than not partitioning.** Queries that do not filter on the partition key scan *every* partition, so you have added planning overhead and lost nothing but the illusion of progress. Check `EXPLAIN` shows pruning before you ship.
- **Replica lag makes read-after-write silently wrong.** The write commits, the read hits a replica that has not replayed it, and the API returns a `404` for a resource that exists. Route reads that gate a decision to the primary.
- **You need a scheduled job to create future partitions.** A `RANGE`-partitioned table with no partition for next month rejects the insert outright. Either use `pg_partman` or a Celery Beat task that creates three months ahead - and alert if it fails, because the failure surfaces at midnight on the first.
- **Vertical scaling has a real ceiling and a real reboot.** RDS tops out per family, and the resize is a Multi-AZ failover. Plan it in a window; do not discover it at 3 a.m.

## Revise next
- [Indexing with B-trees](../databases/indexing-btree.md): rung 1, the one that solves most cases
- [Replication, sharding, and partitioning](../databases/replication-sharding-partitioning.md): the mechanics of rungs 2, 4 and 5
- [Consistency and CAP](consistency-cap-retries.md): what read replicas do to your correctness guarantees
- [Caching layers and stampede](caching-layers-stampede.md): removing read load instead of absorbing it

*Reviewed against PostgreSQL 18 and Amazon RDS docs, July 2026.*
