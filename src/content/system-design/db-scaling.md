---
title: "Scaling the Database"
group: "Design Fundamentals"
order: 2
---

# Scaling the Database

> **Category:** System Design  
> **Audience:** Backend developers with 3+ years of experience  
> **Goal:** Understand how databases are scaled in real systems, which technique solves which bottleneck, and how to choose the next scaling step.

---

# 1. What Database Scaling Means

Database scaling means increasing a database system's ability to handle growth while keeping acceptable:

- Response time
- Throughput
- Availability
- Data correctness
- Operational cost

Growth may come from more users, more requests, larger datasets, heavier queries, or higher availability requirements.

## 1.1 Scaling is not only adding servers

A slow database is not automatically an undersized database.

The real cause may be:

- Missing or ineffective indexes
- Queries reading far more rows than required
- Too many application connections
- Lock contention
- Long-running transactions
- Repeated reads of the same data
- One extremely hot table or tenant
- Analytical queries running on the transactional database
- Unevenly distributed shard keys

Adding infrastructure before identifying the cause can make the system more expensive without solving the problem.

## 1.2 The three dimensions of database growth

### Compute growth

The database needs more CPU or memory to execute queries.

```text
More requests
    ↓
More query execution
    ↓
Higher CPU and memory pressure
```

### Storage growth

Tables, indexes, WAL/binlogs, backups, and historical data keep increasing.

```text
More records
    ↓
Larger tables and indexes
    ↓
More disk usage and slower maintenance
```

### Throughput growth

The system must process more reads and writes per second.

```text
Read traffic  → cache / replicas
Write traffic → batching / partitioning / sharding
```

---

# 2. Start by Finding the Actual Bottleneck

Before selecting a scaling technique, measure the database under realistic production load.

## 2.1 Important metrics

| Area | Useful signals |
|---|---|
| Latency | Average, P95, and P99 query latency |
| Throughput | Queries or transactions per second |
| CPU | Sustained utilization and query CPU time |
| Memory | Buffer-cache hit ratio, sort/hash spills |
| Storage | Disk latency, IOPS, throughput, free space |
| Connections | Active, idle, waiting, rejected connections |
| Locks | Lock waits, deadlocks, blocked transactions |
| Replication | Replica lag, WAL/binlog generation rate |
| Queries | Slow-query count, rows scanned, rows returned |
| Cache | Hit ratio, miss ratio, eviction rate |
| Tables | Growth rate, dead tuples, fragmentation/bloat |

Averages alone are not enough. A system can have a good average latency while a small but important percentage of requests experience severe delays.

## 2.2 Typical symptoms and likely causes

| Symptom | Likely direction to investigate |
|---|---|
| High CPU | Expensive queries, missing indexes, excessive parsing |
| High disk I/O | Large scans, insufficient memory, poor access pattern |
| Too many connections | Missing pooling, oversized application pools |
| Read-heavy primary | Cache or read replicas |
| Write-heavy primary | Batch writes, redesign hot rows, shard writes |
| Large table slowing down | Better indexes, archival, partitioning |
| Long lock waits | Long transactions, hot rows, conflicting updates |
| Replica returns old data | Replication lag and read-routing policy |
| One shard overloaded | Poor shard-key distribution or hot tenant |
| Reporting affects APIs | Separate OLTP and OLAP workloads |

---

# 3. The Database Scaling Ladder

A safe database evolution usually follows this order:

```mermaid
flowchart TD
    A[Measure the bottleneck] --> B[Optimize queries and indexes]
    B --> C[Scale the database vertically]
    C --> D[Add connection pooling]
    D --> E[Cache repeated reads]
    E --> F[Add read replicas]
    F --> G[Partition very large tables]
    G --> H[Separate services or workloads]
    H --> I[Shard data across database nodes]
    I --> J[Add multi-region topology]
```

This order is not a strict rule, but it reflects an important principle:

> Use the simplest architecture that reliably meets the current requirement.

Sharding should normally come after query optimization, caching, replicas, and data lifecycle improvements because sharding introduces application and operational complexity.

---

# 4. Step 1: Improve the Existing Database

The cheapest database scaling technique is often making each query do less work.

## 4.1 Indexes

An index lets the database locate matching rows without scanning the complete table.

### Example

```sql
SELECT id, status, total_amount
FROM orders
WHERE customer_id = 501
  AND created_at >= '2026-08-01'
ORDER BY created_at DESC;
```

A useful PostgreSQL index can be:

```sql
CREATE INDEX idx_orders_customer_created_at
ON orders (customer_id, created_at DESC);
```

The column order matters because a composite index is most useful when it matches the query's filtering and ordering pattern.

### Covering index

When a frequently executed query needs only a small number of columns, included columns may allow an index-only scan.

```sql
CREATE INDEX idx_orders_customer_created_cover
ON orders (customer_id, created_at DESC)
INCLUDE (status, total_amount);
```

### Index trade-off

Indexes improve reads but add cost to:

- Inserts
- Updates
- Deletes
- Storage
- Vacuum and maintenance
- Cache memory

Do not add an index for every column. Add indexes for real access patterns and verify their use through query plans and production statistics.

## 4.2 Query optimization

Use the database execution plan instead of guessing.

```sql
EXPLAIN (ANALYZE, BUFFERS)
SELECT *
FROM orders
WHERE customer_id = 501;
```

Look for:

- Sequential scans on large tables
- Very high estimated or actual row counts
- Large differences between estimated and actual rows
- Disk-based sorts or hashes
- Repeated nested-loop execution
- Unnecessary joins
- Rows removed by filters
- High buffer reads

`EXPLAIN ANALYZE` executes the query. Be careful when using it with write statements or expensive production queries.

### Return only required data

Avoid:

```sql
SELECT *
FROM orders;
```

Prefer:

```sql
SELECT id, status, total_amount
FROM orders
WHERE customer_id = 501
ORDER BY created_at DESC
LIMIT 20;
```

### Avoid N+1 queries

Inefficient flow:

```text
1 query to load 100 orders
+
100 queries to load each customer
=
101 queries
```

Improved flow:

```sql
SELECT
    o.id,
    o.total_amount,
    c.id AS customer_id,
    c.name AS customer_name
FROM orders o
JOIN customers c ON c.id = o.customer_id
WHERE o.created_at >= CURRENT_DATE - INTERVAL '7 days';
```

Framework equivalents include `select_related` and `prefetch_related` in Django or eager-loading options in other ORMs.

## 4.3 Schema and data-access improvements

Useful improvements include:

- Use appropriate column types
- Keep frequently accessed rows reasonably small
- Store large files in object storage rather than database rows
- Archive old records that are rarely accessed
- Avoid unbounded list APIs
- Use cursor pagination for large, frequently changing datasets
- Keep transactions short
- Update only changed columns
- Avoid repeatedly calculating expensive aggregates on demand

### Cursor pagination example

```sql
SELECT id, created_at, total_amount
FROM orders
WHERE (created_at, id) < (:last_created_at, :last_id)
ORDER BY created_at DESC, id DESC
LIMIT 50;
```

Unlike a very large `OFFSET`, cursor pagination does not require the database to repeatedly walk through all earlier rows.

## 4.4 Batching and asynchronous work

Instead of sending many tiny operations:

```text
1,000 records
→ 1,000 network round trips
→ 1,000 transactions
```

Batch them:

```text
1,000 records
→ 10 batches of 100
→ 10 transactions
```

Batching reduces:

- Network overhead
- Transaction setup cost
- Commit overhead
- Repeated statement parsing

Large batches can hold locks for longer, so batch size should be tested instead of maximized blindly.

---

# 5. Step 2: Scale Vertically

Vertical scaling means increasing the capacity of a single database node.

```text
Before: 4 CPU, 16 GB RAM, standard disk
After:  16 CPU, 64 GB RAM, provisioned high-IOPS disk
```

It can improve:

- Query execution capacity
- Buffer-cache size
- Sorting and hashing
- Concurrent transactions
- Storage throughput

## Advantages

- Simple architecture
- Minimal application changes
- Strong consistency remains straightforward
- Existing transactions and joins continue to work

## Limitations

- Hardware has an upper limit
- Larger instances cost more
- Maintenance and restart impact may increase
- One writer still has finite capacity
- It does not remove a single-node failure risk by itself

Vertical scaling is usually a good early step, but it should not replace query optimization.

---

# 6. Step 3: Manage Connections

## 6.1 Why connections become a bottleneck

A database connection is not free. It consumes memory and database-process resources.

Suppose:

```text
30 application instances
× 50 connections per instance
= 1,500 possible database connections
```

Autoscaling the application can accidentally overload the database even when request traffic has not increased proportionally.

```mermaid
flowchart LR
    A1[App instance] --> DB[(Database)]
    A2[App instance] --> DB
    A3[App instance] --> DB
    A4[More autoscaled instances] --> DB
```

## 6.2 Connection pooling

A pool reuses a controlled number of database connections.

```mermaid
flowchart LR
    A1[App 1] --> P[Connection pooler]
    A2[App 2] --> P
    A3[App 3] --> P
    A4[App 4] --> P
    P -->|Controlled server connections| DB[(Database)]
```

Common layers are:

1. Application-side pool  
2. External pooler or managed proxy  
3. Database server  

For PostgreSQL, PgBouncer supports session, transaction, and statement pooling. Transaction pooling releases the server connection after each transaction, but session-dependent features require special care.

### Pool-sizing principle

Do not set every application pool to the database's full connection limit.

A practical budget is:

```text
Database safe connection budget
− administration reserve
− migration and worker reserve
− reporting reserve
= application connection budget
```

Then divide the application budget across expected application instances.

A queue of short waits at the application pool is often safer than unlimited connections overwhelming the database.

---

# 7. Step 4: Add Caching

Caching reduces repeated database reads by serving frequently requested data from a faster store such as Redis.

Good candidates include:

- Product details
- Configuration
- User profile summaries
- Permissions that change infrequently
- Computed dashboards
- Search suggestions
- Public catalog pages

Poor candidates include data that must always reflect the latest committed value unless a carefully designed consistency strategy exists.

## 7.1 Cache-aside flow

```mermaid
sequenceDiagram
    participant App
    participant Cache
    participant DB as Database

    App->>Cache: GET product:42
    alt Cache hit
        Cache-->>App: Cached product
    else Cache miss
        App->>DB: SELECT product 42
        DB-->>App: Product row
        App->>Cache: SET product:42 with TTL
        App-->>App: Return product
    end
```

Pseudo-code:

```python
def get_product(product_id: int) -> dict:
    key = f"product:{product_id}"

    cached = redis.get(key)
    if cached is not None:
        return deserialize(cached)

    product = repository.get_product(product_id)
    redis.set(key, serialize(product), ex=300)
    return product
```

## 7.2 Cache invalidation

A common write flow is:

```text
1. Update the database
2. Commit successfully
3. Delete or update the cache entry
```

```python
def update_product(product_id: int, payload: dict) -> dict:
    product = repository.update_product(product_id, payload)
    transaction.commit()

    redis.delete(f"product:{product_id}")
    return product
```

The TTL provides an additional upper bound on staleness but should not be the only invalidation mechanism for important mutable data.

## 7.3 Stampede protection

A cache stampede happens when a popular key expires and many requests query the database simultaneously.

```text
Popular key expires
        ↓
500 requests miss the cache
        ↓
500 database queries for the same value
```

Protection options include:

- Per-key distributed lock
- Request coalescing
- Stale-while-revalidate
- TTL jitter
- Refreshing hot keys before expiry

Example TTL jitter:

```python
ttl_seconds = 300 + random.randint(0, 60)
```

This prevents many related cache entries from expiring at exactly the same moment.

---

# 8. Step 5: Scale Reads with Replicas

A read replica contains a copy of the primary database and serves read-only traffic.

## 8.1 Primary-replica architecture

```mermaid
flowchart LR
    W[Write requests] --> P[(Primary)]
    P -->|Replication| R1[(Read replica 1)]
    P -->|Replication| R2[(Read replica 2)]
    Q[Read requests] --> LB[Read router]
    LB --> R1
    LB --> R2
```

Typical routing:

```text
INSERT / UPDATE / DELETE → primary
Strongly consistent read → primary
Eventually consistent read → replica
Reports and exports → dedicated replica
```

Read replicas are effective when the workload is read-heavy.

Example:

```text
Traffic:
90% reads
10% writes
```

The read workload can be spread across multiple replicas while the primary handles writes.

## 8.2 Replication lag and consistency

Many replication systems copy changes asynchronously.

```text
T0: Order is created on the primary
T1: User is redirected to order details
T2: Replica has not received the order yet
T3: Read from replica returns "not found"
```

This is a read-after-write consistency problem.

### Practical solutions

#### Read from primary after a write

For a short period after a mutation, route that user's related reads to the primary.

```text
Write order → primary
Read order immediately → primary
Later catalog/history reads → replica
```

#### Session stickiness

Store a short-lived marker:

```text
user 501 wrote at 10:30:00
route reads to primary until 10:30:05
```

#### Replication-position tracking

Record the commit position and use a replica only after it has replayed that position. This is more accurate but more complex.

#### Accept eventual consistency

For feeds, analytics, recommendations, and non-critical counters, a small delay may be acceptable.

## 8.3 Read-routing strategies

### Application routing

The application explicitly selects a primary or replica connection.

```python
def get_order(order_id: str, require_fresh: bool = False):
    db = primary_db if require_fresh else replica_db
    return db.fetch_order(order_id)
```

### Proxy routing

A database-aware proxy routes queries based on endpoint or read/write role.

### Service routing

Each service uses a policy:

```text
Payment and ledger service → primary for financial state
Catalog service → replicas and cache
Reporting service → dedicated analytical replica
```

---

# 9. High Availability Is Different from Read Scaling

Replication can support both availability and read scaling, but they are different goals.

| Goal | Meaning |
|---|---|
| High availability | A standby can take over when the writer fails |
| Read scaling | Additional nodes actively serve read traffic |
| Disaster recovery | Data can be restored after a major incident |
| Backup | Historical recovery point for accidental loss or corruption |

A synchronous standby maintained for failover may not serve application reads. A read replica may be asynchronous and may not provide automatic writer failover.

```mermaid
flowchart TD
    P[(Primary)] -->|Synchronous replication| S[(Standby for failover)]
    P -->|Asynchronous replication| R[(Read replica)]
    AppW[Writes] --> P
    AppR[Reads] --> R
```

Do not treat replicas as backups. A destructive command can also be replicated. Independent backups and tested restore procedures are still required.

---

# 10. Step 6: Partition Large Tables

Partitioning splits one logical table into smaller physical partitions, normally inside the same database system.

Example: an `events` table partitioned by month.

```text
events
├── events_2026_06
├── events_2026_07
├── events_2026_08
└── events_default
```

PostgreSQL example:

```sql
CREATE TABLE events (
    id BIGINT GENERATED ALWAYS AS IDENTITY,
    tenant_id UUID NOT NULL,
    event_type TEXT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL,
    payload JSONB NOT NULL
) PARTITION BY RANGE (created_at);

CREATE TABLE events_2026_08
PARTITION OF events
FOR VALUES FROM ('2026-08-01') TO ('2026-09-01');
```

## 10.1 Common partitioning strategies

### Range partitioning

Useful for time-series and historical data.

```text
January data → partition 1
February data → partition 2
March data → partition 3
```

Common examples:

- Audit logs
- Transactions
- Events
- Sensor readings
- Billing records

### List partitioning

Useful for a small known set of categories.

```text
India records → partition IN
USA records   → partition US
UK records    → partition UK
```

### Hash partitioning

Uses a hash of a key to distribute rows.

```text
hash(customer_id) % 4
```

This gives more even distribution but is less convenient for time-based archival.

## 10.2 Partition pruning

A query should include the partition key so the database can skip unrelated partitions.

Good:

```sql
SELECT *
FROM events
WHERE created_at >= '2026-08-01'
  AND created_at < '2026-09-01';
```

Conceptually:

```text
All partitions: 36
Relevant partitions: 1
Scanned partitions: 1
```

Without a useful partition-key condition, the database may need to examine many partitions.

## 10.3 Partitioning is not sharding

| Partitioning | Sharding |
|---|---|
| Usually one logical database cluster | Multiple independent database nodes |
| Database often handles routing | Application or middleware handles routing |
| Often improves manageability and pruning | Increases total distributed capacity |
| Transactions remain relatively simple | Cross-shard transactions are difficult |
| One node may still hold all partitions | Data is distributed across nodes |

Partitioning helps manage very large tables. It does not automatically remove the writer capacity limit of one database node.

---

# 11. Step 7: Shard the Database

Sharding distributes rows across multiple database nodes.

```mermaid
flowchart TD
    App[Application] --> Router[Shard router]
    Router --> S1[(Shard 1)]
    Router --> S2[(Shard 2)]
    Router --> S3[(Shard 3)]
    Router --> S4[(Shard 4)]
```

Example by customer:

```text
Customer 1001 → shard 1
Customer 1002 → shard 3
Customer 1003 → shard 2
```

Each shard owns only part of the complete dataset.

## 11.1 How sharding works

A routing function determines the shard:

```python
def shard_for_customer(customer_id: int, shard_count: int) -> int:
    return hash(customer_id) % shard_count
```

Request flow:

```text
API request
    ↓
Extract customer_id
    ↓
Calculate or look up shard
    ↓
Connect to that shard
    ↓
Execute query
```

## 11.2 Choosing a shard key

The shard key is one of the most important database-scaling decisions.

A strong shard key should:

- Have high cardinality
- Distribute load evenly
- Be present in common requests
- Keep related records together
- Avoid a small number of hot values
- Support future resharding
- Minimize cross-shard queries

### Candidate comparison

| Shard key | Strength | Risk |
|---|---|---|
| `customer_id` | Keeps one customer's data together | One huge customer can become hot |
| `tenant_id` | Natural for multi-tenant SaaS | Large tenants create imbalance |
| `order_id` hash | Usually distributes evenly | Customer history becomes cross-shard |
| `region` | Useful for data locality | Some regions may be much larger |
| `created_at` range | Good for archival | Newest shard receives most writes |
| Random UUID hash | Good distribution | Related data may be scattered |

### Good multi-tenant approach

For a SaaS product:

```text
Normal tenants → hash(tenant_id) across shared shards
Very large tenant → dedicated shard
```

This hybrid model prevents one enterprise tenant from dominating a shared shard.

## 11.3 Shard-routing approaches

### Algorithmic routing

```text
shard = hash(key) % number_of_shards
```

Advantages:

- Fast
- No directory lookup
- Easy to understand

Limitation:

Changing the shard count can remap a large percentage of keys.

### Consistent hashing

Keys and shards are placed on a logical ring.

```mermaid
flowchart LR
    A[Key hash] --> R[Hash ring]
    R --> S[Next shard clockwise]
```

When a node is added, fewer keys need to move compared with simple modulo hashing.

### Directory-based routing

A lookup table stores the exact shard for each tenant or entity.

```text
tenant_101 → shard_2
tenant_102 → shard_7
tenant_103 → dedicated_shard_12
```

Advantages:

- Flexible tenant movement
- Supports dedicated shards
- Easy exception handling

Trade-off:

The routing directory becomes critical infrastructure and must be highly available and cached safely.

## 11.4 Cross-shard operations

Sharding makes operations involving multiple shards harder.

### Cross-shard join

Before sharding:

```sql
SELECT *
FROM customers c
JOIN orders o ON o.customer_id = c.id;
```

After sharding, the rows may exist on different nodes. The application or a distributed query layer may need to:

1. Query multiple shards  
2. Merge results  
3. Sort or aggregate centrally  

### Global aggregate

```sql
SELECT SUM(total_amount)
FROM orders;
```

A sharded implementation may be:

```text
Shard 1 subtotal ─┐
Shard 2 subtotal ─┼→ aggregation service → global total
Shard 3 subtotal ─┘
```

For frequently needed totals, stream changes into a materialized aggregate rather than scanning every shard for each request.

### Global uniqueness

A local auto-increment value is not globally unique across shards.

Common alternatives:

- UUID
- ULID
- Snowflake-style ID
- ID containing shard bits
- Central ID-generation service

### Distributed transaction

A transaction across several shards may require:

- Two-phase commit
- Saga workflow
- Outbox pattern
- Idempotent operations
- Compensating actions

For most scalable service designs, keeping one business transaction within one shard is preferable.

## 11.5 Resharding

Resharding changes the distribution or number of shards.

Example:

```text
Before: 4 overloaded shards
After:  8 smaller shards
```

A safe online migration commonly follows:

```mermaid
flowchart TD
    A[Create destination shards] --> B[Copy historical data]
    B --> C[Replicate ongoing changes]
    C --> D[Verify row counts and checksums]
    D --> E[Switch reads]
    E --> F[Switch writes]
    F --> G[Observe and roll back if needed]
    G --> H[Retire source shards]
```

Resharding must account for data copied while live writes continue. Mature sharding systems support change capture, verification, traffic switching, and rollback.

---

# 12. Functional Partitioning and Service-Owned Databases

Not every system needs row-based sharding.

A monolithic database can sometimes be split by business capability.

```text
One shared database
├── users
├── orders
├── payments
├── inventory
└── notifications
```

Can evolve into:

```mermaid
flowchart LR
    U[User service] --> UDB[(User DB)]
    O[Order service] --> ODB[(Order DB)]
    P[Payment service] --> PDB[(Payment DB)]
    I[Inventory service] --> IDB[(Inventory DB)]
```

This is sometimes called vertical partitioning or functional partitioning.

## Benefits

- Workloads can scale independently
- Service teams own their data model
- Failures can be isolated
- Different database technologies can be used where justified

## Trade-offs

- Cross-service joins disappear
- Workflows become distributed
- Data duplication may be necessary
- Event delivery must be reliable
- Reporting needs a separate data pipeline
- Consistency becomes a business decision

Service boundaries should follow business ownership, not arbitrary table groups.

---

# 13. Scaling Writes

Reads are easier to distribute because multiple nodes can serve copies of the same data. Writes normally require coordination and conflict handling.

## 13.1 Reduce unnecessary writes

Examples:

- Do not update `updated_at` when no meaningful field changed
- Avoid writing counters on every page view
- Buffer telemetry before persistence
- Use append-only events when appropriate
- Avoid repeatedly updating one shared hot row
- Store derived values only when their read benefit justifies write complexity

### Hot counter problem

Inefficient:

```sql
UPDATE videos
SET view_count = view_count + 1
WHERE id = 42;
```

At very high traffic, one row becomes a contention point.

Alternative:

```text
View events → message stream → batch aggregator → periodic database update
```

## 13.2 Queue and batch writes

```mermaid
flowchart LR
    API[API servers] --> Q[Message queue]
    Q --> W1[Worker 1]
    Q --> W2[Worker 2]
    W1 --> DB[(Database)]
    W2 --> DB
```

Benefits:

- Absorbs traffic spikes
- Controls database write concurrency
- Enables batching
- Isolates slow downstream work

Requirements:

- Idempotent consumers
- Retry policy
- Dead-letter handling
- Durable messages
- Monitoring of queue lag
- Defined ordering guarantees

A queue increases resilience, but it also introduces asynchronous visibility. The API must communicate whether the operation is completed or merely accepted.

## 13.3 Separate transactional and analytical workloads

Transactional databases are optimized for small, frequent reads and writes.

Analytical workloads may scan millions of rows, group large datasets, and perform complex joins.

```mermaid
flowchart LR
    App[Transactional application] --> OLTP[(Primary OLTP DB)]
    OLTP --> CDC[Change data capture]
    CDC --> WH[(Data warehouse / OLAP)]
    BI[Reports and dashboards] --> WH
```

Keep large reporting queries away from the primary transactional path by using:

- Read replica
- Data warehouse
- Columnar analytical database
- Search index
- Materialized reporting store

---

# 14. Denormalization, CQRS, and Materialized Views

Normalization reduces duplication and improves transactional consistency. At scale, some read paths benefit from precomputed or duplicated data.

## Denormalized read model

Instead of joining several tables for every order-card request:

```json
{
  "order_id": "ord_101",
  "customer_name": "Aarav",
  "item_count": 3,
  "total_amount": 2499,
  "payment_status": "paid"
}
```

Store or materialize a read-optimized representation.

## CQRS

Command Query Responsibility Segregation separates:

- Command model for writes and business rules
- Query model for fast reads

```mermaid
flowchart LR
    C[Commands] --> W[(Write model)]
    W --> E[Events / CDC]
    E --> R[(Read model)]
    Q[Queries] --> R
```

The read model may be temporarily behind the write model, so the acceptable consistency delay must be explicit.

## Materialized view

A materialized view stores a query result for faster access.

```sql
CREATE MATERIALIZED VIEW daily_order_summary AS
SELECT
    DATE(created_at) AS order_date,
    COUNT(*) AS order_count,
    SUM(total_amount) AS gross_amount
FROM orders
GROUP BY DATE(created_at);
```

It must be refreshed or incrementally maintained.

Use these techniques for specific expensive read paths, not as a default replacement for a well-designed transactional schema.

---

# 15. Multi-Region Database Scaling

Multi-region architecture is normally driven by one or more of these requirements:

- Lower latency for global users
- Regional disaster recovery
- Data residency
- Regional isolation
- Global availability

## Single-writer, multi-region reads

```mermaid
flowchart LR
    U1[Users: Asia] --> RA[(Asia read replica)]
    U2[Users: Europe] --> RE[(Europe read replica)]
    W[Global writes] --> P[(Primary writer)]
    P --> RA
    P --> RE
```

Advantages:

- Simpler write consistency
- Easier conflict handling
- Local reads

Limitations:

- Distant write latency
- Replication lag
- Failover coordination

## Multi-writer topology

```mermaid
flowchart LR
    A[(Region A writer)] <--> B[(Region B writer)]
    UA[Region A users] --> A
    UB[Region B users] --> B
```

Advantages:

- Local write latency
- Better regional independence

Challenges:

- Write conflicts
- Global uniqueness
- Clock ordering
- Split-brain protection
- Cross-region transactions
- More complex failure recovery

Multi-writer architecture should be introduced only when the business requirement justifies conflict-resolution complexity.

## Region ownership

A practical alternative is assigning each tenant or user a home region.

```text
Tenant A → Mumbai region
Tenant B → Frankfurt region
Tenant C → Virginia region
```

Most writes remain local to the owner's region, while replicated global metadata supports routing.

---

# 16. SQL vs NoSQL for Scaling

NoSQL is not automatically more scalable, and SQL is not limited to one machine.

Choose based on access patterns and consistency needs.

| Requirement | Relational database | Key-value/document database |
|---|---|---|
| Multi-row transactions | Strong fit | Varies by product |
| Complex joins | Strong fit | Usually application-managed |
| Flexible access patterns | Strong with indexes and SQL | Often requires planned indexes |
| Simple key lookups at huge scale | Possible | Often a strong fit |
| Strict relational constraints | Strong fit | Usually weaker |
| Horizontal partitioning | Available but adds complexity | Often built into the product |
| Rapid schema variation | Possible with JSON support | Natural fit for documents |
| Ad hoc analytics | Better SQL experience | Often moved to an analytical system |

### Access-pattern-first design

For a distributed key-value system, the partition key determines both location and load distribution.

Bad key:

```text
status = "active"
```

Millions of records and requests may target the same key range.

Better key:

```text
customer_id
```

or a deliberately distributed composite key based on known queries.

The correct database is the one that provides the required correctness, access pattern, and operational model at acceptable cost.

---

# 17. Consistency Decisions During Scaling

Scaling creates more copies, queues, caches, and services. Each one introduces a place where data may be temporarily different.

Think in terms of business invariants.

## Strong-consistency candidates

- Deducting account balance
- Reserving limited inventory
- Preventing duplicate payment capture
- Enforcing uniqueness
- Updating a ledger
- Authorizing access

## Eventual-consistency candidates

- Product recommendation
- Search index
- Analytics dashboard
- Like count
- Activity feed
- Email notification status

## Example: placing an order

```mermaid
sequenceDiagram
    participant API
    participant DB as Order DB
    participant Outbox
    participant Broker
    participant Inventory

    API->>DB: Create order
    API->>Outbox: Store OrderCreated in same transaction
    DB-->>API: Commit
    Outbox->>Broker: Publish event
    Broker->>Inventory: Reserve inventory
```

The order and outbox record are committed together. Event publication can retry without losing the event.

Scaling is not only a throughput problem. It is also a decision about where the system requires immediate consistency and where controlled delay is acceptable.

---

# 18. Practical Architecture Evolution

## Stage 1: One application and one database

```mermaid
flowchart LR
    U[Users] --> A[Application]
    A --> DB[(Primary DB)]
```

Suitable when:

- Traffic is moderate
- Dataset fits comfortably
- Simple operations are valuable
- Team size is small

Focus on:

- Correct schema
- Indexes
- Backups
- Monitoring
- Connection pooling

## Stage 2: Cache and read replica

```mermaid
flowchart LR
    U[Users] --> A[Application]
    A --> C[(Redis cache)]
    A --> P[(Primary)]
    P --> R[(Read replica)]
```

Suitable when:

- Repeated reads dominate
- The primary is read-heavy
- Some eventual consistency is acceptable

## Stage 3: Separate workloads

```mermaid
flowchart LR
    A[Application] --> P[(Primary OLTP)]
    P --> R[(Read replicas)]
    P --> CDC[CDC]
    CDC --> W[(Warehouse)]
    BI[Reporting] --> W
```

Suitable when:

- Reports affect API performance
- Historical data is large
- Different teams need independent workloads

## Stage 4: Service-owned data

```mermaid
flowchart LR
    GW[API gateway] --> O[Order service]
    GW --> P[Payment service]
    GW --> C[Catalog service]
    O --> ODB[(Order DB)]
    P --> PDB[(Payment DB)]
    C --> CDB[(Catalog DB)]
```

Suitable when:

- Business domains scale differently
- Team ownership is clear
- Distributed workflows are understood

## Stage 5: Sharded high-scale architecture

```mermaid
flowchart TD
    U[Users] --> API[API layer]
    API --> Cache[(Distributed cache)]
    API --> Router[Shard router]
    Router --> S1[(Shard 1 primary)]
    Router --> S2[(Shard 2 primary)]
    Router --> S3[(Shard 3 primary)]
    S1 --> R1[(Shard 1 replica)]
    S2 --> R2[(Shard 2 replica)]
    S3 --> R3[(Shard 3 replica)]
    S1 --> CDC[CDC pipeline]
    S2 --> CDC
    S3 --> CDC
    CDC --> A[(Analytics store)]
```

Suitable when:

- One writer cannot handle the write workload
- Dataset exceeds one node's practical capacity
- Tenant or entity boundaries provide a good shard key
- The organization can operate distributed data safely

---

# 19. Example: Scaling an E-Commerce Database

Assume an e-commerce platform initially has:

```text
1 application
1 PostgreSQL database
5 million products
50 million orders
80% read traffic
20% write traffic
```

## Phase 1: Optimize

Actions:

- Add indexes for product, customer, status, and time-based queries
- Remove N+1 ORM queries
- Add cursor pagination
- Archive old audit events
- Shorten order transactions
- Use `EXPLAIN ANALYZE` for slow queries

Result:

```text
P95 order-list query: 900 ms → 110 ms
Database CPU: 85% → 55%
```

The numbers above are illustrative; actual results depend on workload and schema.

## Phase 2: Add caching

Cache:

- Product details
- Category navigation
- Shipping configuration
- Public promotion rules

Do not rely on stale cache for:

- Final inventory reservation
- Payment state
- Order ownership

```text
Product read
→ Redis hit: return
→ Redis miss: query PostgreSQL and populate cache
```

## Phase 3: Add read replicas

Route:

```text
Product browsing → replicas
Customer order history → replica when freshness is not required
Order confirmation immediately after checkout → primary
Admin export → dedicated replica
```

## Phase 4: Partition orders

Partition by month:

```text
orders_2026_06
orders_2026_07
orders_2026_08
```

Benefits:

- Faster date-bounded maintenance
- Easier archival
- Smaller indexes per partition
- Better pruning for date-filtered queries

## Phase 5: Separate analytics

Use CDC to move order events into an analytical store.

```text
Checkout queries → transactional database
Revenue dashboard → analytical database
```

## Phase 6: Shard when the writer becomes the limit

Shard orders by `customer_id` or `tenant_id`, depending on the business model.

Keep together:

- Customer
- Customer orders
- Customer addresses
- Customer payment references

Move global reports to the analytical store to avoid cross-shard scans.

---

# 20. Decision Guide

| Situation | Most likely next technique |
|---|---|
| One or two queries are slow | Execution-plan and index tuning |
| Database CPU is high from repeated identical reads | Caching |
| Application autoscaling exhausts DB connections | Pooling or managed proxy |
| Reads dominate writes | Read replicas |
| Immediate post-write reads are inconsistent | Primary routing or consistency token |
| Table is huge and queries are time-bounded | Table partitioning |
| Historical rows rarely used | Archive or cold storage |
| Reports slow down APIs | Separate OLAP workload |
| One shared row receives massive updates | Buffer, partition, or aggregate asynchronously |
| One writer has reached its practical limit | Sharding |
| One tenant dominates a shard | Dedicated tenant shard or rebalance |
| Global users need local reads | Cross-region replicas |
| Global users require local writes | Region ownership or carefully chosen multi-writer database |
| Services have independent ownership and load | Functional partitioning |
| Simple key access at massive scale | Distributed key-value or document database |

---

# 21. Operational Best Practices

## Make scaling measurable

Define service-level indicators such as:

```text
Order write P99 latency < 300 ms
Product read P95 latency < 100 ms
Replica lag < 2 seconds for catalog reads
Database CPU target < 70% sustained
Connection utilization < 80%
```

## Preserve headroom

Do not operate continuously at the database's maximum capacity. Leave room for:

- Traffic spikes
- Failover
- Batch jobs
- Vacuum and compaction
- Index creation
- Deployments
- Rebalancing
- Replica catch-up

## Test using realistic data volume

A query that is fast with 10,000 rows may behave differently with 500 million rows.

Load tests should reproduce:

- Real row counts
- Real data distribution
- Hot keys
- Concurrent writes
- Replica lag
- Cache misses
- Failover
- Queue backlog

## Plan migrations as online workflows

For large schema changes:

```text
Add new nullable field
→ deploy code supporting old and new schema
→ backfill in controlled batches
→ validate
→ enforce constraint
→ remove old path later
```

Avoid a single massive transaction that locks a critical table.

## Protect against retry duplication

Timeouts do not tell the client whether a database write committed.

Use:

- Idempotency keys
- Unique constraints
- Transactional outbox
- Idempotent consumers
- Safe retry policy

## Test recovery, not only backup creation

Periodically verify:

- Restore time
- Recovery-point objective
- Recovery-time objective
- Point-in-time recovery
- Failover behavior
- Application reconnection
- Data integrity after recovery

## Observe the complete request path

```text
API latency
→ connection-pool wait
→ database execution
→ lock wait
→ replica lag
→ cache latency
→ queue lag
```

Database execution time may be low while requests wait for connections or locks.

---

# 22. Key Takeaways

1. **Measure before scaling.** A bigger database does not fix poor queries, lock contention, or unlimited connections.
2. **Optimize the single node first.** Indexes, query plans, pagination, batching, and archival provide the highest value with the least complexity.
3. **Scale reads before sharding writes.** Caches and replicas handle many real-world growth stages.
4. **Treat consistency as a business requirement.** Decide which reads may be stale and which must use the primary.
5. **Do not confuse partitioning with sharding.** Partitioning divides a table; sharding distributes data across database nodes.
6. **Choose shard keys from access patterns.** Distribution, locality, and hotspot behavior matter more than convenience.
7. **Keep transactions within one shard where possible.** Cross-shard correctness is expensive.
8. **Separate OLTP and analytics.** Transactional APIs should not compete with large reporting scans.
9. **High availability, backups, and scaling are different concerns.** A complete design addresses all three.
10. **Introduce complexity gradually.** The best architecture is the simplest one that meets current scale and reliability goals.

---

# 23. Official References

The following primary documentation was used to verify the current technical concepts:

- [PostgreSQL — Using EXPLAIN](https://www.postgresql.org/docs/current/using-explain.html)
- [PostgreSQL — Indexes](https://www.postgresql.org/docs/current/indexes.html)
- [PostgreSQL — Table Partitioning](https://www.postgresql.org/docs/current/ddl-partitioning.html)
- [PostgreSQL — High Availability, Load Balancing, and Replication](https://www.postgresql.org/docs/current/high-availability.html)
- [PgBouncer — Pooling Features](https://www.pgbouncer.org/features.html)
- [Amazon RDS — Working with Read Replicas](https://docs.aws.amazon.com/AmazonRDS/latest/UserGuide/USER_ReadRepl.html)
- [Amazon RDS — RDS Proxy Concepts](https://docs.aws.amazon.com/AmazonRDS/latest/UserGuide/rds-proxy.howitworks.html)
- [Redis — Cache-Aside Pattern](https://redis.io/docs/latest/develop/use-cases/cache-aside/)
- [Amazon DynamoDB — Partition-Key Design](https://docs.aws.amazon.com/amazondynamodb/latest/developerguide/bp-partition-key-design.html)
- [Vitess — Sharding Overview](https://vitess.io/docs/faq/sharding/overview/)
- [Vitess — What Is Vitess](https://vitess.io/docs/25.0/overview/whatisvitess/)

---

> **Last reviewed:** August 3, 2026
