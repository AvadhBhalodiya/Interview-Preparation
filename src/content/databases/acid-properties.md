---
title: "ACID Properties"
group: "Transactions & Concurrency"
order: 4
---

# ACID Properties

> ACID is the four-part guarantee behind every relational transaction: all-or-nothing (Atomicity), every commit leaves valid data (Consistency), concurrent work doesn't collide (Isolation), and once committed it survives a crash (Durability).

## What it is
ACID is the set of promises a database makes so a transaction stays correct even when the machine dies mid-write or a dozen other transactions are hammering the same rows. Four letters, four separate guarantees. It is why money, orders, and inventory live in Postgres and not a cache: the moment "half the update applied" becomes an unacceptable answer, this is what you are paying for.

> [!KEY] A transaction is one unit of work that either fully happens or fully doesn't. ACID names the four ways the database defends that promise: against your own bad data (C), against other transactions (I), and against hardware failure (A and D).

Each letter, and what you would watch break without it:

| Property | The guarantee | What breaks without it |
| --- | --- | --- |
| **A**tomicity | Every statement commits, or none does (rollback on any failure) | A crash mid-transaction leaves **half-applied writes**: money debited but never credited |
| **C**onsistency | Each commit leaves valid data (constraints, FKs, triggers all hold) | A commit persists rows that **violate declared rules**: orphans, negative balances |
| **I**solation | Concurrent transactions act as if they ran one at a time (strictness set by isolation level) | Transactions **see each other's half-finished work**: dirty reads, lost updates |
| **D**urability | Once COMMIT returns, the write survives a crash (WAL flushed to disk first) | An **acknowledged commit vanishes** on power loss |

## Key points
Under the hood Postgres delivers each letter with a different mechanism, and none of them is the undo log people expect:

| Property | How Postgres delivers it |
| --- | --- |
| Atomicity | Per-row transaction IDs + a commit log (`clog`), **not an undo log**: rollback flags the txn aborted and MVCC hides its rows, so nothing is rewound |
| Consistency | Only the constraints you **declare in the schema**: FK, CHECK, UNIQUE, NOT NULL, triggers |
| Isolation | **MVCC snapshots** plus row locks, strictness set by the isolation level (default Read Committed) |
| Durability | This transaction's **WAL record fsync'd to disk** before COMMIT returns, replayed on crash recovery |

> [!TIP] You rarely tune A, C, or D per query - they are on by default. The one you actually pick is I, the isolation level, set per transaction with `SET TRANSACTION ISOLATION LEVEL ...`.

- **Consistency only covers rules you declared.** A business invariant that lives only in Python is one bug away from being violated, so push invariants down into the schema wherever you can.
- **Read Committed takes its snapshot per statement, not per transaction.** Run the same query twice in one transaction and you can get different results. Move up to Repeatable Read or Serializable when you need one stable snapshot for the whole transaction.
- **Durability stays cheap** because only the small WAL record is flushed, not every dirty data page the transaction touched.
- **None of it is free.** Stronger isolation and stricter durability cost throughput, which is the whole reason the eventually-consistent BASE stores loosen these guarantees to stay available and scale out.
- In practice a transaction is just `BEGIN ... COMMIT` (or `ROLLBACK`), which in Django is the `transaction.atomic` block.

## Example
```sql
BEGIN;                                              -- open one atomic unit
UPDATE account SET balance = balance - 100 WHERE id = 1;
UPDATE account SET balance = balance + 100 WHERE id = 2;
COMMIT;   -- both rows land together and both survive a crash
          -- any error before COMMIT rolls the whole thing back, so neither update sticks
```

Consistency lives in the schema, not in hoping the app behaves:

```sql
ALTER TABLE account ADD CONSTRAINT balance_nonneg CHECK (balance >= 0);
-- now a debit that would push the balance negative fails and rolls the
-- transaction back, instead of quietly leaving an invalid balance behind
```

## Interview Q&A
- **What does ACID stand for?** Atomicity, Consistency, Isolation, Durability.
- **How is atomicity actually implemented?** In Postgres, not with an undo log. Every row is tagged with the transaction that wrote it, and a commit log tracks whether that transaction committed or aborted. On rollback the transaction is marked aborted, so MVCC just stops showing its rows and there is nothing to rewind. WAL is what makes that outcome survive a crash. Oracle and InnoDB do use undo logs, so "it depends on the database" is fair to say out loud.
- **How does a committed transaction survive a crash?** Postgres flushes and fsyncs that transaction's WAL record to disk before `COMMIT` returns. After a crash it replays the WAL on startup to rebuild anything that had committed but had not been written back to the data pages.
- **What isolation level does Postgres use by default?** Read Committed. Each statement sees only data committed before that statement began, so you never read another transaction's uncommitted rows. The catch: run the same query twice in one transaction and you can get different results, because the snapshot is per statement, not per transaction.
- **ACID vs BASE?** ACID is the strong-consistency model relational databases are built around. BASE (Basically Available, Soft state, Eventually consistent) is the looser model many distributed and NoSQL systems choose so they can stay available and scale out.

| Dimension | **ACID** | **BASE** |
| --- | --- | --- |
| Consistency | **Strong**: data valid after every commit | **Eventual**: nodes converge over time |
| Under a partition | May reject writes to stay correct | **Stays available** |
| Where it lives | Relational (Postgres, MySQL) | Distributed / NoSQL (Cassandra, Riak) |
| Scale-out | Harder, vertical-leaning | **Built to scale horizontally** |

The line has blurred: DynamoDB now offers real ACID transactions within a single region.

## Gotchas
> [!WARN] ACID's "C" is not CAP's "C". ACID consistency means your data obeys its constraints. CAP consistency means every node returns the same latest value. Same word, unrelated ideas, and interviewers enjoy watching people conflate the two.

Two durability knobs sound alike but have very different blast radii:

| Knob turned off | What a crash can do | Blast radius |
| --- | --- | --- |
| `synchronous_commit = off` | Lose the **last few committed transactions** | **Data loss, never corruption**: the DB stays self-consistent |
| `fsync = off` | Dirty pages may never reach disk | **On-disk corruption**: the dangerous one, leave it on |

> [!WARN] "NoSQL means no transactions" is long out of date, but the fine print bites. DynamoDB's `TransactWriteItems` is one all-or-nothing write across up to **100 items**, but it spans only **one AWS region**, and a plain read right afterward can still come back eventually consistent unless you ask for a strongly consistent read.

## Revise next
- [Transaction isolation levels](transaction-isolation-levels.md)
- [Locking](locking-optimistic-pessimistic.md) (optimistic vs pessimistic)
- [Django transactions](../django/transactions-atomic.md) (`transaction.atomic`)

*Reviewed against PostgreSQL 18 and AWS DynamoDB docs, July 2026.*
