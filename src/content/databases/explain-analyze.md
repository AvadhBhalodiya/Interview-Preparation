---
title: "EXPLAIN & Query Plans"
group: "Queries & Optimization"
order: 3
---

# `EXPLAIN` / `EXPLAIN ANALYZE` (Query Optimization)

> `EXPLAIN` prints the plan the planner picked and what it *thinks* each step will cost. `EXPLAIN ANALYZE` runs the query and shows what actually happened, which is the first place to look when SQL gets slow.

## What it is
**`EXPLAIN`** asks the cost-based planner which plan it *would* run - the tree of scan, join, and sort nodes, each tagged with an estimated cost and row count - and executes nothing, so it is instant and safe on anything. **`EXPLAIN ANALYZE`** runs the statement for real and annotates every node with what actually happened, so you can hold the planner's guess up against reality.

> [!KEY] Read the plan tree **inside-out**: the most-indented node runs first and feeds its parent. Cost and time are **cumulative**, so a parent's numbers already include every child beneath it.

The two commands answer different questions:

| | **`EXPLAIN`** | **`EXPLAIN ANALYZE`** |
| --- | --- | --- |
| Runs the query? | **No** - estimates only | **Yes** - really executes it |
| Shows | **Estimated** `cost`, `rows`, `width` | Estimates plus **actual** `time`, `rows`, `loops` |
| `BUFFERS` (PG 18) | Not shown - nothing ran | **On by default** - cache hits vs disk reads |
| Risk on writes | **None** | An `UPDATE`/`DELETE` **modifies data** |
| Reach for it to | Sanity-check a plan **cheaply** | Find **why** a query is actually slow |

## Key points
Every plan is built from a handful of node types, and knowing them is half of reading one:

| Node | What it does, and when the planner picks it |
| --- | --- |
| **Seq Scan** | Reads the whole table - **wins on small tables** or when you return most rows |
| **Index Scan** | Walks an index then fetches heap rows - a **selective `WHERE`** |
| **Index Only Scan** | Answers from the index alone - **no heap fetch** (covering index) |
| **Bitmap Heap/Index Scan** | Bitmaps the pages first - **medium selectivity**, scattered rows |
| **Nested Loop** | Probes the inner side per outer row - a **small inner side** |
| **Hash Join** | Hashes one side in memory - **big, unsorted** inputs |
| **Merge Join** | Zips two sorted inputs - **both already sorted** |

- **`cost=startup..total`** is in the planner's page-fetch units, **not milliseconds** - good for ranking two candidate plans, useless as a clock. That gap is exactly why `ANALYZE` prints the real `actual time` beside it.
- **`actual time` and `rows` are per-loop averages.** A node at `loops=500` really spent `time × 500`. Since PG 18, rows print fractionally (`rows=0.25 loops=4` is 1 row total), so multiplying back is exact.
- The single most useful number is the **gap between estimated and actual `rows`**. Expect 1 row, get 100k, and the planner commits to the wrong join. A wide gap almost always means **stale statistics**: run `ANALYZE`, raise `default_statistics_target` on a skewed column, or add `CREATE STATISTICS` when two columns move together (city and postal code).
- **`BUFFERS` is on by default in PG 18**: `shared hit` is a page from cache, `shared read` is one fetched from OS or disk. A query that feels quick on a warm cache is a different animal cold, so watch the `read` count, not just the time.
- **`Index Searches` (new in PG 18)** counts how many times a scan descended the B-tree. Plain equality is `1`. An `IN (...)` list or a **skip scan** (also new in PG 18) can be many, which explains a scan doing more work than you expected.
- A **spill to disk** is a red flag: `Sort Method: external merge Disk: ...` means the sort outgrew `work_mem`, and a `Hash Join` with `Batches > 1` says the same. Bumping `work_mem` for the session often turns the spill back into an in-memory operation.

## Example
```sql
-- Assumes an index on orders (customer_id, created_at).
EXPLAIN ANALYZE
SELECT * FROM orders
WHERE customer_id = 42
ORDER BY created_at DESC
LIMIT 10;
```

```text
Limit  (cost=0.43..8.61 rows=10 width=120) (actual time=0.028..0.031 rows=10.00 loops=1)
  Buffers: shared hit=13
  ->  Index Scan Backward using orders_customer_created_idx on orders
        (cost=0.43..40.75 rows=51 width=120) (actual time=0.026..0.029 rows=10.00 loops=1)
        Index Cond: (customer_id = 42)
        Index Searches: 1
        Buffers: shared hit=13
Planning Time: 0.115 ms
Execution Time: 0.049 ms
```

Decoding the annotation on the scan node:

| Field | How to read it |
| --- | --- |
| `cost=0.43..40.75` | Estimated **startup..total** in page-units, **not ms** |
| `rows=51` | Planner's **estimated** row count, a guess from statistics |
| `width=120` | **Average bytes** per output row |
| `actual time=0.026..0.029` | Real **startup..total ms**, averaged per loop |
| `rows=10.00` | **Actual** rows returned per loop - fractional since PG 18 |
| `loops=1` | Times the node ran - **multiply** time and rows by this |
| `Buffers: shared hit=13` | Pages from **cache** (`hit`) vs **disk** (`read`) |

Reading it: the index satisfies `ORDER BY created_at DESC` directly (**Index Scan Backward**), so there is **no separate Sort node**, and every page is a cache hit. The scan's `51 vs 10.00` gap is just the `LIMIT` stopping it early - **expected, not a stats problem**. Drop the index and you would get a `Seq Scan` with a large `Rows Removed by Filter` plus a `Sort` node, reading and sorting the whole table to return 10 rows.

## Interview Q&A
- **`EXPLAIN` vs `EXPLAIN ANALYZE`?** `EXPLAIN` shows the chosen plan and the planner's estimates without running anything. `ANALYZE` executes the query and reports the real time and row counts, so you can check the estimates against what actually happened.
- **What in the output tells you the plan is bad?** A big gap between estimated and actual rows, a `Seq Scan` with a large `Rows Removed by Filter` on a table that should be indexed, or a sort or hash that spilled to disk. Any of those is where I would start digging.
- **The estimate says 5 rows but the node returned 200k - what do you do?** That is stale or insufficient statistics. Run `ANALYZE` on the table first. If it is a skewed column, raise `default_statistics_target` and re-analyze. If two columns are correlated, add extended statistics with `CREATE STATISTICS`.
- **Why is `EXPLAIN ANALYZE` risky and how do you run it safely?** It runs the statement, so an `UPDATE` or `DELETE` really modifies rows. Wrap it in `BEGIN; ... ROLLBACK;` to get the plan and timings without keeping the change.
- **What changed in PG 18's EXPLAIN?** `BUFFERS` is on by default whenever you use `ANALYZE`, each index scan node reports its `Index Searches`, actual row counts print fractionally, and memory and disk usage now show on `Material`, `WindowAgg`, and CTE nodes too.

## Gotchas
> [!WARN] **`EXPLAIN ANALYZE` executes the statement.** On an `UPDATE`/`DELETE`/`INSERT`/`MERGE` it really changes your data. Wrap it in `BEGIN; ... ROLLBACK;` to capture the plan without keeping the change.

> [!WARN] **`actual time` and `rows` are per-loop averages, not totals.** A node at `loops=500` really did `time × 500` of work, and reading the average as the total is the classic way to misjudge a nested loop.

- **Plans are only as realistic as the data behind them.** On a few thousand dev rows the planner picks a `Seq Scan` it would never choose in production, so validate against prod-like volume with fresh stats.
- **Cost is not time.** The lowest-cost plan can still lose on the wall clock, so when the two disagree, trust `ANALYZE`'s `actual time`.
- **A warm cache flatters the numbers.** The first run pays for `shared read` off disk, the second is served from `shared hit` in cache. Run it twice and know which one you are reading.
- **Per-node timing is not free.** `ANALYZE` reads the clock around every node, which inflates `Execution Time` on deep plans. If you only need row counts, `EXPLAIN (ANALYZE, TIMING OFF)` cuts most of that overhead.

## Revise next
- [Indexing](indexing-btree.md) (B-tree, partial, covering)
- [Joins, subqueries & CTEs](joins-subqueries-ctes.md)
- [VACUUM / ANALYZE & table statistics](postgresql-jsonb-partial-index-vacuum.md)

*Reviewed against PostgreSQL 18, July 2026.*
