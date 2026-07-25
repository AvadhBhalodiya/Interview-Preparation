---
title: "Isolation Levels"
group: "Transactions & Concurrency"
order: 5
---

# Transaction Isolation Levels

> An isolation level is the dial between concurrency and correctness: turn it up and each step forbids one more anomaly a concurrent transaction could cause, but you pay for it in conflicts you have to retry.

## What it is
- The **"I" in ACID**. An isolation level is your contract for how much of other in-flight transactions your transaction is allowed to notice. Loosen it for throughput, tighten it to kill surprises.
- The SQL standard names four levels and defines them by the anomalies they must forbid, not by how the engine pulls it off. That gap is why "Repeatable Read" on Postgres and "Repeatable Read" on MySQL are not the same thing: the standard only sets a floor, and a database is free to be stricter.

> [!KEY] An isolation level is just a list of anomalies the engine promises to prevent - nothing more. Climbing the list trades throughput for safety, and in Postgres you pay in **aborts (SQLSTATE `40001`) you must retry**, not locks you wait on.

The SQL standard grades the four levels by which anomalies each one still permits, weakest on top:

| Level | Dirty read | Non-repeatable read | Phantom | Serialization anomaly |
| --- | --- | --- | --- | --- |
| Read Uncommitted | Possible | Possible | Possible | Possible |
| Read Committed | **Prevented** | Possible | Possible | Possible |
| Repeatable Read | Prevented | **Prevented** | Possible | Possible |
| Serializable | Prevented | Prevented | **Prevented** | **Prevented** |

Postgres is stricter than that floor. It never returns a dirty read at any level (ask for Read Uncommitted and you quietly get Read Committed), and its **Repeatable Read is full snapshot isolation** that also blocks phantoms. So Postgres ships three distinct levels, not four.

## Key points
- **The four anomalies, concretely.** A **dirty read** sees another transaction's uncommitted writes (which may roll back). A **non-repeatable read** is one row returning a different value when read twice in a transaction. A **phantom** is a range query gaining or losing rows on a re-run. A **serialization anomaly** (write skew) is an interleaving where every transaction is individually correct yet the end state matches no serial order.
- **Read Committed** (the default) hands each statement a fresh snapshot of committed data. Two SELECTs in one transaction can legitimately return different values. That is the level working as designed, and it bites read-modify-write logic that assumed the world stood still.
- **Repeatable Read** takes the snapshot once, at the first query, and every read for the rest of the transaction sees the database frozen at that instant. Postgres also blocks phantoms here, which the standard does not require. The trade: update a row that changed after your snapshot and Postgres can't reconcile it, so it aborts you with a `40001` serialization error.
- **Serializable** is Repeatable Read plus a promise that the concurrent result matches *some* one-transaction-at-a-time ordering. Postgres delivers this with SSI, tracking read/write dependencies through predicate locks (the `SIReadLock` rows in `pg_locks`) and killing one transaction in any unsafe cycle. Those locks never block and never deadlock. The cost shows up as `40001` instead.
- **You set the level per transaction**: `BEGIN ISOLATION LEVEL …` or `SET TRANSACTION …`. The higher you climb, the more serialization failures you hit and the more retry logic you owe the database.

> [!TIP] Reach for Serializable only when an invariant spans multiple rows (write skew). A single-row read-modify-write is cheaper to protect with `SELECT ... FOR UPDATE` at Read Committed.

## Example
```sql
-- session A
BEGIN ISOLATION LEVEL REPEATABLE READ;
SELECT balance FROM account WHERE id = 1;    -- 100; snapshot is fixed here

-- session B, concurrently: UPDATE account SET balance = 40 WHERE id = 1; COMMIT;

SELECT balance FROM account WHERE id = 1;    -- still 100, not 40 (repeatable)
UPDATE account SET balance = balance - 30 WHERE id = 1;
-- ERROR: could not serialize access due to concurrent update  (SQLSTATE 40001)
COMMIT;                                       -- nothing committed; retry the whole txn
```

The read stays stable, which is the whole point of the level. But the write collides with B's committed change and Postgres aborts rather than guess. Above Read Committed that retry is not optional:

```python
import time
import psycopg
from psycopg.errors import SerializationFailure   # driver name for SQLSTATE 40001

# Above Read Committed, retrying the WHOLE transaction on 40001 is mandatory.
def run_serializable(conn, work, retries=5):
    conn.isolation_level = psycopg.IsolationLevel.SERIALIZABLE
    for attempt in range(retries):
        try:
            with conn.transaction():         # BEGIN; commits on a clean exit
                work(conn)                   # your read-modify-write goes here
            return                           # success - stop retrying
        except SerializationFailure:         # conflict: snapshot could not serialize
            time.sleep(0.05 * 2 ** attempt)  # back off, then rebuild from a fresh snapshot
    raise RuntimeError("gave up after retries")  # out of retries: surface it, never drop the write
```

## Interview Q&A
- **The four levels, weakest to strongest?** Read Uncommitted, Read Committed, Repeatable Read, Serializable.
- **Dirty vs non-repeatable vs phantom?** Dirty reads uncommitted data. Non-repeatable is one row's value changing between two reads in a transaction. Phantom is new rows showing up when you re-run a range query.
- **Postgres default, and can it dirty-read?** Read Committed. No dirty reads ever, because Read Uncommitted collapses onto Read Committed.
- **If Repeatable Read already blocks phantoms in Postgres, why does Serializable exist?** Because Repeatable Read still permits write skew: two transactions each read a valid snapshot, each writes based on it, and together they break an invariant neither violated alone. Only Serializable rejects that.
- **What does the app owe you above Read Committed?** A retry loop. Serialization failures come back as SQLSTATE `40001`, and the only correct response is to roll back and run the transaction again.

## Gotchas
> [!WARN] Higher isolation costs you **aborts, not waits**. RR and SSI conflicts surface as `40001`, and an uncaught `40001` is a failed user request. Build the retry loop before you turn the dial up.

> [!WARN] "Repeatable Read" is **not portable**. Postgres blocks phantoms at that level, the SQL standard permits them, and MySQL's InnoDB (which defaults to Repeatable Read, unlike Postgres) has its own semantics. Don't carry assumptions across engines.

- Read Committed will cheerfully stitch together an inconsistent picture across statements: a dashboard firing five SELECTs can read five different moments. If several reads must agree, wrap them in one Repeatable Read transaction.
- NoSQL sets its own floor, and you can't dial it. DynamoDB's isolation is fixed: multi-item reads (`Query`, `Scan`, `BatchGetItem`) are **read-committed** against an in-flight transaction, and you get **serializable** only through the transactional APIs (`TransactGetItems` / `TransactWriteItems`, capped at 100 actions and 4 MB). Don't assume a document store hands you snapshot isolation for free.

## Revise next
- [ACID properties](acid-properties.md)
- [Locking](locking-optimistic-pessimistic.md) (optimistic vs pessimistic)
- MVCC & `SELECT … FOR UPDATE`

*Reviewed against PostgreSQL 18, July 2026.*
