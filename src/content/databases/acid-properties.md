---
title: "ACID Properties"
group: "Transactions & Concurrency"
order: 4
---

# ACID Properties in Databases

> Understand how relational databases keep transactional data correct during failures and concurrent access.

## In short

- **Atomicity** — a transaction is one indivisible unit: every operation is applied, or none of them is.
- **Consistency** — a successful transaction moves the database from one valid state to another, preserving constraints and business invariants.
- **Isolation** — concurrent transactions must produce a result equivalent to some valid serial order; isolation levels trade anomalies against concurrency.
- **Durability** — once a `COMMIT` is acknowledged, the change survives a crash or restart, normally through write-ahead logging.
- `COMMIT` makes changes permanent and `ROLLBACK` cancels them; autocommit treats each standalone statement as its own transaction, so related operations need an explicit `BEGIN`.
- A database rollback cannot undo an external side effect, such as a payment already accepted by a payment API.
- Stronger guarantees cost latency, lock waits and retries, so match the guarantee to the business risk instead of choosing the strongest setting everywhere.

```mermaid
flowchart LR
    A[BEGIN] --> B[Execute SQL statements]
    B --> C{All operations valid?}
    C -- Yes --> D[COMMIT]
    C -- No --> E[ROLLBACK]
    D --> F[Changes become permanent]
    E --> G[Database returns to previous valid state]
```

**Interview answer:** ACID is the set of four properties that make database transactions reliable — atomicity (either every operation succeeds or none of them is applied), consistency (the transaction leaves the database in a valid state under every constraint and invariant), isolation (concurrent transactions do not incorrectly interfere), and durability (committed data survives crashes and restarts). Databases provide them with transaction boundaries and undo information, constraints, locks and MVCC, and a write-ahead or redo log. In practice it means putting the operations that must succeed together into one short, explicit transaction.

**Gotcha:** The `C` in ACID means preserving defined rules and invariants, not that every replica returns the same latest value — that is distributed consistency, a different idea that borrows the same word.

---

# 1. ACID at a Glance

**ACID** is a set of four properties that make database transactions reliable:

| Letter | Property | Simple Meaning |
|---|---|---|
| **A** | Atomicity | Either every operation succeeds, or none of them is applied |
| **C** | Consistency | A transaction must leave the database in a valid state |
| **I** | Isolation | Concurrent transactions should not incorrectly interfere |
| **D** | Durability | Committed data must survive crashes and restarts |

The four are not independent. Atomicity, consistency, and isolation all describe what must be true at the moment a transaction commits; durability is what makes that commit outlast the machine.

```mermaid
flowchart TB
    T[ACID transaction]
    T --> A["All or nothing<br/>Atomicity"]
    T --> C["Valid state<br/>Consistency"]
    T --> I["Safe concurrency<br/>Isolation"]
    A --> D["Commit survives failure<br/>Durability"]
    C --> D
    I --> D
```

## Why ACID Matters

ACID is important when partial, invalid, conflicting, or lost data would cause a real problem.

Common examples include:

- Transferring money between accounts
- Creating an order and reducing inventory
- Booking the last available seat
- Recording an insurance claim
- Updating payroll
- Creating an invoice and its line items
- Reserving a unique username or email address

Without reliable transactions, an application could deduct money without crediting the receiver, sell the same item twice, or report success for data that disappears after a crash.

---

# 2. Transactions: The Foundation of ACID

A **transaction** is a logical unit of database work containing one or more operations.

```sql
BEGIN;

-- One or more related SQL statements

COMMIT;
```

The transaction has two normal outcomes:

- `COMMIT` makes its changes permanent.
- `ROLLBACK` cancels its uncommitted changes.

## Autocommit

Most database clients operate in **autocommit mode** by default. In that mode, each standalone statement acts like its own transaction.

```sql
UPDATE accounts
SET balance = balance - 100
WHERE id = 1;
```

Conceptually, the database processes it like this:

```sql
BEGIN;

UPDATE accounts
SET balance = balance - 100
WHERE id = 1;

COMMIT;
```

Autocommit is convenient for independent statements, but related operations must usually be grouped inside an explicit transaction.

---

# 3. Atomicity

## 3.1 Definition

**Atomicity means that a transaction is treated as one indivisible unit.**

Either:

- All operations complete successfully, or
- All operations are rolled back

The database must not keep only half of a transaction.

## 3.2 Example: Bank Transfer

Suppose $100 must be transferred from account `1` to account `2`.

Two changes are required:

1. Deduct $100 from account `1`
2. Add $100 to account `2`

```sql
BEGIN;

UPDATE accounts
SET balance = balance - 100
WHERE id = 1;

UPDATE accounts
SET balance = balance + 100
WHERE id = 2;

COMMIT;
```

If the second `UPDATE` fails, the first change must not remain.

```text
Without atomicity:

Account 1: -$100  ✓
Account 2: +$100  ✗
Result: Money is lost
```

```text
With atomicity:

Account 1: -$100  ✓
Account 2: +$100  ✗

Transaction rolls back

Account 1: unchanged
Account 2: unchanged
```

## 3.3 Rollback on Failure

Application code should explicitly roll back a failed transaction.

```python
try:
    connection.execute("BEGIN")

    connection.execute(
        "UPDATE accounts SET balance = balance - 100 WHERE id = 1"
    )
    connection.execute(
        "UPDATE accounts SET balance = balance + 100 WHERE id = 2"
    )

    connection.commit()
except Exception:
    connection.rollback()
    raise
```

Most frameworks provide transaction helpers that perform this pattern automatically.

## 3.4 Savepoints

A **savepoint** creates a rollback point inside a transaction.

```sql
BEGIN;

INSERT INTO orders (customer_id, status)
VALUES (10, 'PENDING');

SAVEPOINT order_created;

INSERT INTO order_items (order_id, product_id, quantity)
VALUES (501, 20, 2);

-- Undo only the work after the savepoint
ROLLBACK TO SAVEPOINT order_created;

COMMIT;
```

A savepoint does not commit data. It only allows part of the current transaction to be undone.

## 3.5 What Supports Atomicity

Databases commonly use:

- Transaction boundaries
- Undo information
- Rollback mechanisms
- Write-ahead or redo logging
- Crash-recovery procedures

---

# 4. Consistency

## 4.1 Definition

**Consistency means that a successful transaction moves the database from one valid state to another valid state.**

A valid state follows all required rules, including:

- Primary-key uniqueness
- Foreign-key relationships
- `NOT NULL` rules
- `CHECK` constraints
- Unique constraints
- Data types
- Business invariants

## 4.2 Example: Preventing Negative Balances

```sql
CREATE TABLE accounts (
    id BIGINT PRIMARY KEY,
    owner_name VARCHAR(100) NOT NULL,
    balance DECIMAL(12, 2) NOT NULL,
    CONSTRAINT balance_must_be_non_negative
        CHECK (balance >= 0)
);
```

This transaction violates the constraint:

```sql
UPDATE accounts
SET balance = -50
WHERE id = 1;
```

The database rejects the operation, so the table remains valid.

## 4.3 Example: Referential Integrity

```sql
CREATE TABLE customers (
    id BIGINT PRIMARY KEY,
    name VARCHAR(100) NOT NULL
);

CREATE TABLE orders (
    id BIGINT PRIMARY KEY,
    customer_id BIGINT NOT NULL,
    status VARCHAR(20) NOT NULL,
    CONSTRAINT fk_orders_customer
        FOREIGN KEY (customer_id)
        REFERENCES customers(id)
);
```

An order cannot reference a customer that does not exist.

## 4.4 Database Consistency vs Application Consistency

Not every business rule can be represented with a simple database constraint.

Consider this rule:

> A confirmed order is valid only when payment succeeds and sufficient stock is reserved.

Part of this rule may be enforced through SQL constraints, but the complete rule may require application logic.

```text
Application responsibilities
    ├── Validate workflow rules
    ├── Determine permitted state transitions
    └── Place related changes in one transaction

Database responsibilities
    ├── Enforce schema constraints
    ├── Maintain relationships
    ├── Control concurrency
    └── Reject invalid writes
```

The database and the application work together to preserve consistency.

## 4.5 Consistency Is Not the Same as “All Replicas Are Immediately Equal”

In ACID, **consistency** refers to preserving defined rules and invariants.

In distributed systems, the word **consistency** is also used to describe whether different replicas return the same latest value. That is related to distributed consistency models and should not be confused with the `C` in ACID.

---

# 5. Isolation

## 5.1 Definition

**Isolation controls how concurrent transactions see and affect one another.** It is the `I` in ACID: concurrent transactions must not corrupt each other.

The ideal behavior is that concurrently executed transactions produce a result equivalent to some valid serial order.

```text
Concurrent execution:

Transaction A ────────┐
                      ├── Database
Transaction B ────────┘

Isolation should make the result behave as though:

A completed before B
        or
B completed before A
```

Complete serial execution is safe but can reduce concurrency. Databases therefore provide multiple isolation levels.

## 5.2 Anomalies and Isolation Levels

The four concurrency anomalies — dirty read, non-repeatable read, phantom read, and lost update — the four standard isolation levels (`READ UNCOMMITTED`, `READ COMMITTED`, `REPEATABLE READ`, `SERIALIZABLE`), the syntax for setting a level, and the trade-offs behind choosing one are covered in full in [Transaction Isolation Levels](transaction-isolation-levels.md).

That note is the canonical owner of this material and keeps all of it, so nothing is lost by not repeating it here.

## 5.3 Locking and Optimistic Concurrency

When a transaction reads a row and then makes a decision based on it, the row has to be protected from a competing writer.

`SELECT ... FOR UPDATE` locking reads, the version-column pattern for optimistic concurrency control, and when to pick each are covered in [Optimistic vs Pessimistic Locking](locking-optimistic-pessimistic.md).

---

# 6. Durability

## 6.1 Definition

**Durability means that after a transaction commits successfully, its result must survive a database restart or system failure.**

```mermaid
flowchart TD
    T[Transaction] --> C[COMMIT acknowledged]
    C --> X[Server crashes]
    X --> R[Committed change is recovered]
```

## 6.2 Write-Ahead Logging

Many relational databases use **write-ahead logging (WAL)** or a **redo log**.

The basic idea is:

1. Record the intended change in a durable log
2. Flush the required log data to stable storage
3. Acknowledge the commit
4. Write modified data pages later
5. Use the log during recovery if a crash occurs

```mermaid
flowchart LR
    A[Transaction changes data] --> B[Create WAL or redo records]
    B --> C[Flush required log records]
    C --> D[Return COMMIT success]
    D --> E[Write data pages later]
    C --> F[Crash recovery can replay log]
```

This avoids forcing every modified table page to disk before each commit.

## 6.3 Durability Is Affected by Configuration

Durability is not only a SQL concept. It also depends on:

- Database flush settings
- Operating-system write behavior
- Storage-device caches
- Filesystem behavior
- Hardware reliability
- Cloud storage guarantees
- Replication configuration
- Backup and recovery strategy

Some database settings allow weaker disk-flush guarantees for higher throughput. Such settings may increase the amount of committed data that can be lost during a severe failure.

## 6.4 Durability Is Not the Same as Backup

A committed transaction may be durable against a process or server crash, but durability alone does not protect against:

- Accidental deletion
- Incorrect application logic
- Malicious data changes
- Database corruption beyond recovery capability
- Loss of the entire storage system
- Regional disasters

Backups, point-in-time recovery, and replication provide additional protection.

---

# 7. Complete ACID Example: Money Transfer

## 7.1 Schema

```sql
CREATE TABLE accounts (
    id BIGINT PRIMARY KEY,
    owner_name VARCHAR(100) NOT NULL,
    balance DECIMAL(12, 2) NOT NULL
        CHECK (balance >= 0)
);

CREATE TABLE account_transactions (
    id BIGINT PRIMARY KEY,
    account_id BIGINT NOT NULL,
    amount DECIMAL(12, 2) NOT NULL,
    transaction_type VARCHAR(10) NOT NULL
        CHECK (transaction_type IN ('DEBIT', 'CREDIT')),
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (account_id) REFERENCES accounts(id)
);
```

## 7.2 Transfer Transaction

```sql
BEGIN;

-- Lock both account rows in a predictable order
SELECT id, balance
FROM accounts
WHERE id IN (1, 2)
ORDER BY id
FOR UPDATE;

-- Debit sender only when sufficient balance exists
UPDATE accounts
SET balance = balance - 100
WHERE id = 1
  AND balance >= 100;

-- Application verifies that exactly one row was updated

UPDATE accounts
SET balance = balance + 100
WHERE id = 2;

INSERT INTO account_transactions (
    id,
    account_id,
    amount,
    transaction_type
)
VALUES
    (1001, 1, 100, 'DEBIT'),
    (1002, 2, 100, 'CREDIT');

COMMIT;
```

## 7.3 How ACID Applies

| Property | Role in the Transfer |
|---|---|
| Atomicity | Debit, credit, and history records all succeed or all roll back |
| Consistency | Balances remain valid and transaction rows reference real accounts |
| Isolation | Concurrent transfers cannot incorrectly use or overwrite the same balance |
| Durability | After commit, the transfer survives a database crash |

## 7.4 Transaction Boundary Diagram

```mermaid
flowchart TD
    B[BEGIN] --> L[Lock account rows]
    L --> C[Check sender balance]
    C --> D[Debit sender]
    D --> CR[Credit receiver]
    CR --> A[Insert audit records]
    A --> F{Any failure?}
    F -->|Yes| RB[ROLLBACK]
    F -->|No| CM[COMMIT]
    CM --> P[Transfer is permanent]
```

---

# 8. How Databases Implement ACID

ACID is usually implemented through several mechanisms working together.

## 8.1 Transaction Manager

Tracks transaction state:

- Active
- Committed
- Aborted
- Waiting
- Conflicted

## 8.2 Undo Information

Allows uncommitted changes to be reversed or hidden.

Used for:

- Rollback
- Crash recovery
- Snapshot visibility in MVCC systems

## 8.3 WAL or Redo Log

Stores enough information to recover committed changes after a crash.

## 8.4 Locks

Protect resources from incompatible concurrent operations.

Common lock scopes include:

- Row
- Page
- Table
- Key or key range
- Advisory application-defined resource

## 8.5 Multi-Version Concurrency Control

**MVCC** keeps multiple logical row versions so readers and writers can work concurrently with less blocking.

Simplified view:

```text
Row versions:

Version 1: balance = 500   visible to older snapshot
Version 2: balance = 400   visible after newer commit
```

A transaction sees row versions according to its snapshot and isolation rules.

## 8.6 Constraints

Constraints reject writes that would create an invalid database state.

```text
PRIMARY KEY  → Entity must be uniquely identifiable
FOREIGN KEY  → Referenced entity must exist
UNIQUE       → Duplicate value is not allowed
NOT NULL     → Required value cannot be missing
CHECK        → Value must satisfy a condition
```

---

# 9. ACID in Real Application Architecture

## 9.1 Keep One Database Transaction Focused

A transaction should normally contain database operations that form one business unit.

```text
Good transaction scope:

Create order
    ├── Insert order
    ├── Insert order items
    ├── Reserve inventory
    └── Commit
```

Long transactions hold locks and old row versions for longer, increasing contention and cleanup work.

## 9.2 External APIs Are Not Automatically Part of the Transaction

This flow is unsafe:

```text
BEGIN database transaction
    ├── Update order
    ├── Call payment API
    ├── Call email API
    └── COMMIT
```

A normal database rollback cannot undo a payment already accepted by an external service.

## 9.3 Outbox and Idempotency

A database commit and an external side effect are not one atomic unit, and a retried request must not charge twice. The **transactional outbox** pattern answers the first problem: the event row is stored in the same database transaction as the business change, and a separate process publishes pending outbox events afterwards. An **idempotency key** answers the second: a unique key makes repeated requests resolve to one recorded operation.

Idempotency keys, safe retries, and which HTTP methods are idempotent are covered in [HTTP Idempotency and Methods](../api-design/idempotency-http-methods.md).

## 9.4 Distributed Transactions

A local ACID transaction protects one transactional database boundary. It does not automatically make a workflow across multiple databases and services atomic.

Common approaches include:

- Two-phase commit for tightly coordinated systems
- Saga pattern for multi-service workflows
- Transactional outbox for reliable event publication
- Idempotent consumers
- Compensating actions
- Retry with backoff

The correct choice depends on latency, failure handling, operational complexity, and consistency requirements.

---

# 10. Performance and Reliability Trade-offs

Stronger transactional guarantees can require more work.

| Mechanism | Reliability Benefit | Possible Cost |
|---|---|---|
| Higher isolation | Fewer concurrency anomalies | More waiting, conflicts, or retries |
| Synchronous log flush | Stronger commit durability | Higher commit latency |
| More indexes and constraints | Better integrity and validation | Slower writes |
| Row locks | Correct read-modify-write workflows | Lock waits and deadlocks |
| Replication acknowledgement | Better failure protection | Additional network latency |
| Long transactions | One large atomic unit | More contention and retained versions |

The goal is not to choose the strongest setting everywhere. The goal is to choose guarantees that match the business risk.

Example:

```text
Bank transfer
    → Strong consistency and durability are essential

Analytics event counter
    → Small delays or retry-based correction may be acceptable
```

---

# 11. Practical Development Guidelines

## 11.1 Define the Business Unit Before Writing SQL

Identify which operations must succeed together.

```text
Order placement unit:

1. Create order
2. Add order items
3. Reserve inventory
4. Record payment state
```

Operations in that unit should be placed in an appropriate transaction or coordinated workflow.

## 11.2 Put Critical Invariants in the Database

Use constraints for rules that must always hold.

```sql
ALTER TABLE users
ADD CONSTRAINT users_email_unique UNIQUE (email);
```

Application validation improves user experience, while database constraints protect integrity under concurrency and from every database client.

## 11.3 Prefer Atomic SQL Updates

Instead of:

```text
Read stock
Calculate stock - 1
Write new stock
```

Use:

```sql
UPDATE inventory
SET stock = stock - 1
WHERE product_id = 100
  AND stock > 0;
```

Then verify the affected-row count.

## 11.4 Keep Transactions Short

Inside a transaction:

- Perform required database work
- Avoid user interaction
- Avoid slow network calls where possible
- Access locked resources in a consistent order
- Commit or roll back promptly

## 11.5 Handle Retryable Failures

Serializable transactions and deadlock detection can abort one transaction to preserve correctness.

Application logic should be able to retry appropriate failures:

```mermaid
flowchart TD
    A[Attempt transaction] --> O{Outcome?}
    O -->|Success| R[Return result]
    O -->|Retryable conflict| B[Back off briefly]
    B --> RT[Retry entire transaction]
    RT --> A
```

The entire transaction must be retried because its earlier reads may no longer be valid.

## 11.6 Use Connection Pools Carefully

A pooled connection may retain session state, depending on the driver and pool configuration.

Ensure that:

- Failed transactions are rolled back
- Connections are returned in a clean state
- Isolation level changes are scoped correctly
- Transaction boundaries are explicit

## 11.7 Test Concurrency, Not Only Single Requests

Concurrency problems may not appear in normal unit tests.

Useful tests include:

- Two users purchasing the last item
- Multiple withdrawals from the same account
- Duplicate requests with the same idempotency key
- Serialization failure retry
- Deadlock handling
- Process crash around commit
- Outbox publisher restart

---

# 12. Official References

The explanations in this guide were checked against current official database documentation in July 2026.

- PostgreSQL 18 — Concurrency Control:  
  <https://www.postgresql.org/docs/current/mvcc.html>

- PostgreSQL 18 — Transaction Isolation:  
  <https://www.postgresql.org/docs/current/transaction-iso.html>

- PostgreSQL 18 — `START TRANSACTION`:  
  <https://www.postgresql.org/docs/current/sql-start-transaction.html>

- MySQL Reference Manual — InnoDB and the ACID Model:  
  <https://dev.mysql.com/doc/refman/en/mysql-acid.html>

- SQLite — Transactional Behavior:  
  <https://www.sqlite.org/transactional.html>

---

> **Core takeaway:** ACID is not only about using `BEGIN` and `COMMIT`. Reliable transactional design also requires correct constraints, suitable isolation, safe concurrency handling, durable storage configuration, clear transaction boundaries, and retry-aware application logic.
