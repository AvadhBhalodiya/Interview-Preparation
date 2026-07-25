---
title: "Indexing (B-tree)"
group: "Queries & Optimization"
order: 2
---

# Indexing (B-tree): when it helps vs when it hurts

> A B-tree keeps its keys sorted so the planner can seek instead of scan, turning `O(n)` scans into `O(log n)` lookups for equality, ranges, and `ORDER BY` on the leading columns, and you pay for that with slower writes and more disk, so index only the columns you actually filter and sort on.

## What it is
- An **index** is a separate on-disk structure that stores your chosen keys in sorted order and points back at the table rows, so the planner can walk straight to the matches instead of reading every page of the table (a **sequential scan**).
- **B-tree** is the default and almost always the right one - a balanced tree kept in sorted order, so it is good at anything that reduces to compare-and-order. Postgres wires up exactly five operators for it: `<`, `<=`, `=`, `>=`, `>`. Note what is missing - `<>` - which is why a `!=` filter never touches the index.

> [!KEY] An index is a **sorted side-copy** of a few columns pointing back at each row, so the planner uses it only when the query can **seek one contiguous slice** of that order: equality, a range, a left-anchored prefix, or `ORDER BY` on the leading columns. Scramble that sort with a function on the column or a leading `%` and you are back to a full scan.

What that means in practice - the query shapes a B-tree can and cannot accelerate:

| B-tree helps (planner seeks) | B-tree does not help (seq scan or ignored) |
| --- | --- |
| **Equality**: `col = ?`, `IN (...)`, `IS NULL` | **Leading wildcard**: `LIKE '%abc'` or `'%abc%'`, no left anchor |
| **Range**: `<` `<=` `>=` `>`, `BETWEEN` | **Low selectivity**: a boolean or 3-value `status`, planner scans anyway |
| **Prefix**: `LIKE 'abc%'` (needs `text_pattern_ops` off the C locale) | **Function / cast on the column**: `lower(email)`, `created_at::date` |
| **Sort / group**: `ORDER BY`, `GROUP BY` on the leading columns | **`!=` / `<>`**: not one of the five B-tree operators |
| **Join** on an indexed key | **Tiny tables**: a full scan is already cheap |

## Key points
- **Composite left-prefix rule.** An index `(a, b, c)` is sorted by `a`, then `b` within each `a`, then `c`. The scan narrows only as far as you pin the **leading columns with equality**, plus at most **one range** on the first column you leave unconstrained. So put the most selective equality column first: column order is a design decision, not a formality.
- **PG 18 skip scan** loosens the old "you must constrain the leading column" rule. Given `(x, y)`, a query with an **equality on the later column** and nothing on `x` (`WHERE y = 7700`) can still use the index: the planner enumerates each distinct `x` internally and seeks `y` under each. It needs that `=` (or `IN`) on a later column and only pays off when **`x` has few distinct values** (a 3-value `status`, not thousands of ids), so treat it as a rescue for low-cardinality leading columns, not a licence to stop ordering indexes.
- **Covering / `INCLUDE` indexes** answer a query from the index alone - an **index-only scan** with no heap fetch. Put the filter and sort columns in the key and the extra payload in `INCLUDE (...)`. It skips the heap only when those pages are marked **all-visible** in the visibility map, so a churny, rarely-vacuumed table falls back to reading the heap.
- **Selectivity earns the index.** It pays off on selective columns, join keys, and columns you filter, sort, or group by. It is wasted on low-selectivity columns (a boolean, a three-value `status`) where the planner seq-scans regardless, and on small tables.
- **Every index taxes writes.** Each `INSERT`, `UPDATE`, or `DELETE` maintains every index on the table, on top of storage and `VACUUM` work. (A **HOT update** touching no indexed column can sometimes skip this, but do not design around it.) Six indexes on a hot table is a real write-throughput problem.
- **Find dead indexes** with `pg_stat_user_indexes`: an `idx_scan` of 0 after a representative workload is pure write overhead, so drop it.

B-tree is the default, but four other types exist for the shapes it cannot serve:

| Type | Reach for it when | The differentiator |
| --- | --- | --- |
| **B-tree** | `=`, ranges, prefix `LIKE`, sort / group | The **default**, right nearly every time |
| **Hash** | `=` only | **No range or sort** support, rarely beats B-tree |
| **GIN** | JSONB, arrays, full-text | **Inverted** index: "does this row contain X?" |
| **GiST / SP-GiST** | geometry, ranges, nearest-neighbor | Geometric and **KNN** search |
| **BRIN** | huge append-mostly tables | **Tiny** index when the column tracks physical row order (insert-time timestamp) |

On top of a type you stack **modifiers**: **partial** (index a `WHERE` subset), **covering** (`INCLUDE` payload), and **expression** (`lower(email)`).

> [!TIP] Confirm the planner really used the index with `EXPLAIN (ANALYZE, BUFFERS)`. In **PG 18** buffer counts print by default, and each index-scan node now reports its **number of index lookups**, which is the quickest way to see how many times a skip scan actually skipped.

## Example
```sql
-- composite: sorted by customer_id, then created_at within each customer
CREATE INDEX idx_orders_customer_created ON orders (customer_id, created_at);

-- helped:  WHERE customer_id = 7 AND created_at > now() - interval '30 days'
-- helped:  WHERE customer_id = 7 ORDER BY created_at DESC   -- already sorted, no extra sort step
-- ignored: WHERE created_at > '...' alone                   -- range on trailing col, nothing leading
```

```sql
-- partial + covering: index only the rows you query, carry `total` along as payload
CREATE INDEX idx_open_orders ON orders (customer_id) INCLUDE (total)
  WHERE status = 'open';
-- index-only scan:  SELECT total FROM orders WHERE status = 'open' AND customer_id = 7
--                   (skips the heap only when those pages are all-visible)

-- expression index: needed so WHERE lower(email) = '...' can use an index at all
CREATE INDEX idx_users_lower_email ON users (lower(email));
```

## Interview Q&A
- **Why is a B-tree lookup `O(log n)`?** The keys sit sorted in a shallow, balanced tree, so each step discards a large slice of the keyspace. A handful of page reads reaches the row instead of scanning the whole table.
- **When does an index actually hurt?** Two ways. On writes, every index is maintained on each insert, update, and delete. And when it cannot help the read anyway (low-selectivity column, tiny table) the planner seq-scans, so you have paid that write cost for nothing.
- **What is the leftmost-prefix rule, and did PG 18 kill it?** An index on `(a, b, c)` narrows the scan when you pin `a` with equality and then, optionally, range one more column. PG 18 skip scan lets a query that pins only `b` (with equality) use the index too, but only when `a` has few distinct values, so no, ordering the columns right still matters.
- **JSONB or full-text: which index?** GIN, not B-tree. A B-tree cannot answer "does this contain that key or element". GIN is the inverted index built for exactly that.
- **Does `INCLUDE` guarantee zero heap reads?** No. An index-only scan still checks the visibility map, and only when the heap page is all-visible does it skip the fetch. On a churny, rarely-vacuumed table it falls back to visiting the heap.

## Gotchas
> [!WARN] **Wrapping the indexed column in a function or cast kills the index.** `WHERE lower(email) = '...'` ignores a plain index on `email`, and `WHERE created_at::date = '...'` ignores one on `created_at`. Fix it by indexing the expression itself: `CREATE INDEX ON users (lower(email))`.

> [!WARN] **`LIKE 'abc%'` silently seq-scans** on a non-C-locale database unless the index uses a `text_pattern_ops` operator class. Any **leading wildcard** (`'%abc'`, `'%abc%'`) cannot use a B-tree at all, so reach for a trigram GIN index (`pg_trgm`) for infix or suffix search. Plain equality still uses the normal index off the C locale - it is only prefix matching that needs pattern-ops.

- **Over-indexing is the more common mistake**, not under-indexing. Index for the queries you actually run, not "just in case", because every extra index slows writes and bloats storage.
- A single-column index on something **low-selectivity** (`status`, `is_deleted`) usually gets ignored. If you genuinely need it, make it **partial** (`WHERE status = 'open'`) or fold it into a composite behind a selective leading column.

## Revise next
- [EXPLAIN & query plans](explain-analyze.md)
- [JSONB/GIN & partial indexes](postgresql-jsonb-partial-index-vacuum.md)
- [Joins, subqueries & CTEs](joins-subqueries-ctes.md)

*Reviewed against PostgreSQL 18, July 2026.*
