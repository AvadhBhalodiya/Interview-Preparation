---
title: "EXPLAIN & Query Plans"
group: "Queries & Optimization"
order: 3
---

# EXPLAIN and EXPLAIN ANALYZE for Query Optimization

> **Topic:** Databases & SQL  
> **Primary examples:** PostgreSQL 18  
> **Also covered:** MySQL 8.4, SQL Server, and SQLite  
> **Goal:** Understand how a database executes a query, locate expensive work, and validate optimizations with evidence.

---

## Table of Contents

1. [Why Execution Plans Matter](#1-why-execution-plans-matter)
2. [How a SQL Query Is Processed](#2-how-a-sql-query-is-processed)
3. [EXPLAIN vs EXPLAIN ANALYZE](#3-explain-vs-explain-analyze)
4. [Basic Syntax](#4-basic-syntax)
5. [How to Read an Execution Plan](#5-how-to-read-an-execution-plan)
6. [Understanding PostgreSQL Plan Metrics](#6-understanding-postgresql-plan-metrics)
7. [Common Scan Operations](#7-common-scan-operations)
8. [Common Join Algorithms](#8-common-join-algorithms)
9. [Sort, Aggregate, and Other Important Nodes](#9-sort-aggregate-and-other-important-nodes)
10. [Using BUFFERS to Understand I/O](#10-using-buffers-to-understand-io)
11. [Estimated Rows vs Actual Rows](#11-estimated-rows-vs-actual-rows)
12. [Practical Optimization Examples](#12-practical-optimization-examples)
13. [A Reliable Query-Tuning Workflow](#13-a-reliable-query-tuning-workflow)
14. [Safe Use with INSERT, UPDATE, and DELETE](#14-safe-use-with-insert-update-and-delete)
15. [Database-Specific Differences](#15-database-specific-differences)
16. [Production Best Practices](#16-production-best-practices)
17. [Quick Reading Checklist](#17-quick-reading-checklist)
18. [Interview-Ready Summary](#18-interview-ready-summary)
19. [Official References](#19-official-references)

---

# 1. Why Execution Plans Matter

SQL is **declarative**. You describe the result you need, but normally you do not specify the exact steps the database must perform.

```sql
SELECT *
FROM orders
WHERE customer_id = 42;
```

The database optimizer decides whether to:

- scan every row in `orders`;
- use an index on `customer_id`;
- use multiple indexes together;
- read rows in parallel;
- join tables with a nested loop, hash join, or merge join;
- sort rows in memory or write temporary data to disk.

`EXPLAIN` and `EXPLAIN ANALYZE` make those decisions visible.

They help answer practical questions such as:

- Is the query using the intended index?
- Is a full-table scan reasonable or expensive?
- Is the optimizer estimating row counts correctly?
- Which operation consumes most of the time?
- Is a sort or hash operation spilling to disk?
- Is a join executing thousands of repeated index lookups?
- Did the proposed index actually improve the query?

---

# 2. How a SQL Query Is Processed

A simplified query-processing flow looks like this:

```text
SQL Query
   │
   ▼
┌───────────────┐
│ Parser        │  Checks syntax and builds a query structure
└───────┬───────┘
        │
        ▼
┌───────────────┐
│ Rewriter      │  Expands views and applies logical rewrites
└───────┬───────┘
        │
        ▼
┌───────────────┐
│ Optimizer     │  Evaluates possible access paths and join orders
└───────┬───────┘
        │
        ▼
┌───────────────┐
│ Execution Plan│  Selected tree of physical operations
└───────┬───────┘
        │
        ▼
┌───────────────┐
│ Executor      │  Runs the selected plan and returns rows
└───────────────┘
```

The optimizer usually makes decisions using:

- table and column statistics;
- index metadata;
- estimated selectivity of filters;
- estimated number of rows at each step;
- available memory and planner settings;
- possible join orders and join algorithms;
- expected CPU and I/O costs.

The optimizer does not test every plan by executing it. It estimates the cost of candidate plans and selects a plan that appears efficient according to its cost model.

---

# 3. EXPLAIN vs EXPLAIN ANALYZE

## 3.1 EXPLAIN

`EXPLAIN` shows the **estimated execution plan**.

```sql
EXPLAIN
SELECT *
FROM orders
WHERE customer_id = 42;
```

The query is planned but, for a normal `SELECT`, not executed.

Use it when:

- the query may be expensive or unsafe to run;
- you first want to inspect the likely plan;
- you are analyzing an `UPDATE` or `DELETE` and do not want to change data;
- you want estimated costs and row counts.

## 3.2 EXPLAIN ANALYZE

`EXPLAIN ANALYZE` executes the query and adds runtime measurements.

```sql
EXPLAIN ANALYZE
SELECT *
FROM orders
WHERE customer_id = 42;
```

It reports information such as:

- actual startup and completion time;
- actual rows produced by each node;
- number of times each node ran;
- rows removed by filters;
- sort or hash runtime details;
- planning and total execution time.

## 3.3 Main Difference

| Command | Executes the query? | Estimated values | Actual runtime values | Main purpose |
|---|---:|---:|---:|---|
| `EXPLAIN` | No for a normal `SELECT` | Yes | No | Inspect the optimizer's chosen plan safely |
| `EXPLAIN ANALYZE` | Yes | Yes | Yes | Compare estimates with real execution behavior |

> **Important:** `EXPLAIN ANALYZE` really runs the statement. An analyzed `UPDATE`, `DELETE`, `INSERT`, or `MERGE` can modify data.

---

# 4. Basic Syntax

## 4.1 PostgreSQL

```sql
EXPLAIN
SELECT ...;
```

```sql
EXPLAIN ANALYZE
SELECT ...;
```

A useful PostgreSQL form is:

```sql
EXPLAIN (ANALYZE, BUFFERS, VERBOSE)
SELECT ...;
```

For repeatable machine-readable output:

```sql
EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON)
SELECT ...;
```

Frequently used PostgreSQL options:

| Option | Purpose |
|---|---|
| `ANALYZE` | Executes the statement and records actual statistics |
| `BUFFERS` | Shows buffer/cache and block I/O activity |
| `VERBOSE` | Shows additional details such as output columns and qualified names |
| `SETTINGS` | Displays non-default settings that affected planning |
| `WAL` | Shows write-ahead log generation for write operations |
| `TIMING OFF` | Records actual row counts with less node-level timing overhead |
| `SUMMARY` | Shows planning and execution summaries |
| `FORMAT JSON` | Produces structured output for tooling |

PostgreSQL 18 automatically includes buffer information when `ANALYZE` is enabled. Writing `BUFFERS` explicitly is still useful because it makes the intention clear and remains familiar across PostgreSQL versions.

## 4.2 MySQL 8.4

```sql
EXPLAIN
SELECT ...;
```

```sql
EXPLAIN FORMAT=TREE
SELECT ...;
```

```sql
EXPLAIN ANALYZE
SELECT ...;
```

MySQL `EXPLAIN ANALYZE` executes the statement and uses tree output.

## 4.3 SQLite

```sql
EXPLAIN QUERY PLAN
SELECT ...;
```

SQLite also supports low-level `EXPLAIN`, but `EXPLAIN QUERY PLAN` is normally easier for developers because it describes scans and index usage at a higher level.

---

# 5. How to Read an Execution Plan

Execution plans are trees.

Consider this PostgreSQL-style plan:

```text
Hash Join
├── Seq Scan on orders
└── Hash
    └── Seq Scan on customers
```

The logical execution flow is approximately:

```text
1. Scan customers
2. Build an in-memory hash table from customers
3. Scan orders
4. Probe the hash table for matching customer rows
5. Return joined rows
```

## 5.1 Read from the Bottom Up

Child nodes produce rows for their parent nodes.

```text
Sort
└── Index Scan on orders
```

Interpretation:

1. The index scan retrieves rows.
2. The sort node orders those rows.
3. The parent returns the sorted result.

## 5.2 Indentation Represents Parent–Child Relationships

```text
Nested Loop
├── Seq Scan on customers
└── Index Scan on orders
```

The `Nested Loop` is the parent. The customer scan and order index scan are its children.

The inner child can run repeatedly—often once for every row returned by the outer child.

## 5.3 Do Not Simply Add Every Node's Time

Parent-node time generally includes work performed by its descendants. Adding every displayed node time can therefore double-count work.

Use the plan tree to understand where time accumulates rather than treating every value as an independent duration.

## 5.4 Start with the Root, Diagnose from the Leaves

A practical approach is:

1. Check total execution time at the bottom of the plan output.
2. Identify nodes with high actual time, high row counts, many loops, or heavy I/O.
3. Follow those branches downward to discover why so much work was required.

---

# 6. Understanding PostgreSQL Plan Metrics

A common PostgreSQL node looks like this:

```text
Index Scan using idx_orders_customer_id on orders
  (cost=0.43..12.47 rows=5 width=64)
  (actual time=0.031..0.045 rows=4 loops=1)
```

## 6.1 Estimated Cost

```text
cost=0.43..12.47
```

The two numbers are:

```text
startup cost .. total cost
```

- **Startup cost:** estimated work before the node can return its first row.
- **Total cost:** estimated work if the node runs to completion.

Cost is not milliseconds. It is an internal unit based on PostgreSQL's cost settings and estimates of CPU, sequential I/O, random I/O, and other work.

Costs are mainly useful for comparing alternative plans considered by the optimizer.

## 6.2 Estimated Rows

```text
rows=5
```

This is the optimizer's estimate of how many rows the node will produce.

Row estimates strongly influence:

- whether an index is selected;
- join order;
- join algorithm;
- memory allocation;
- whether parallel processing is worthwhile.

## 6.3 Estimated Row Width

```text
width=64
```

This is the estimated average row size in bytes.

Wide rows increase:

- memory usage;
- amount of data copied between nodes;
- sort and hash memory requirements;
- storage reads when many columns are fetched.

## 6.4 Actual Time

```text
actual time=0.031..0.045
```

The two values are approximately:

```text
first-row time .. all-rows time
```

They are measured in milliseconds for each execution of the node.

## 6.5 Actual Rows

```text
rows=4
```

This is the average number of rows returned per loop.

## 6.6 Loops

```text
loops=1
```

This is the number of times the node was executed.

For repeated nodes:

```text
actual time=0.010..0.020 rows=1 loops=5000
```

Approximate total work for that node is related to:

```text
0.020 ms × 5000 loops ≈ 100 ms
```

The single execution looks cheap, but thousands of repetitions can make the node expensive.

## 6.7 Planning Time vs Execution Time

```text
Planning Time: 0.350 ms
Execution Time: 28.620 ms
```

- **Planning Time:** time spent parsing, rewriting, and selecting a plan.
- **Execution Time:** time spent running the selected plan inside the server.

This does not fully represent application-perceived latency because network transfer, connection setup, client processing, and result rendering can add more time.

---

# 7. Common Scan Operations

## 7.1 Sequential Scan / Table Scan

PostgreSQL:

```text
Seq Scan on orders
```

MySQL:

```text
Table scan on orders
```

The database reads a large portion or all of the table.

A sequential scan is often reasonable when:

- the table is small;
- the query needs a large percentage of the rows;
- no useful index exists;
- the filter has low selectivity;
- reading the table sequentially is cheaper than many random lookups.

Example:

```sql
SELECT *
FROM orders
WHERE status = 'completed';
```

When most orders are completed, an index on `status` may not be selective enough to help.

> A sequential scan is not automatically a problem. It becomes suspicious when a large table is scanned to return only a very small number of rows.

## 7.2 Index Scan

```text
Index Scan using idx_orders_customer_id on orders
```

The database:

1. searches the index;
2. finds matching row locations;
3. fetches required table rows.

It works well when the predicate is selective.

```sql
SELECT *
FROM orders
WHERE customer_id = 42;
```

```sql
CREATE INDEX idx_orders_customer_id
ON orders (customer_id);
```

## 7.3 Index-Only Scan

```text
Index Only Scan using idx_orders_customer_created on orders
```

The query can obtain the required values from the index without reading every matching table row.

```sql
SELECT customer_id, created_at
FROM orders
WHERE customer_id = 42;
```

```sql
CREATE INDEX idx_orders_customer_created
ON orders (customer_id, created_at);
```

An index-only scan can reduce table I/O, but whether it avoids heap access completely depends on database-specific visibility and storage conditions.

## 7.4 Bitmap Index Scan + Bitmap Heap Scan

```text
Bitmap Heap Scan on orders
└── Bitmap Index Scan on idx_orders_status
```

This approach is useful when:

- more than a few rows match;
- an ordinary index scan would perform many scattered table reads;
- PostgreSQL can group row locations and fetch table pages more efficiently.

PostgreSQL may also combine multiple indexes using `BitmapAnd` or `BitmapOr`.

## 7.5 Index Condition vs Filter

```text
Index Cond: (customer_id = 42)
Filter: (total_amount > 1000)
Rows Removed by Filter: 850
```

Interpretation:

- `Index Cond` controls which index entries are visited.
- `Filter` is checked after candidate rows are retrieved.
- `Rows Removed by Filter` shows how much retrieved data was later discarded.

A large number of removed rows may indicate that the current index does not match the complete filtering pattern.

---

# 8. Common Join Algorithms

Assume this query:

```sql
SELECT o.id, c.name
FROM orders AS o
JOIN customers AS c
  ON c.id = o.customer_id
WHERE o.created_at >= DATE '2026-07-01';
```

The optimizer must choose:

- which table to read first;
- how to find matching rows in the second table;
- whether sorting or hashing is required.

## 8.1 Nested Loop Join

```text
Nested Loop
├── Index Scan on customers
└── Index Scan on orders
```

Conceptually:

```text
for each row from outer input:
    search matching rows in inner input
```

Works well when:

- the outer result is small;
- the inner lookup uses a selective index;
- only a small number of rows are needed;
- a `LIMIT` allows early termination.

Can become expensive when:

- the outer side returns many rows;
- the inner side is scanned repeatedly;
- the repeated node has a very high `loops` value.

## 8.2 Hash Join

```text
Hash Join
├── Seq Scan on orders
└── Hash
    └── Seq Scan on customers
```

Conceptually:

1. Read one input and build a hash table using the join key.
2. Read the other input.
3. Look up matching rows in the hash table.

Works well when:

- joining medium or large unsorted datasets;
- the join uses equality such as `a.id = b.a_id`;
- the hash table fits comfortably in memory.

Watch for:

- multiple hash batches;
- temporary disk usage;
- a much larger build side than estimated.

## 8.3 Merge Join

```text
Merge Join
├── Index Scan on orders
└── Index Scan on customers
```

A merge join reads both inputs in join-key order and advances through them together.

Works well when:

- both inputs are already sorted through indexes;
- large datasets are joined;
- an equality or supported range relationship is used.

If explicit sort nodes are required first, their cost must be considered as part of the strategy.

## 8.4 Join Diagram

```text
                 JOIN STRATEGY
                       │
        ┌──────────────┼──────────────┐
        │              │              │
        ▼              ▼              ▼
  Nested Loop       Hash Join      Merge Join
  Small outer       Equality       Sorted inputs
  Indexed inner     Large inputs   Large inputs
  Repeated lookup   Hash table     Ordered walk
```

No join type is universally best. The correct choice depends on row counts, indexes, data distribution, available memory, and query shape.

---

# 9. Sort, Aggregate, and Other Important Nodes

## 9.1 Sort

```text
Sort
  Sort Key: created_at DESC
  Sort Method: quicksort  Memory: 2048kB
```

An in-memory sort is usually manageable.

A disk spill may look similar to:

```text
Sort Method: external merge  Disk: 128000kB
```

A disk-based sort is not automatically wrong, but it is a signal to inspect:

- number of rows being sorted;
- row width;
- whether an index can provide the required order;
- whether earlier filtering can reduce the input;
- whether memory configuration is appropriate.

## 9.2 Aggregate

Common strategies include:

```text
Aggregate
HashAggregate
GroupAggregate
```

- `HashAggregate` builds hash groups and is effective when groups fit in memory.
- `GroupAggregate` normally consumes rows ordered by grouping keys.
- A plain `Aggregate` may calculate a single result such as `COUNT(*)`.

## 9.3 Limit

```text
Limit
└── Index Scan on orders
```

`LIMIT` can significantly change the selected plan because the database may prefer an access path that returns the first few rows quickly rather than the lowest full-result cost.

## 9.4 Materialize

```text
Materialize
└── Index Scan on products
```

A `Materialize` node stores an intermediate result so it can be reused without rerunning its child.

This can be helpful when the same result is read repeatedly, but it also consumes memory and may use temporary storage.

## 9.5 Memoize

In PostgreSQL, `Memoize` can cache results from repeated parameterized lookups inside nested loops.

```text
Nested Loop
└── Memoize
    └── Index Scan on customers
```

It is especially useful when the same lookup key appears repeatedly.

## 9.6 Parallel Nodes

Examples include:

```text
Gather
Parallel Seq Scan
Partial Aggregate
Finalize Aggregate
```

Parallelism can reduce elapsed time for large operations, but it also adds coordination overhead and consumes more server resources.

---

# 10. Using BUFFERS to Understand I/O

PostgreSQL example:

```sql
EXPLAIN (ANALYZE, BUFFERS)
SELECT *
FROM orders
WHERE customer_id = 42;
```

Possible output:

```text
Buffers: shared hit=120 read=8
```

## 10.1 Main Buffer Values

| Value | Meaning |
|---|---|
| `shared hit` | Required block was already available in PostgreSQL's shared buffer cache |
| `shared read` | Block had to be read into shared buffers from the operating-system/storage path |
| `shared dirtied` | Query modified a previously clean shared block |
| `shared written` | A dirty block was written by the backend |
| `local hit/read` | Activity involving temporary tables or local buffers |
| `temp read/written` | Temporary-file I/O, often caused by sorts, hashes, or materialization spilling to disk |

## 10.2 Why BUFFERS Matter

Two queries may have similar execution time during one test but very different I/O behavior.

```text
Query A: shared hit=25,000 read=0
Query B: shared hit=300 read=0
```

Both may currently be cached, but Query A touches far more pages. Under concurrency or after cache eviction, it is likely to create more pressure.

## 10.3 Warm Cache vs Cold Cache

The first run may read blocks from storage, while later runs find them cached.

```text
First run:  shared read=5000
Second run: shared hit=5000
```

For meaningful testing:

- run the query more than once;
- separate cold-cache and warm-cache observations;
- do not compare one cold run with one warm run;
- test with production-like data volume and distribution.

---

# 11. Estimated Rows vs Actual Rows

This is one of the most important parts of an analyzed plan.

```text
(cost=... rows=20 ...)
(actual ... rows=250000 loops=1)
```

The optimizer expected 20 rows but received 250,000.

That mismatch can lead to a poor plan because the optimizer may select:

- a nested loop instead of a hash join;
- repeated index lookups instead of a table scan;
- insufficient memory for a hash or sort;
- an inefficient join order;
- no parallel execution when it would help.

## 11.1 Estimate Error Ratio

A simple diagnostic ratio is:

```text
larger row count ÷ smaller row count
```

Example:

```text
Estimated rows: 100
Actual rows:    10,000
Error ratio:    10,000 ÷ 100 = 100×
```

A large ratio is a signal to investigate. It is not a fixed rule that every estimate must be exact.

## 11.2 Why Estimates Become Inaccurate

Common causes include:

- outdated table statistics;
- skewed data distribution;
- correlated columns treated as independent;
- expressions or functions that lack useful statistics;
- parameter values with very different selectivity;
- temporary tables without fresh statistics;
- rapid data changes;
- complex predicates that are difficult to estimate.

## 11.3 Refreshing Statistics

PostgreSQL:

```sql
ANALYZE orders;
```

For selected columns:

```sql
ANALYZE orders (customer_id, status, created_at);
```

MySQL:

```sql
ANALYZE TABLE orders;
```

SQL Server:

```sql
UPDATE STATISTICS dbo.orders;
```

Refreshing statistics may help the optimizer choose a better plan, but it does not replace proper indexing or query design.

---

# 12. Practical Optimization Examples

## 12.1 Example 1: Filtering Without an Index

### Query

```sql
SELECT id, customer_id, total_amount
FROM orders
WHERE customer_id = 42;
```

### Initial Plan

```text
Seq Scan on orders
  Filter: (customer_id = 42)
  Rows Removed by Filter: 999850
```

Interpretation:

- almost the whole table was scanned;
- only a small number of rows matched;
- `customer_id` is likely selective enough for an index.

### Optimization

```sql
CREATE INDEX idx_orders_customer_id
ON orders (customer_id);
```

### Improved Plan

```text
Index Scan using idx_orders_customer_id on orders
  Index Cond: (customer_id = 42)
```

The database can now navigate directly to matching index entries.

---

## 12.2 Example 2: Filter + Sort + LIMIT

### Query

```sql
SELECT id, customer_id, created_at
FROM orders
WHERE customer_id = 42
ORDER BY created_at DESC
LIMIT 20;
```

### Plan with a Single-Column Index

```text
Limit
└── Sort
    Sort Key: created_at DESC
    └── Bitmap Heap Scan on orders
        └── Bitmap Index Scan on idx_orders_customer_id
```

The existing index helps filter by customer, but the matching rows still need to be sorted.

### Better Index for This Access Pattern

```sql
CREATE INDEX idx_orders_customer_created
ON orders (customer_id, created_at DESC);
```

### Possible Improved Plan

```text
Limit
└── Index Scan using idx_orders_customer_created on orders
    Index Cond: (customer_id = 42)
```

The composite index supports both:

1. equality filtering by `customer_id`;
2. ordered retrieval by `created_at DESC`.

The database can stop after finding 20 rows instead of sorting every matching order.

---

## 12.3 Example 3: A Function Prevents a Normal Index Lookup

Assume an index exists on `created_at`:

```sql
CREATE INDEX idx_orders_created_at
ON orders (created_at);
```

### Less Index-Friendly Predicate

```sql
SELECT *
FROM orders
WHERE DATE(created_at) = DATE '2026-07-27';
```

Applying a function to the indexed column may prevent a normal range lookup, depending on the database and available expression indexes.

### Range-Based Predicate

```sql
SELECT *
FROM orders
WHERE created_at >= TIMESTAMP '2026-07-27 00:00:00'
  AND created_at <  TIMESTAMP '2026-07-28 00:00:00';
```

This form directly describes a range on `created_at` and is usually more index-friendly.

```text
Index Scan using idx_orders_created_at on orders
  Index Cond:
    (created_at >= '2026-07-27 00:00:00'
     AND created_at < '2026-07-28 00:00:00')
```

---

## 12.4 Example 4: Repeated Work in a Nested Loop

### Plan

```text
Nested Loop
  actual rows=200000 loops=1
  ├── Seq Scan on customers
  │   actual rows=50000 loops=1
  └── Index Scan on orders
      actual rows=4 loops=50000
```

The inner index scan runs 50,000 times.

Even if each lookup is fast, total work may be significant.

Possible areas to investigate:

- Can the outer input be filtered earlier?
- Is the join producing more rows than expected?
- Would a hash join be more appropriate for this volume?
- Are statistics causing the optimizer to underestimate the outer row count?
- Does the inner index match the join condition?

Do not force a join algorithm immediately. First identify why the optimizer believed the selected algorithm would be inexpensive.

---

## 12.5 Example 5: Rows Removed by Filter

### Plan

```text
Index Scan using idx_orders_status on orders
  Index Cond: (status = 'completed')
  Filter: (total_amount > 5000)
  Rows Removed by Filter: 800000
  actual rows=1000
```

The index retrieves completed orders, but most are later rejected by `total_amount`.

A possible composite index is:

```sql
CREATE INDEX idx_orders_status_amount
ON orders (status, total_amount);
```

Whether this is beneficial depends on:

- how frequently the query runs;
- how selective `status` and `total_amount` are;
- whether similar query patterns exist;
- index storage and write overhead;
- whether column order matches other predicates and ordering needs.

Always verify the result with a new execution plan.

---

## 12.6 Example 6: Sort Spilling to Disk

### Plan

```text
Sort
  Sort Key: created_at
  Sort Method: external merge  Disk: 220000kB
  └── Seq Scan on audit_logs
      actual rows=8000000
```

Interpretation:

- eight million rows are being sorted;
- the sort exceeded available working memory;
- temporary disk I/O was required.

Possible improvements:

- reduce rows before sorting;
- select fewer or narrower columns;
- use an index that provides the required ordering;
- avoid sorting data that the application will not consume;
- review per-operation memory carefully rather than globally increasing it without capacity analysis.

---

# 13. A Reliable Query-Tuning Workflow

Use a measured process rather than guessing.

```text
Slow Query
    │
    ▼
Capture Baseline
    │
    ▼
EXPLAIN ANALYZE + BUFFERS
    │
    ▼
Find High Work / Bad Estimates
    │
    ▼
Change One Relevant Thing
    │
    ▼
Run the Same Test Again
    │
    ▼
Compare Time, Rows, Loops, I/O
```

## Step 1: Capture the Exact Query

Include:

- real parameter values;
- complete joins and filters;
- ordering and pagination;
- relevant session settings;
- the same schema and indexes as the target environment.

Different parameter values can produce very different row counts and plans.

## Step 2: Record a Baseline

PostgreSQL:

```sql
EXPLAIN (ANALYZE, BUFFERS, SETTINGS)
SELECT ...;
```

Record:

- total execution time;
- planning time;
- actual rows;
- loops;
- buffer hits and reads;
- temporary reads and writes;
- sort/hash memory and disk usage.

## Step 3: Identify the Main Source of Work

Look for:

- scans over large tables;
- high actual row counts;
- rows removed by filters;
- high loop counts;
- large estimate errors;
- disk-based sorts or hashes;
- repeated subplans;
- expensive operations early in the plan.

## Step 4: Understand Why the Plan Was Chosen

Ask:

- Were statistics accurate?
- Did the available index match the predicate?
- Was the predicate selective?
- Did the query request many columns?
- Did ordering requirements influence the plan?
- Did `LIMIT` favor a low-startup-cost plan?
- Did parameter values differ from typical values?

## Step 5: Make One Focused Change

Examples:

- create or adjust a composite index;
- rewrite a non-sargable predicate;
- refresh statistics;
- reduce rows before joining or sorting;
- remove unnecessary columns;
- replace offset pagination with keyset pagination where appropriate;
- fix a join condition that produces duplicate combinations.

## Step 6: Measure Again

Compare the same metrics under similar conditions.

```text
Before: 850 ms, 120,000 shared blocks, 220 MB temp write
After:   35 ms,   2,500 shared blocks,   0 MB temp write
```

A plan that merely looks different is not enough. The change should improve the workload metric that matters.

## Step 7: Test Workload Impact

An index can speed up reads while making writes more expensive.

Before keeping it, consider:

- insert/update/delete rate;
- index size;
- cache pressure;
- maintenance overhead;
- duplicated or overlapping indexes;
- performance under realistic concurrency.

---

# 14. Safe Use with INSERT, UPDATE, and DELETE

`EXPLAIN ANALYZE` executes data-changing statements.

## 14.1 PostgreSQL Safe Testing Pattern

```sql
BEGIN;

EXPLAIN (ANALYZE, BUFFERS)
UPDATE orders
SET status = 'archived'
WHERE created_at < DATE '2024-01-01';

ROLLBACK;
```

The update executes inside the transaction, runtime data is collected, and the changes are then rolled back.

Before relying on this pattern, consider:

- triggers still run;
- locks can still be acquired;
- sequences are generally not rolled back;
- external side effects triggered outside the transaction may not be reversible;
- a large update can still generate substantial temporary work and WAL;
- running it on production can affect other sessions.

## 14.2 Safer First Step

Start with plain `EXPLAIN`:

```sql
EXPLAIN
DELETE FROM sessions
WHERE expires_at < CURRENT_TIMESTAMP;
```

Use `EXPLAIN ANALYZE` only in a controlled environment when actual runtime information is necessary.

---

# 15. Database-Specific Differences

The principle is shared across databases, but syntax and terminology differ.

## 15.1 PostgreSQL

Common command:

```sql
EXPLAIN (ANALYZE, BUFFERS, FORMAT TEXT)
SELECT ...;
```

Important fields:

- `cost`;
- estimated `rows` and `width`;
- `actual time`, actual `rows`, and `loops`;
- `Rows Removed by Filter`;
- `Buffers`;
- sort and hash details;
- planning and execution time.

PostgreSQL plans are usually read from the most deeply indented child nodes upward.

## 15.2 MySQL 8.4

Estimated plan:

```sql
EXPLAIN FORMAT=TREE
SELECT ...;
```

Actual execution:

```sql
EXPLAIN ANALYZE
SELECT ...;
```

Typical iterator output:

```text
-> Index lookup on orders using idx_orders_customer_id
   (customer_id=42)
   (cost=5.20 rows=10)
   (actual time=0.030..0.060 rows=8 loops=1)
```

MySQL 8.4 notes:

- `EXPLAIN ANALYZE` uses `TREE` format;
- times are shown in milliseconds;
- estimated and actual rows can be compared directly;
- JSON output is available for normal `EXPLAIN`, while `EXPLAIN ANALYZE` uses tree output.

## 15.3 SQL Server

SQL Server commonly uses graphical plans in SQL Server Management Studio.

- **Estimated Execution Plan:** compiled optimizer plan without running the query.
- **Actual Execution Plan:** compiled plan plus runtime execution context.
- **Live Query Statistics:** runtime progress while a query is executing.

Common operators include:

- Table Scan;
- Index Scan;
- Index Seek;
- Key Lookup;
- Nested Loops;
- Hash Match;
- Merge Join;
- Sort;
- Stream Aggregate;
- Hash Aggregate.

A major diagnostic signal is the difference between **Estimated Number of Rows** and **Actual Number of Rows**.

## 15.4 SQLite

```sql
EXPLAIN QUERY PLAN
SELECT *
FROM orders
WHERE customer_id = 42;
```

Possible output without an index:

```text
SCAN orders
```

Possible output with an index:

```text
SEARCH orders USING INDEX idx_orders_customer_id (customer_id=?)
```

SQLite terminology:

- `SCAN` generally means all rows are visited;
- `SEARCH` means only a subset is visited;
- `USING COVERING INDEX` means required values can be read from the index;
- `USE TEMP B-TREE FOR ORDER BY` indicates temporary sorting work.

SQLite documents that `EXPLAIN QUERY PLAN` output is intended for interactive debugging and may change between releases, so applications should not parse it as a stable public format.

---

# 16. Production Best Practices

## 16.1 Find Important Queries Before Tuning

Do not optimize only the query that looks complicated.

Prioritize queries using workload evidence such as:

- total database time consumed;
- average and high-percentile latency;
- call frequency;
- rows read versus rows returned;
- I/O usage;
- temporary-file usage;
- lock duration;
- business impact.

In PostgreSQL, `pg_stat_statements` is commonly used to identify high-impact queries by tracking planning and execution statistics across statements.

## 16.2 Test with Realistic Data Distribution

A query that is fast with 10,000 uniform test rows can behave differently with 100 million production rows containing skewed values.

Test using realistic:

- table sizes;
- value frequency;
- null percentage;
- date ranges;
- tenant sizes;
- parameter values;
- concurrency.

## 16.3 Use Representative Parameters

Consider a multi-tenant query:

```sql
SELECT *
FROM invoices
WHERE tenant_id = $1
  AND status = $2;
```

One tenant may own 100 rows while another owns 20 million. A plan suitable for the first tenant may perform poorly for the second.

Test common, small, large, and unusual parameter values.

## 16.4 Keep Statistics Healthy

Statistics should reflect current data.

PostgreSQL normally uses autovacuum and auto-analyze, but bulk loads or rapidly changing tables may require an explicit `ANALYZE` at the appropriate time.

## 16.5 Avoid Optimizing Only for One Cached Run

Compare multiple runs and examine I/O counters. A query that is fast only because all pages are already cached may still create serious pressure under a busy workload.

## 16.6 Prefer Evidence Over Planner Forcing

Disabling scan or join strategies can be useful for controlled diagnosis, but permanently forcing the optimizer is usually fragile.

A better long-term fix often involves:

- accurate statistics;
- suitable indexes;
- clear predicates;
- correct data types;
- good query shape;
- appropriate schema design.

## 16.7 Remember EXPLAIN ANALYZE Overhead

Runtime instrumentation adds overhead. Very small or highly repetitive nodes can be affected noticeably by timing measurements.

When exact per-node timing is unnecessary in PostgreSQL, this can reduce overhead:

```sql
EXPLAIN (ANALYZE, BUFFERS, TIMING OFF)
SELECT ...;
```

The complete statement runtime is still measured, and actual row counts are still collected.

---

# 17. Quick Reading Checklist

When reading a plan, follow this order:

```text
1. Total execution time
2. Actual rows at the root
3. Large estimated-vs-actual row differences
4. Nodes with high time × loops
5. Large scans returning few rows
6. Rows removed by filters
7. Join order and repeated inner lookups
8. Sort/hash memory and disk spills
9. Shared and temporary buffer activity
10. Planning time and unusual planner settings
```

Use these questions while inspecting the plan:

- What node produces the first large row set?
- Where does the row count grow unexpectedly?
- Which child is executed many times?
- Is the query reading far more rows than it returns?
- Is an index condition being applied, or only a post-read filter?
- Does sorting happen before or after selective filtering?
- Are statistics close enough to actual data?
- Is the expensive behavior caused by query shape, indexing, statistics, or memory?

---

# 18. Interview-Ready Summary

`EXPLAIN` shows the optimizer's estimated execution plan without running a normal `SELECT`. `EXPLAIN ANALYZE` executes the statement and adds actual runtime statistics.

A strong plan analysis focuses on four relationships:

```text
Estimated rows  ↔ Actual rows
Cost            ↔ Actual time
Rows per loop   × Loop count
Rows processed  ↔ Rows returned
```

The most important practical ideas are:

1. Read plan trees from child nodes upward.
2. Do not assume every sequential scan is bad.
3. Compare estimated and actual row counts before blaming the join algorithm.
4. Multiply per-loop behavior mentally when a node runs many times.
5. Use buffer and temporary-file information to understand I/O, not only elapsed time.
6. Design indexes around complete access patterns: filtering, joining, ordering, and limiting.
7. Make one focused change, rerun the same plan, and compare measurable results.
8. Treat `EXPLAIN ANALYZE` as a real execution, especially for write statements.
9. Test with realistic data volume, distribution, parameters, and cache conditions.
10. Optimize high-impact workload queries, not merely visually complex SQL.

A useful one-line explanation is:

> `EXPLAIN` tells you what the optimizer expects to do; `EXPLAIN ANALYZE` tells you what actually happened.

---

# 19. Official References

- PostgreSQL 18 — EXPLAIN:  
  <https://www.postgresql.org/docs/current/sql-explain.html>

- PostgreSQL 18 — Using EXPLAIN:  
  <https://www.postgresql.org/docs/current/using-explain.html>

- PostgreSQL 18 — ANALYZE statistics collection:  
  <https://www.postgresql.org/docs/current/sql-analyze.html>

- PostgreSQL 18 — `pg_stat_statements`:  
  <https://www.postgresql.org/docs/current/pgstatstatements.html>

- MySQL 8.4 — EXPLAIN Statement:  
  <https://dev.mysql.com/doc/refman/8.4/en/explain.html>

- MySQL 8.4 — ANALYZE TABLE:  
  <https://dev.mysql.com/doc/refman/8.4/en/analyze-table.html>

- SQLite — EXPLAIN QUERY PLAN:  
  <https://www.sqlite.org/eqp.html>

- SQL Server — Query Processing Architecture Guide:  
  <https://learn.microsoft.com/en-us/sql/relational-databases/query-processing-architecture-guide>

---

**End of document**
