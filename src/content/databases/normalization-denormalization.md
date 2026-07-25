---
title: "Normalization vs Denorm"
group: "Schema & Scaling"
order: 7
---

# Normalization vs Denormalization

> Normalization stores each fact once so writes stay consistent. Denormalization deliberately copies or precomputes it so reads can skip the joins, trading that write-time integrity for read speed.

## What it is
- **Normalization** organizes tables so each fact lives in exactly one place, tied together by primary and foreign keys. Cutting duplication is the whole point of the relational model, and it is exactly what buys referential integrity and keeps update anomalies out.
- **Denormalization** puts redundancy back *on purpose*: a copied column, a precomputed total, a cached rollup, so a hot read skips a join or a scan. You accept a maintenance cost in exchange for speed.

> [!KEY] It is one dial, not two designs. **Normalize** to store each fact once and let integrity fall out of the keys. **Denormalize** to copy or precompute it so reads skip the work. Every choice trades write-time safety against read speed.

The whole topic is that single trade-off, seen from two directions:

| Dimension | **Normalize** | **Denormalize** |
| --- | --- | --- |
| Each fact | **stored once** | **copied or precomputed** |
| Reads | more **joins**, more work | **fewer joins**, faster |
| Writes | one row to touch, **consistent** | every copy **kept in sync** |
| Integrity | **falls out** of the keys | **your** job (trigger/app/job) |
| Storage | minimal | **redundant** |
| Fits | OLTP, **write-heavy** | reporting, **read-heavy** |

## Key points
- Normalization proceeds in **normal forms**, each removing one kind of redundancy:

| Form | Rule in one line |
| --- | --- |
| **1NF** | Atomic columns, **no repeating groups** |
| **2NF** | 1NF plus no **partial** dependency on part of a composite key |
| **3NF** | 2NF plus no non-key column depending on **another non-key** column |
| **BCNF** | Stricter 3NF: every determinant is a **candidate key** |

Most OLTP schemas sit at **3NF**, and that is a fine default.

- Normalization is what makes update, insert, and delete **anomalies impossible**. A customer's name lives in one row, so a rename touches one row and every order still reads correctly because the name was never copied.
- **Denormalize when reads dominate** and the joins genuinely hurt: copy a column onto the child table, precompute an aggregate, or roll a report into a materialized view.
- The bill lands on **writes**. Every copy has to be kept in sync by a trigger, application code, or a batch job, or it silently drifts. You also pay in storage and slower writes.
- Postgres 18 made **VIRTUAL** the default for generated columns, which flips what you get when you omit STORED:

| Generated column | **VIRTUAL** (PG 18 default) | **STORED** |
| --- | --- | --- |
| Computed | on **read** | on **write** |
| On disk | **nothing** | occupies storage |
| Indexable | **no** | **yes** |
| Denorm use | throwaway derivations | **precomputed values** you would otherwise copy by hand |

Either kind sees the **current row only**: immutable functions, no subqueries, no other tables.

- **Materialized views** are the honest precompute: `CREATE MATERIALIZED VIEW ... AS SELECT` stores the result and `REFRESH MATERIALIZED VIEW` recomputes it. Data is stale between refreshes by design.
- **JSONB** is denormalization inside one column: a semi-structured blob instead of a child table, indexed with GIN. Prefer `jsonb` over `json` (binary, indexable, containment via `@>`). Updating any key rewrites and row-locks the whole document, so keep each one small.
- **NoSQL flips the default.** DynamoDB has no joins, so you denormalize and pre-join at write time, embedding related data in one item so a read is a single-key lookup at single-digit-millisecond latency. Items accessed together are stored together, up to the **400 KB** item limit.

> [!TIP] Rule of thumb: normalize until it hurts, denormalize until it works, and measure first. Nine times out of ten the "we need to denormalize" instinct is really a missing index.

## Example
```sql
-- Normalized: the order points at the customer by FK, so the name lives once.
SELECT o.id, c.name
FROM orders o
JOIN customer c ON c.id = o.customer_id;

-- Naive denormalization: copy the name onto orders. Fastest read, but now YOU
-- own the sync (trigger/app/job) or it drifts the moment the customer renames.
ALTER TABLE orders ADD COLUMN customer_name text;  -- avoid: an unmanaged copy
```

Let Postgres maintain the redundancy instead of hand-copying it:

```sql
-- STORED generated column, maintained on write (VIRTUAL is the PG 18 default).
-- Same-row only, so it can't reach the customer, but ideal for precomputed values.
ALTER TABLE order_items
  ADD COLUMN line_total numeric GENERATED ALWAYS AS (qty * unit_price) STORED;

-- Materialized view for a read-heavy rollup, refreshed without blocking readers.
CREATE MATERIALIZED VIEW sales_by_day AS
SELECT date_trunc('day', created_at) AS day, sum(line_total) AS revenue
FROM order_items
GROUP BY 1;

CREATE UNIQUE INDEX ON sales_by_day (day);            -- required for CONCURRENTLY
REFRESH MATERIALIZED VIEW CONCURRENTLY sales_by_day;  -- stale until you refresh
```

## Interview Q&A
- **What does normalization actually buy you?** Each fact is stored once, so update, insert, and delete anomalies can't happen and the data stays consistent. Referential integrity falls out of the foreign keys for free.
- **1NF / 2NF / 3NF in one line?** 1NF atomic columns. 2NF no partial dependency on part of a composite key. 3NF no non-key column depending on another non-key column.
- **Why denormalize?** To cut joins and precompute work on a read-heavy path, knowingly trading storage and write cost for read latency.
- **Biggest risk of denormalizing?** The copies drift. Redundant data is correct only as long as something actively keeps it in sync.
- **How does this change in NoSQL / DynamoDB?** There are no joins, so denormalization is the starting point, not a last resort. You model around access patterns and embed related data so each query hits a single item.

## Gotchas
> [!WARN] A denormalized copy is a maintenance liability the instant it exists. If nothing - trigger, app rule, or job - keeps it current, assume it is already wrong.

> [!WARN] A materialized view is **stale by definition**, so never let a read-your-own-write path depend on one. A plain `REFRESH` also locks out readers, so you need a UNIQUE index to run `REFRESH ... CONCURRENTLY`.

- Over-normalizing a hot read path buries you in joins and latency. 3NF is a default, not a religion. Fold in a copy where the workload actually demands it.
- Premature denormalization is complexity you carry for nothing. Profile first. Usually the real fix is an index, not a redundant column.
- **VIRTUAL** generated columns (the PG 18 default) can't be indexed, so reach for **STORED** when you want the precomputed value on disk and searchable.
- JSONB tempts you to dump everything into one column. Every update rewrites and row-locks the whole document, so don't let a blob grow without bound.

## Revise next
- [Indexing](indexing-btree.md) (B-tree, and PG 18 skip scan)
- [Replication, sharding & partitioning](replication-sharding-partitioning.md)
- [PostgreSQL specifics](postgresql-jsonb-partial-index-vacuum.md) (materialized views, JSONB, generated columns)

*Reviewed against PostgreSQL 18 and the AWS DynamoDB Developer Guide, July 2026.*
