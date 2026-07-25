---
title: "PostgreSQL Specifics"
group: "Postgres & NoSQL"
order: 10
---

# PostgreSQL Specifics: JSONB, Partial Index, VACUUM

> Three Postgres features worth knowing cold: JSONB gives you indexable semi-structured data, partial indexes cover only the rows you actually query, and VACUUM reclaims the dead row versions MVCC leaves behind on every update and delete.

## What it is
These are the features that separate Postgres from generic SQL. **JSONB** is a real binary JSON type you can index and query inside the database. A **partial index** is an ordinary index scoped by a `WHERE` clause, so it only covers the rows you care about. **VACUUM** is the MVCC housekeeping that keeps a write-heavy table from rotting under its own dead rows.

> [!KEY] All three trace back to how Postgres stores rows: JSONB is a binary layout you can index, a partial index stores only the rows its predicate keeps, and VACUUM reclaims the old row versions MVCC must leave behind on every `UPDATE` and `DELETE`.

## Key points
- **JSONB** stores JSON in a decomposed binary form: it strips insignificant whitespace, drops duplicate keys (last one wins), and does not preserve key order. You pay a small parse cost on write and get cheaper reads plus real indexing back. The operators you filter and extract with:

| Operator | What it gives you | Example | How to index it |
| --- | --- | --- | --- |
| `->` | field or element as **`jsonb`** | `attrs -> 'color'` | expression index on the path |
| `->>` | field or element as **`text`** | `attrs ->> 'sku'` | `CREATE INDEX ... ((attrs->>'sku'))` |
| `@>` | **containment** - left contains right | `attrs @> '{"color":"red"}'` | **GIN**, either class |
| `?` `?\|` `?&` | **key exists** / any / all keys | `attrs ? 'color'` | **GIN**, `jsonb_ops` only |

- A **GIN** index makes the containment and key-exists operators fast. Two operator classes trade size for reach:

| GIN class | Operators | Size and speed | Use when |
| --- | --- | --- | --- |
| `jsonb_ops` (default) | `@>` `?` `?\|` `?&` `@?` `@@` | **larger** - indexes every key and value | you need **key-existence** (`?`) queries |
| `jsonb_path_ops` | `@>` `@?` `@@`, **no key-exists** | **smaller and faster** - hashes whole paths | every query is **containment** (`@>`) |

> [!TIP] Default to `jsonb`. Reach for plain `json` only when something downstream depends on the exact text - key order, whitespace, or duplicate keys.

- A **partial index** is `CREATE INDEX ... WHERE condition`: only matching rows get an entry, so it stays small and cheap to maintain. The planner uses it only when it can prove your query's `WHERE` implies the index predicate.

| Pattern | `WHERE` clause | Payoff |
| --- | --- | --- |
| Live-row lookups | `WHERE deleted_at IS NULL` | skips **soft-deleted** rows, index stays tiny |
| Hot subset | `WHERE status = 'open'` | indexes only **open** orders, not closed history |
| Scoped uniqueness | unique index `WHERE status = 'active'` | **one active row per user**, archived rows unconstrained |

- **MVCC** is the whole reason VACUUM exists. An `UPDATE` writes a new row version and leaves the old one for transactions still on an older snapshot, and a `DELETE` just flags the row dead. Those dead tuples pile up until something reclaims them.

| Aspect | Plain `VACUUM` | `VACUUM FULL` |
| --- | --- | --- |
| Space | marks dead space **reusable in place**, rarely returns it to the OS | **rewrites the table** into a fresh file, hands space back |
| Lock | none - **runs online** alongside reads and writes | **`ACCESS EXCLUSIVE`** throughout, blocks everything |
| Disk | in place | needs room for a **second copy** of the table |
| When | routine, or just let **autovacuum** do it | only to clear **serious bloat** in a maintenance window |

- **XID wraparound** is the trap that bites hard. Transaction IDs are 32-bit, so a table left un-vacuumed for ~2 billion transactions can have old rows suddenly look like they are in the future and vanish. VACUUM prevents this by **freezing** old rows. **PG 18** freezes more eagerly during ordinary vacuums (`vacuum_max_eager_freeze_failure_rate`, default 0.03): it proactively scans all-visible-but-not-yet-frozen pages, capped near 20% per run, so the work spreads out instead of landing on one giant aggressive vacuum later. PG 18 vacuum reads also flow through the new **async I/O** subsystem.
- **Autovacuum** runs plain VACUUM and ANALYZE for you, but it skips ANALYZE on partitioned and foreign tables, so refresh those stats yourself. Plain VACUUM also refreshes the **visibility map**, which powers index-only scans.

## Example
```sql
-- JSONB column + GIN index for containment / key-exists queries
ALTER TABLE product ADD COLUMN attrs jsonb;
CREATE INDEX idx_attrs ON product USING gin (attrs);      -- jsonb_ops: @>, ?, ?|, ?&
SELECT * FROM product WHERE attrs @> '{"color": "red"}';  -- uses the GIN index

-- containment-only workload? smaller, faster index:
CREATE INDEX idx_attrs2 ON product USING gin (attrs jsonb_path_ops);

-- one scalar key by equality? GIN won't help -- index the extracted path:
CREATE INDEX idx_sku ON product ((attrs->>'sku'));
```

```sql
-- partial index: only open orders carry an entry, so it stays small
CREATE INDEX idx_open ON orders (created_at) WHERE status = 'open';

-- reclaim dead tuples + refresh planner stats: online, no exclusive lock
VACUUM (ANALYZE, VERBOSE) orders;

-- last resort: returns space to the OS but locks the whole table
VACUUM FULL orders;
```

## Interview Q&A
- **JSONB vs JSON in Postgres?** JSONB is **binary and indexable**. It normalizes the document (no whitespace, no duplicate keys, no key-order guarantee) and pays a small write cost for much faster reads. Plain `json` keeps the **exact text** you handed it and supports no indexing. Default to `jsonb`, pick `json` only when key order or exact formatting matters downstream.
- **What is a partial index for?** Indexing a **subset of rows** via `WHERE` so the index stays small and cheap, ideal when queries only ever touch active or non-deleted rows. It also lets you enforce **uniqueness on part of a table**.
- **Why does PostgreSQL need VACUUM?** MVCC leaves **dead row versions** behind on every update and delete. VACUUM reclaims that space for reuse, keeps the visibility map current, and freezes old rows to stave off **XID wraparound**. Skip it and you get bloat, then wraparound trouble.
- **VACUUM vs VACUUM FULL?** Plain VACUUM reclaims space **for reuse in place**, runs online with no exclusive lock. VACUUM FULL **rewrites the table** to give space back to the OS but holds `ACCESS EXCLUSIVE` throughout. Prefer plain VACUUM (or autovacuum), use FULL only to recover from serious bloat in a window.

## Gotchas
> [!WARN] A GIN index on the whole `jsonb` column speeds up `@>` and `?`, but does **nothing** for `WHERE attrs->>'sku' = '123'` equality. That path needs its own **expression index**, `((attrs->>'sku'))`.

> [!WARN] Starving or disabling autovacuum is how you end up bloated and eventually staring at `database is not accepting commands to avoid wraparound`. Postgres stops issuing XIDs and goes read-only until you vacuum. Tune autovacuum, never turn it off.

- **VACUUM FULL** takes `ACCESS EXCLUSIVE` and needs room for a second copy of the table, so it blocks every read and write. Do not reach for it on a busy table, let autovacuum keep pace instead.
- A partial index is used **only when the planner can prove** your query's `WHERE` implies the index predicate. A query on `status = 'open'` matches `WHERE status = 'open'`, but a broader scan will fall back to a full index or a seq scan.
- Autovacuum will not **ANALYZE** partitioned or foreign tables. Stale stats there quietly produce bad plans, so schedule those manually.

## Revise next
- **[Indexing](indexing-btree.md)** - B-tree, GIN, and PG 18 multicolumn **skip scan** (uses the index even without an `=` on the leading column).
- **[EXPLAIN and query plans](explain-analyze.md)** - note PG 18 turns `BUFFERS` on by default under `ANALYZE`.
- **[SQL vs NoSQL](sql-vs-nosql.md)** - when a managed key-value or document store like DynamoDB fits better than a relational schema.

*Reviewed against PostgreSQL 18, July 2026.*
