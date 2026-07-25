---
title: "Joins, Subqueries & CTEs"
group: "Queries & Optimization"
order: 1
---

# Joins, Subqueries & CTEs (`WITH`)

> Three ways to bring data together: a JOIN matches rows across tables on a condition, a subquery feeds one query's output into another, and a CTE (`WITH`) names that subquery so the SQL reads top to bottom and can recurse.

## What it is
- A **JOIN** reassembles data that normalization spread across tables, gluing their columns back into one row set and keeping or dropping rows based on a match condition.
- A **subquery** is just a query used as the input to another one. A **CTE** is the same idea with a name attached: it changes how the query reads, not what it computes, and it is what unlocks recursion (`WITH RECURSIVE`).

> [!KEY] A join is a rule for **which rows survive and where NULLs appear**. Start from `INNER` (matches only), and each outer join **adds back the unmatched rows** from one or both sides, padding the missing columns with `NULL`.

Every join type is just that rule spelled out:

| Join | Which rows come back | Unmatched rows |
| --- | --- | --- |
| `INNER` | **only rows that match on both sides** | **dropped** from both |
| `LEFT` | **every left row**, plus matched right | right columns **`NULL`** |
| `RIGHT` | **every right row**, plus matched left | left columns **`NULL`** |
| `FULL` | **every row from both sides** | **`NULL`** on whichever side missed |
| `CROSS` | **each left row paired with each right** (N x M) | none - **no condition** |

> [!TIP] `RIGHT` is just `LEFT` with the tables swapped, and the comma form `FROM a, b` is a `CROSS` join. Most teams standardize on `LEFT` and read every join left to right.

## Key points
- **`CROSS` is the Cartesian product** - every left row against every right with no condition - and the comma form `FROM a, b` produces exactly that. Forget the join condition and you get one by accident.
- **Where you filter an outer join decides whether it stays outer:**

| Filter on a `LEFT JOIN` | When it runs | Result |
| --- | --- | --- |
| in `ON b.x = ...` | **while the join is built**, before NULLs are added | keeps all left rows, **stays a LEFT join** |
| in `WHERE b.x = ...` | **after the join**, NULLs already added | NULL rows fail the test, **silently becomes INNER** |

- **Subquery flavors** each do a different job:

| Flavor | Returns | Use it for |
| --- | --- | --- |
| **Scalar** | exactly **one value** | a single figure in `SELECT` or `WHERE` |
| **`IN`** | a **membership test** (same as `= ANY`) | the value falling in a small set |
| **Correlated** | **re-runs per outer row** | an inner query that needs the current outer row |
| **`EXISTS`** | **true at the first matching row** | existence checks - stops early, **ignores NULLs** |

- **`NOT IN` with a `NULL` anywhere in the list returns zero rows, every time.** It expands to `<> ALL`, and `x <> NULL` is unknown rather than true, so no row can ever qualify. Reach for `NOT EXISTS` and stop thinking about it.
- **A CTE and its equivalent subquery plan identically once the CTE is inlined** - the CTE just reads top to bottom, can recurse, and can be referenced more than once. Since PG 12 the planner picks inline vs materialize like this:

| CTE reference | PG 12+ default | What it means |
| --- | --- | --- |
| used **once**, no volatile functions | **inlined** | folded into the parent and jointly optimized |
| used **twice or more** | **materialized** | computed once then reused, an **optimization fence** |
| `AS MATERIALIZED` | forces **materialize** | the pre-12 behavior - run an expensive function once |
| `AS NOT MATERIALIZED` | forces **inline** | fold it in even when referenced repeatedly |

- **`WITH RECURSIVE`** is an anchor query, then `UNION ALL`, then a term that references the CTE itself. Postgres seeds a working table from the anchor, applies the recursive term, and repeats until a pass adds no new rows. That is how you walk a tree or graph without knowing its depth up front.
- **Favor a plain join over a correlated subquery** when the planner could hash or merge the two sets instead of looping once per outer row. Modern Postgres rewrites many of these on its own, but not all, so read the `EXPLAIN` output instead of trusting folklore. Indexes on join keys mostly pay off for nested-loop and merge joins - a hash join built over a sequential scan may never touch them.

## Example
```sql
-- Recursive CTE: from one manager, walk down to every direct and indirect report.
WITH RECURSIVE reports AS (
    SELECT id, manager_id, name              -- anchor: the manager we start from
    FROM employee
    WHERE id = 42
  UNION ALL
    SELECT e.id, e.manager_id, e.name        -- recursive term: anyone reporting into the set
    FROM employee e
    JOIN reports r ON e.manager_id = r.id
)
SELECT * FROM reports;

-- EXISTS: customers with at least one order; stops at the first match per customer.
SELECT c.name
FROM customer c
WHERE EXISTS (SELECT 1 FROM orders o WHERE o.customer_id = c.id);
```

## Interview Q&A
- **LEFT vs INNER join?** INNER returns only the rows that match on both sides. LEFT returns every left row and NULL-fills the right where nothing matches. LEFT is what you want when "no match" is itself the answer, like customers who have never placed an order.
- **IN vs EXISTS?** `EXISTS` returns true as soon as one matching row shows up and does not care about NULLs. `IN` builds a set of values, and its twin `NOT IN` returns nothing if that set contains a NULL. On a modern planner the speed is usually a wash, so let the NULL behavior make the call and use `EXISTS` for existence checks.
- **What is a CTE, and when do you go recursive?** A named subquery that makes one statement readable and lets you reference the same result more than once. Go recursive when the data is a hierarchy or graph of unknown depth: org charts, threaded comments, category trees, bill-of-materials.
- **Is a CTE slower than a subquery?** Not since PG 12, for the common case. Referenced once it is inlined and plans identically. Referenced several times it is materialized by default, which can help or hurt, so check `EXPLAIN` and add `AS NOT MATERIALIZED` if you want it folded in.
- **Do NoSQL stores like DynamoDB support joins?** No, and that is deliberate: DynamoDB has no join operator at all. You denormalize instead, using composite keys so related items sit together and a single request answers the whole query. That is the heart of single-table design: you shape the data so the join never has to happen. The work does not disappear, it just moves into your schema or your application code.

## Gotchas
> [!WARN] Filtering the right-hand table of a `LEFT JOIN` in the `WHERE` clause silently drops the NULL-filled rows and demotes the whole query to an inner join. If you mean to filter the right table, put the condition in `ON`. If you mean to keep the unmatched rows, test for `NULL` on purpose.

> [!WARN] `NOT IN (subquery)` collapses to zero rows the moment that subquery returns a single `NULL`. Use `NOT EXISTS`, or filter the NULLs out of the subquery first.

- A **correlated subquery re-runs once per outer row**, so on a large input it quietly becomes O(n^2) work. When the correlation is a plain equality, rewrite it as a join.
- A `WITH RECURSIVE` that never stops, or a graph with a cycle in it, loops until it errors out or eats all your memory. Guard graph walks with the `CYCLE` clause (**PG 14+**) or your own visited-array check. `UNION` only removes fully duplicate rows, so once you carry a path or a counter along it will not break the cycle for you.

## Revise next
- [B-tree indexing](indexing-btree.md) and how join keys use it
- [Reading `EXPLAIN` / `EXPLAIN ANALYZE` plans](explain-analyze.md)
- Window functions vs `GROUP BY` aggregation

*Reviewed against PostgreSQL 18, July 2026.*
