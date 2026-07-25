---
title: "SQL vs NoSQL"
group: "Postgres & NoSQL"
order: 11
---

# SQL vs NoSQL - When to Use Each

> SQL gives you joins, an engine-enforced schema, and ACID for related data. NoSQL trades those for schema freedom and easy horizontal scale, so pick by data shape and access pattern rather than by whichever one sounds more scalable.

## What it is
- **SQL**: relational databases like Postgres and MySQL. Tables with a schema the engine enforces, joins across them, and ACID transactions.
- **NoSQL**: the catch-all for everything non-relational - document (MongoDB), key-value and wide-column (DynamoDB, Cassandra), in-memory (Redis), graph (Neo4j). Each one drops the relational model to buy one thing: scale, flexibility, or raw lookup speed.

> [!KEY] The split is not "old vs scalable", it is **modeling direction**. In **SQL you normalize first and query any way later**. In **NoSQL you pin down every access pattern first, then shape items to serve them**.

The core trade-offs line up dimension by dimension:

| Dimension | SQL (Postgres, MySQL) | NoSQL (DynamoDB, Mongo, Cassandra) |
| --- | --- | --- |
| Schema | **Engine-enforced**, changed by migration | **App-enforced**, items can differ freely |
| Joins | **Native** across normalized tables | **None** - denormalize, read one item |
| Transactions | **Full ACID** across many rows | Per-item, or capped (DynamoDB: **100 items**) |
| Scaling | Scale **up**, add read replicas | Scale **out** by partition key, built in |
| Consistency | **Strong** by default | **Eventual** by default |
| Indexing | **Any column**, the planner picks the path | **Per access pattern** (a GSI each) |
| Best for | **Related data + correctness** | **Known access patterns at scale** |

## Key points
- **SQL is the default for related data.** Orders belong to users, users belong to accounts. Foreign keys and joins model that directly, ACID keeps it correct, and you inherit decades of tooling: query planners, migrations, mature indexing. Reach for this first unless you have a concrete reason not to.
- **"NoSQL" is not one decision.** It is a family, and each member drops the relational model to buy something different:

| Type | Examples | Buys you |
| --- | --- | --- |
| **Document** | MongoDB | JSON-like records, flexible fields |
| **Key-value / wide-column** | DynamoDB, Cassandra | **Throughput** on known keys |
| **In-memory** | Redis | **Sub-millisecond** reads, cache and sessions |
| **Graph** | Neo4j | **Cheap** relationship traversal |

- **The real win is horizontal scale plus schema freedom.** DynamoDB spreads items across partitions by key and scales out without you babysitting shards, and it won't complain when two items carry different attributes. The bill: reads are **eventually consistent by default**, so a read right after a write can return stale data unless you set `ConsistentRead=true` (double the read cost, and not offered on global secondary indexes).
- **Query flexibility is asymmetric.** In SQL the planner serves any new `WHERE`, join, or `GROUP BY` without a schema change, so ad-hoc reporting stays cheap. In NoSQL each unplanned access pattern needs its own index up front, and a query with no matching key degrades into a full-table `Scan` that reads every item.
- **The line blurs, so skip the dogma.** Postgres stores and GIN-indexes JSON with `jsonb` when you genuinely need a schemaless column, and partitions big tables by range, list, or hash. DynamoDB has real ACID transactions (`TransactWriteItems`, all-or-nothing, up to 100 items and 4 MB), though only inside a single Region and account. Decide on fit, not on the label.
- **Polyglot persistence is the normal end state.** Postgres as the system of record, Redis in front for cache and sessions, maybe a document or search store for logs. Most production systems run two or three stores, and that is fine.

> [!TIP] Reach for Postgres first. Between `jsonb`, partitioning, and read replicas it absorbs most "we need NoSQL" cases. Treat "we'll outgrow Postgres" as a claim to back with numbers, not an assumption.

## Example
Same data, modeled in opposite directions. SQL keeps each fact in one place and stitches the tables together at read time:

```sql
-- SQL: normalize, then JOIN at read time
CREATE TABLE users  (id INT PRIMARY KEY, name TEXT);
CREATE TABLE orders (id      INT PRIMARY KEY,
                     user_id INT REFERENCES users(id),
                     total   NUMERIC);

-- one query joins the two normalized tables
SELECT u.name, o.id, o.total
FROM orders o
JOIN users u ON u.id = o.user_id;   -- name stored once, in users
```

NoSQL (DynamoDB) instead pre-joins the answer into one denormalized item - a `user` record with an embedded `orders` list like `{ "user": "ann", "orders": [ ... ] }` - fetched in a single `GetItem` with no join. That is one read and it scales flat, but Ann's name is now copied onto every item that references her, so a rename has to fan out across all of them.

## Interview Q&A
- **When reach for SQL over NoSQL?** When data is relational and correctness matters: orders, payments, inventory. Let the engine hand you joins, foreign keys, and ACID instead of hand-rolling them in application code.
- **When is NoSQL the right call?** When you know your access patterns cold and need to scale past a single box, when the data is genuinely schema-loose (event streams, user-generated blobs), or when you need sub-millisecond key reads (Redis).
- **How does modeling differ?** SQL normalizes the data and queries flexibly afterward. NoSQL fixes the queries first, then denormalizes to serve them. Guess wrong in DynamoDB and you rebuild the table, not add an index. That inversion is the single biggest thing developers get wrong.
- **Is NoSQL simply more scalable?** It scales out with less effort, but Postgres with read replicas and partitioning handles very large workloads too. "We'll outgrow Postgres" is a claim to back with numbers, not an assumption.
- **How do you scale a SQL database before reaching for NoSQL?** Add read replicas to spread reads, cache hot rows in Redis, then partition or shard the biggest tables by key. Most teams never hit the wall that actually forces a rewrite.
- **What does "eventually consistent" mean in practice?** After a write, a read can briefly return the old value until replicas converge. Fine for a feed or a view counter, wrong for a balance check right after a debit - use a strongly consistent read there, or keep that data in SQL.

## Gotchas
> [!WARN] **"Schemaless" just moves the schema into your app code**, where nothing enforces it. Give it two years and you have documents written by five app versions and no migration path. Even Postgres' own JSON docs recommend a "somewhat fixed structure" so your queries stay writable.

> [!WARN] **Eventual consistency surprises people.** A DynamoDB read right after a write can return the old value. Read-your-writes means opting into strongly consistent reads, which global secondary indexes do not even offer.

- **Denormalized data duplicates facts, so writes fan out.** Copying a user's name onto every order reads great and renames terribly. Model for your actual read/write ratio, not just the reads.
- **Don't shove relational, transactional data into a key-value store to chase scale.** Money and cross-row invariants belong where joins and ACID are native. DynamoDB transactions cap at 100 items in one Region, so they are not a drop-in for a relational transaction.
- **A low-cardinality partition key creates hot partitions.** DynamoDB shards by the hash of the partition key, so a sequential or low-variety key (a date, a `status`) funnels traffic onto one partition and throttles it while the rest sit idle. Pick a high-cardinality key.
- **Polyglot persistence has no free cross-store transaction.** A write to Postgres plus a write to Redis or a search index share no ACID guarantee, so a crash between them leaves the two out of sync. Reach for the outbox pattern or reconcile the drift on a schedule.

## Revise next
- [DynamoDB](dynamodb-keys-single-table.md) (keys, GSI/LSI, single-table design)
- [ACID vs BASE / CAP theorem](acid-properties.md)
- [Replication, sharding & partitioning](replication-sharding-partitioning.md)

*Reviewed against PostgreSQL 18 / AWS DynamoDB, July 2026.*
