---
title: "DynamoDB"
group: "Postgres & NoSQL"
order: 12
---

# DynamoDB: Keys, GSI/LSI, Single-Table Design

> DynamoDB is AWS's managed, serverless key-value/document store where you design keys and indexes around your access patterns up front: the partition key picks the physical partition, an optional sort key orders items within it, GSIs and LSIs add alternate query paths, and single-table design serves related entities from one table.

## What it is
- A fully managed, serverless NoSQL store (key-value and document) that returns consistent single-digit-millisecond reads and writes and holds that latency as data grows, because it hashes the partition key across ever more physical partitions.
- The mental shift from SQL is the whole game. You don't normalize now and query freely later. You list every access pattern first, then shape keys and indexes so each one is a direct key lookup or a single `Query`. AWS is blunt about this: don't design the schema until you know the questions it has to answer.

> [!KEY] Relational design is data-first, DynamoDB is **query-first**. Enumerate the access patterns, then build keys so each is one `GetItem` or one `Query`. There are no joins, so any pattern you forgot to design a key for degrades into a full-table `Scan`.

## Key points
- **Primary key, two shapes.** The partition (hash) key value is hashed to pick the physical partition, so it controls placement. Key attributes must be scalar (string, number, or binary).

The primary key is either one attribute or two:

| Key type | Made of | Gives you |
| --- | --- | --- |
| **Simple** | partition key **only** | key-value lookups: `GetItem` on one exact key, **no ranges** |
| **Composite** | partition key **+ sort key** | items sharing a PK stored **together and sorted by SK**, so one `Query` reads a range |

Under a composite key the `Query` sort-key condition can be `=`, `<`, `<=`, `>`, `>=`, `between`, or `begins_with`, while the partition key is always an exact match. That physical co-location and ordering is what makes range and prefix reads cheap.

- **Query vs Scan.** Narrow with the key, never the filter:

| Operation | Reads | Bills you for |
| --- | --- | --- |
| **`Query`** | one partition: **PK equality** + optional SK condition | only the **items matched** |
| **`Scan`** | **every item** in the table or index | **every item examined**, filter or not |

Both return at most 1 MB per call and paginate through `LastEvaluatedKey`. A `FilterExpression` is applied after the read, so a filtered `Scan` still bills for the whole table.

- **Hot partitions are a key-design problem.** Each physical partition tops out near 3,000 read units and 1,000 write units per second, and a unit covers only ~4 KB read / ~1 KB write, so item size counts. Pick a high-cardinality, evenly hit partition key or one key gets hammered and throttles while the table overall has spare capacity. Adaptive capacity absorbs mild skew, not a genuinely bad key like `status` or one whale tenant's id.

- **GSI vs LSI.** Two ways to add an alternate query path:

| Property | **GSI** (global) | **LSI** (local) |
| --- | --- | --- |
| Keys | **own** PK + optional SK, unrelated to base | **base PK** + alternate SK |
| Capacity | **separate** from the base table | **shared** with the base table |
| Consistency | **eventual only** | **strong** or eventual |
| Lifecycle | add or drop **anytime** on a live table | **create-time only**, permanent |
| Limits | up to 20, **no size cap** | up to 5, **10 GB** per PK value |

Reach for a GSI by default. Pick an LSI only when you need strongly consistent reads on an alternate sort key.

- **Single-table design.** Store several entity types in one table behind generic keys (`PK`/`SK`) and overload them, so a single `Query` returns an item plus its related children (an "item collection"). With no joins, co-locating and pre-sorting related data is how you answer a pattern in one round-trip. AWS's rule is "as few tables as possible," but do not make it dogma. Newer AWS examples split entities with low access correlation across separate tables and lean on GSIs, and time-series or wildly different access patterns are the usual exceptions.

> [!TIP] Overload the sort key with typed prefixes like `PROFILE` and `ORDER#<date>`, then `begins_with(SK, "ORDER#")` pulls just one entity type out of an item collection. A composite `GSI1PK` / `GSI1SK` adds a second access pattern over the same items without a second table.

- **Capacity modes, transactions, streams.** Two ways to pay for throughput:

| Mode | You set | Fits |
| --- | --- | --- |
| **On-demand** | **nothing** - it scales itself | the **default** AWS recommends, spiky or unknown load |
| **Provisioned** | **RCU/WCU** (optionally auto-scaled) | **steady, predictable** traffic |

You can switch a table between modes at any time. `TransactWriteItems` / `TransactGetItems` give ACID all-or-nothing across up to 100 items or 4 MB within one account and Region. Streams emit an ordered change log with 24-hour retention for CDC, cross-Region replication, and Lambda triggers.

## Example
```python
from boto3.dynamodb.conditions import Key

# Single-table design: one table holds users, their profile, and their orders.
# PK groups an entity's items; SK sorts them AND encodes the type.
#   PK = "USER#42"   SK = "PROFILE"           the profile item
#   PK = "USER#42"   SK = "ORDER#2026-07-01"  one order, sorts by date

# Access pattern: user 42's orders, newest first, in a single Query.
resp = table.query(
    KeyConditionExpression=Key("PK").eq("USER#42") & Key("SK").begins_with("ORDER#"),
    ScanIndexForward=False,   # sort key descending -> newest first
)

# "All OPEN orders across every user" is a different partition key, so it needs a GSI:
# project the order rows onto GSI1PK = "STATUS#OPEN", GSI1SK = order date, then Query the index.
# note: a Scan + filter on status would read the whole table and bill you for it.
```

## Interview Q&A
- **Partition key vs sort key?** The partition key is hashed to choose the physical partition, so it controls data placement and must be equality-matched on every read. The sort key orders items within that partition and is what lets you do range and prefix reads (`between`, `begins_with`, comparisons).
- **GSI vs LSI?** GSI: independent partition/sort key, its own capacity, eventually consistent, addable or removable anytime. LSI: same partition key as the base table plus an alternate sort key, shares the base table's capacity, supports strongly consistent reads, and can only be created when the table is created.
- **Query vs Scan?** `Query` hits a single partition by key and is fast and cheap. `Scan` reads every item and bills you for all of them regardless of any filter. Filters don't cut cost on either, they run after the read, so you narrow with the key, not the filter.
- **What is single-table design and why bother?** Storing multiple entity types in one table with overloaded generic keys so related items come back in one round-trip. It exists because DynamoDB has no joins, so co-locating and pre-sorting related data is how you keep reads to a single request.

## Gotchas
> [!WARN] A low-cardinality or skewed partition key creates a **hot partition** that throttles at the ~3,000 RCU / ~1,000 WCU per-partition ceiling even while the table as a whole has idle capacity. Adaptive capacity softens mild skew, not a fundamentally bad key.

> [!WARN] `FilterExpression` does **not** save money. On both `Query` and `Scan` it runs after items are read, so `ScannedCount` and your bill reflect everything examined while the filter only hides rows from the response.

- The partition key in a `Query` is **equality-only**. You range or prefix over the sort key, never the partition key, so "give me all PKs starting with X" is not a `Query`, it is a `Scan` or a rethink of your keys.
- LSIs are a **create-time, one-way** decision: no adding them later, they share the base table's throughput, and the 10 GB-per-partition-key limit can surprise you. When unsure, use a GSI.

## Revise next
- **[SQL vs NoSQL](sql-vs-nosql.md)** - when a relational model with joins beats designing around fixed access patterns.
- **[Replication, sharding & partitioning](replication-sharding-partitioning.md)** - DynamoDB auto-shards by hashing the partition key, the same trade-offs done for you.
- **[ACID vs BASE / CAP theorem](acid-properties.md)** - why GSIs read eventually consistent and what DynamoDB transactions do and don't promise.

*Reviewed against AWS DynamoDB docs, July 2026.*
