---
title: "Replication & Sharding"
group: "Schema & Scaling"
order: 9
---

# Replication, Sharding & Partitioning

> Three different fixes for a database under strain: replication copies the whole dataset to other nodes for reads and failover, partitioning slices one big table into smaller pieces inside a single database, and sharding spreads data across independent nodes by a key so writes and storage scale past one machine.

## What it is
Each technique solves a different bottleneck, so the first move in any scaling question is naming which one the symptom calls for.

| Technique | What it moves | Scope | Scales | Main cost |
| --- | --- | --- | --- | --- |
| **Replication** | A **full copy** of the dataset | Many nodes, **identical** data | **Reads + failover** | Replica **lag**, stale reads |
| **Partitioning** | One table cut into **pieces** | **One** node and database | Maintenance + pruning, **no new capacity** | Planner **slows** past a few thousand parts |
| **Sharding** | **Disjoint slices** of rows | Many **independent** nodes | **Writes + storage** | **Cross-node** joins and transactions |

> [!KEY] **Copies vs slices.** Replication makes **copies** (more read capacity, survives a node death). Partitioning and sharding make **slices**: partitioning slices **within one box** (smaller pieces, no new capacity), sharding slices **across boxes** (real write and storage capacity).

- Replication keeps full copies of the database on other servers: read replicas spread query load, and a hot standby takes over when the primary dies. Every node holds the same data, so it scales reads and availability but never write throughput.
- Partitioning and sharding both split a large dataset at different scope. Partitioning breaks one table into physical pieces inside a single database, buying manageable table sizes. Sharding spreads data across separate independent nodes, buying write and storage capacity beyond one machine.

## Key points
- **Replication rides the WAL.** The primary streams write-ahead log records to each standby as they are generated, without waiting for a segment to fill, so a healthy replica trails by well under a second. Replicas serve read-only traffic (Postgres calls that a **hot standby**), and one can be promoted with `pg_promote()` on failover. Writes always land on the primary.
- **Async by default, and that buys a small loss window.** Streaming replication is asynchronous out of the box: the primary commits and answers the client before the standby has the record, so a crash loses whatever had not shipped yet. Set `synchronous_standby_names` to make commit wait for a standby, at the cost of a primary-to-standby round trip on every commit.
- **Synchronous has levels, not just on and off.** With a sync standby named, `synchronous_commit` trades latency for durability one step at a time:

| `synchronous_commit` | Commit waits until | What it survives / enables |
| --- | --- | --- |
| `on` | Record is **flushed to disk** on both nodes | Standby **Postgres and OS crash** |
| `remote_write` | Standby's **OS holds** the record | Postgres crash, **not** an OS crash |
| `remote_apply` | Standby has **replayed** it | Lets a client **read its own write** off that replica |

- **Partitioning is one table cut into pieces on the same node.** Declarative partitioning splits by one of three strategies and adds no capacity - the whole table still lives in one database. What it buys is smaller indexes, cheaper `VACUUM`, and **partition pruning**, where the planner skips any partition that provably cannot match the `WHERE` clause, at plan time and (for values known only at runtime) execution time.

| Strategy | Splits by | Typical use |
| --- | --- | --- |
| **RANGE** | Ordered bounds (dates, id ranges) | **Time-series**, rolling windows |
| **LIST** | An explicit value set | Region, **tenant**, status |
| **HASH** | Modulus and remainder | **Even spread** with no natural range |

- **The killer partitioning feature is cheap bulk delete.** Ageing out old data with `DROP TABLE partition` or `ALTER TABLE ... DETACH PARTITION` is near-instant and skips the `VACUUM` churn a bulk `DELETE` drags in. Keep the count sane: the planner handles up to a **few thousand** partitions well, not tens of thousands.
- **Sharding spreads rows across independent nodes by a shard key.** Pick a key such as `user_id`, hash or range it, and each node owns a slice. This is the only option here that scales writes and total storage past a single machine. DynamoDB productizes the idea: it hashes the partition key to place every item, and a single key can never run faster than the one physical partition it lands on.
- **A good shard key is boring: high cardinality, evenly hit, and aligned with how you query.** Get it wrong and one node becomes a **hot partition** while the rest idle. The fix is **write sharding**: append a suffix to fan one hot key across N sub-partitions (see Example).
- **Scale in order.** Bigger box first, then a read replica or two, then partition the giant tables, and only shard when a single primary genuinely cannot hold the write volume or the data.

## Example
```sql
-- PostgreSQL declarative partitioning by date range
CREATE TABLE events (
    id         bigint,
    created_at date not null,
    payload    jsonb
) PARTITION BY RANGE (created_at);

-- lower bound inclusive, upper bound exclusive:
-- 2026-07-01 lands in this partition, 2026-10-01 does not (it opens the next quarter)
CREATE TABLE events_2026_q3 PARTITION OF events
    FOR VALUES FROM ('2026-07-01') TO ('2026-10-01');

-- a query filtered on created_at scans only the matching quarter (pruning);
-- expiring a whole quarter is a metadata op, no VACUUM churn:
--   ALTER TABLE events DETACH PARTITION events_2025_q3;
```

```python
# DynamoDB write sharding: fan one hot key across N sub-partitions.
# A raw date key sends all of today's writes to ONE partition (caps at 1,000 writes/s).
import hashlib
N = 200

def shard_key(day, order_id):                  # computed suffix from a value you already hold
    h = int(hashlib.md5(order_id.encode()).hexdigest(), 16)
    return f"{day}#{h % N}"                     # deterministic -> "2026-07-14#137"

# point read:    recompute the exact shard, then a single GetItem
key = shard_key("2026-07-14", "A-991")

# full-day read: Query all N shards ("2026-07-14#0".."#199") and merge (scatter-gather)
```

> [!TIP] The suffix choice is the tradeoff: a **random** suffix spreads writes best but forces a scatter-read to reassemble, while a **computed** suffix (hash of an attribute you already query on) can be recomputed later, so point reads still hit one shard.

## Interview Q&A
- **Replication vs sharding?** Replication puts a full copy of the data on more nodes to scale reads and survive failure. Sharding splits the data across nodes by a key to scale writes and storage. Copies versus slices.
- **Partitioning vs sharding?** Same instinct (split the data) at different scope. Partitioning splits a table within one database, so it helps maintenance and query planning but adds no capacity. Sharding splits across separate nodes and adds capacity, paid for with cross-node joins and transactions.
- **Sync vs async replication?** Async, the default, commits without waiting for the standby, so it's fast but a primary crash can lose the un-shipped tail. Sync waits for the standby to confirm, so no loss on a single failure, but every commit pays the round-trip latency.
- **What makes a good shard key?** High cardinality and even access, aligned with your most common query so most reads hit a single shard. Low-cardinality or time-clustered keys funnel load onto one node.
- **How do you fix a hot key you cannot design away?** Write sharding: spread it across N sub-keys with a suffix. Prefer a computed suffix (hash of an attribute you query on) over a purely random one, so you can recompute the shard for point reads instead of scattering across all N.

## Gotchas
> [!WARN] Do not read a user's **own write** back off an async replica right after committing to the primary, because replicas lag. Route that read to the **primary**, or to a `remote_apply` synchronous replica.

> [!WARN] A **single hot key throttles** no matter how much total throughput you provision: one partition key value maps to one physical partition, and that partition caps at roughly **3,000 reads and 1,000 writes per second**. Spread the key before you hit the wall, not after.

- Cross-shard joins and multi-shard transactions are slow or unsupported. Design the common path to stay inside one shard, or denormalize so the join disappears.
- Sharding too early is a self-inflicted wound. Exhaust a bigger box, read replicas, and partitioning first, because each shard multiplies your operational surface for good.

## Revise next
- [Connection pooling](connection-pooling.md)
- [SQL vs NoSQL](sql-vs-nosql.md) (horizontal scale)
- [ACID vs BASE / CAP theorem](acid-properties.md)

*Reviewed against PostgreSQL 18 and AWS DynamoDB docs, July 2026.*
