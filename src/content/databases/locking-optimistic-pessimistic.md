---
title: "Locking"
group: "Transactions & Concurrency"
order: 6
---

# Locking: Optimistic vs Pessimistic

> Two ways to stop concurrent writes from clobbering each other: pessimistic locking grabs an exclusive row lock up front with `SELECT ... FOR UPDATE` so everyone else waits, while optimistic locking takes no lock, stamps a version on the row, and writes only if that version has not moved since you read it.

## What it is
- **Pessimistic locking** assumes a fight is coming, so you grab an exclusive lock on the row before touching it. Until your transaction ends, nobody else can update, delete, or lock that row. Easy to reason about, and you pay for it with every other writer stuck waiting behind you.
- **Optimistic locking** bets the other way. Conflicts are rare, so it takes **no lock at all**. You read the row with a version marker, and at write time you say "apply this only if the version is still what I read." If someone slipped in ahead of you, the write matches no rows and you retry.

> [!KEY] Pessimistic **prevents** conflicts by making writers wait. Optimistic **detects** them at write time and retries. One trades throughput for simplicity, the other trades a rare retry for a lock-free happy path.

The trade-off in one view:

| | **Pessimistic** | **Optimistic** |
| --- | --- | --- |
| Mechanism | `SELECT ... FOR UPDATE` takes an **exclusive row lock** before you read | Read a **version / `updated_at`** column, then **compare-and-set** on write |
| Lock held | Yes - **others block** until you commit or roll back | **None** - no database lock |
| Cost | Serialized writers, lower throughput, **deadlock risk** | Free on the happy path, **one retry** when two writers collide |
| On conflict | The loser **waits**, then proceeds | Update hits **0 rows**, so reload and retry |
| Best when | Conflicts **likely** and the critical section is short (a hot row) | Conflicts **rare** and reads far outnumber writes |

> [!TIP] Default to **optimistic** for ordinary web CRUD, where reads dominate and two users rarely touch the same row at once. Reach for **pessimistic** only on genuinely hot rows (inventory counters, wallet balances) where collisions are the norm.

## Key points
- **Pessimistic in Postgres** means `SELECT ... FOR UPDATE` inside a transaction: an exclusive row lock that makes other writers block until you commit or roll back. `FOR SHARE` is the weaker variant - several transactions can hold it at once, but it still blocks anyone trying to `UPDATE` or `DELETE` the row.
- **Optimistic needs no database lock.** Add a `version` integer (or reuse `updated_at`) and write `UPDATE ... SET ..., version = version + 1 WHERE id = ? AND version = ?`. Check the affected-row count: **0 means someone else won the race**, so reload and retry. This is exactly what an ORM's optimistic-locking feature generates (Hibernate's `@Version`, SQLAlchemy's `version_id_col`).
- Because Postgres is **MVCC**, a plain `SELECT` never blocks and is never blocked - the manual puts it flatly: "reading never blocks writing and writing never blocks reading." Explicit locks coordinate concurrent **writes**, not reads. If you catch yourself locking rows just to protect a read, rethink.
- When a row you want is already locked, three behaviors are available:

| Clause | Behavior when the target row is already locked |
| --- | --- |
| `FOR UPDATE` (default) | **Waits** for the lock to release, then proceeds |
| `FOR UPDATE NOWAIT` | **Errors immediately** so the caller can fail fast |
| `FOR UPDATE SKIP LOCKED` | **Skips** the locked row silently - the classic job-queue trick so each worker pulls a different batch |

- **Deadlocks** show up when two transactions lock the same rows in opposite order. Postgres detects the cycle, aborts one with SQLSTATE `40P01`, and lets the survivor finish. The fix is dull but reliable: acquire locks in the **same order** across every code path, then retry the aborted one.
- The same idea turns up **outside SQL**. DynamoDB has no row locks, so optimistic concurrency is basically your only option: a version attribute plus a conditional write that succeeds only if the stored version still matches what you read. A mismatch throws `ConditionalCheckFailedException` (the NoSQL name for a zero-row update), and you retry.

## Example
Pessimistic - take the lock, and every other writer waits for your `COMMIT`:
```sql
BEGIN;
-- exclusive row lock; a concurrent FOR UPDATE / UPDATE on id=5 blocks here
SELECT stock FROM product WHERE id = 5 FOR UPDATE;
UPDATE product SET stock = stock - 1 WHERE id = 5;
COMMIT;                          -- lock released
```

Optimistic - no lock, the `WHERE` clause guards against a concurrent change:
```sql
UPDATE product
SET    stock = stock - 1, version = version + 1
WHERE  id = 5 AND version = 12;  -- fires only if version is still 12
-- 0 rows updated => the version moved under you => reload and retry
```

Queue pattern - hand each worker its own rows, skip whatever is taken:
```sql
SELECT id FROM job
WHERE  state = 'ready'
ORDER  BY created_at
LIMIT  10
FOR UPDATE SKIP LOCKED;          -- workers never step on each other
```

## Interview Q&A
- **Pessimistic vs optimistic?** Pessimistic locks the row before you touch it so others wait. Optimistic takes no lock and checks a version at write time, retrying if it moved.
- **When would you pick optimistic?** When conflicts are rare and reads dominate. You skip all lock overhead and only pay a retry in the uncommon case where two writers collide.
- **How do you implement it?** A version or timestamp column plus `UPDATE ... WHERE version = ?`. If zero rows change, someone beat you to it, so reload and try again.
- **Does `SELECT ... FOR UPDATE` block plain reads?** No. Under MVCC an ordinary `SELECT` reads a snapshot and never waits on a row lock. `FOR UPDATE` only blocks other writers and other `FOR UPDATE` / `FOR SHARE` on the same rows.
- **How does Postgres handle a deadlock?** It detects the cycle, aborts one transaction with error `40P01`, and lets the other finish. Your job is to catch that and retry.

## Gotchas
> [!WARN] Optimistic locking is only safe **if the app actually handles the retry**. Skip it and a zero-row update sails through silently - that is a lost update, the exact bug you set out to prevent.

> [!WARN] On DynamoDB **global tables**, concurrent writes reconcile with **last-writer-wins**, which quietly undercuts version-based optimistic locking across regions. Know that before you lean on it in a multi-region table.

- Holding `SELECT ... FOR UPDATE` open across a long transaction serializes every writer behind you and makes deadlocks more likely. Lock late, keep the critical section tiny, and commit fast.
- `SKIP LOCKED` deliberately shows you an inconsistent view - the manual flatly calls it "not suitable for general purpose work." Great for queues, wrong for anything that must see every matching row.
- Under `REPEATABLE READ` or `SERIALIZABLE`, `FOR UPDATE` does not block when the row changed since your snapshot. It raises a serialization error instead. That is retryable, but it catches people who only ever tested under the default `READ COMMITTED`.

## Revise next
- [Transaction isolation levels](transaction-isolation-levels.md) (`READ COMMITTED` vs `REPEATABLE READ` vs `SERIALIZABLE`)
- [ACID properties](acid-properties.md)
- Django [`select_for_update()`](../django/transactions-atomic.md) and [`F()` expressions](../django/q-f-annotate-aggregate.md) for atomic updates

*Reviewed against PostgreSQL 18 and the AWS DynamoDB developer guide, July 2026.*
