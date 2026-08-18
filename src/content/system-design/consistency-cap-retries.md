---
title: "Consistency & CAP"
group: "Design Fundamentals"
order: 1
updated: "3 August 2026"
---

# Consistency, CAP, and Why Retries Need Idempotency

> Why a distributed read can return stale data, what CAP and PACELC really constrain, and why every retry policy needs idempotency behind it.

## In short

- Consistency is not "no corrupt rows" — it is the rule for **what a client may observe after a completed write**: linearizable, sequential, causal, or eventual.
- CAP only bites **during a partition**: while replicas cannot talk, an operation is either CP (reject or delay to stay correct) or AP (accept and reconcile later). It is never "pick any two".
- PACELC covers the other 99% of the time: **e**lse, with no partition, you still trade **l**atency against **c**onsistency on every replicated read and write.
- Choose the model **per operation**, not per product — one service can serve balances strongly and profile pages eventually.
- Session guarantees (read-your-writes, monotonic reads) buy a coherent user experience without paying for global linearizability.
- A timeout means **the caller stopped waiting**, not that the server rolled back — the write may have committed with only the response lost.
- That ambiguity forces retries, and retries duplicate side effects, so backoff with jitter, a total deadline, and a stable operation key are one design rather than four.

```mermaid
flowchart TD
    DATA[Distributed data] --> REPL[Replication creates consistency trade-offs]
    REPL --> NET[Network failures make request outcomes uncertain]
    NET --> RETRY[Clients retry uncertain operations]
    RETRY --> SIDE[Retries can repeat side effects]
    SIDE --> IDEM[Idempotency prevents duplicate business effects]
```

**Interview answer:** Pick the consistency model per business invariant — anything guarding money, stock, or uniqueness needs linearizable reads and writes, and everything derived from it (feeds, counters, search indexes, notifications) can be eventual. CAP then tells you what that choice costs during a partition, and PACELC what it costs the rest of the time. Because any remote call can time out with the outcome unknown, every write on the critical path must also carry a stable operation key, so that a retry converges on one effect instead of two.

**Gotcha:** Treating CAP as a one-time architectural label ("we are an AP system"). Partitions are rare and the choice is per-operation: the same service normally refuses a double-spend (CP) while still serving a stale product page (AP). Reciting "consistency, availability, partition tolerance — pick two", as though partition tolerance were something you could decline, is the answer interviewers are listening for.

---

# 1. The Core Idea

Those three topics form one chain. Replication buys availability and latency but forces a consistency trade-off; network failure makes the outcome of any single request uncertain; clients therefore retry; and a retry repeats the side effect unless the operation is idempotent.

A distributed system cannot assume that:

- every replica has the latest value;
- every network request reaches its destination;
- every response reaches the caller;
- a timeout means the operation failed;
- a message is delivered only once.

A reliable design therefore needs two separate decisions:

1. **What consistency guarantee does each business operation require?**
2. **How can the operation be retried without creating duplicate effects?**

Consistency protects the correctness of shared state.  
Idempotency protects the correctness of repeated requests.

---

# 2. What Consistency Means

## 2.1 Consistency in a replicated system

Suppose a user changes an address and the system stores the data in two replicas.

```mermaid
sequenceDiagram
    participant C as Client
    participant A as Replica A
    participant B as Replica B

    C->>A: Update address to "Pune"
    A-->>C: Success
    A-->>B: Replicate update later
    C->>B: Read address
    B-->>C: Returns old address
```

The write succeeded on Replica A, but Replica B had not received it yet. The next read returned stale data.

Consistency defines **what values clients are allowed to observe when multiple copies of data or concurrent operations exist**.

It does not simply mean that the database has no corrupt rows. In system design, the important question is:

> After a successful write, what may another client or replica return?

---

## 2.2 Common consistency models

### Strong or linearizable consistency

A completed write appears to take effect at one instant, and later operations observe it.

```text
Write X = 20 completes
          │
          └── Any later read must not return the previous value
```

Linearizability respects real-time ordering. It is useful when stale data could violate a business invariant.

Typical use cases:

- account balance checks;
- inventory reservation;
- uniqueness decisions;
- lock ownership;
- leader election metadata;
- payment or ledger state.

The cost is usually greater coordination, latency, or reduced availability during failures.

---

### Sequential consistency

All clients observe operations in one valid global order, but that order does not have to match real-time order.

It is weaker than linearizability because a client may not immediately observe an operation that already completed in real time.

---

### Causal consistency

Operations that are causally related are observed in the correct order.

Example:

```text
1. User creates a post
2. Another user replies to that post
```

A system should not show the reply before the original post. Independent operations may be observed in different orders.

This model is useful in collaboration, social feeds, comments, and globally distributed applications.

---

### Eventual consistency

If no new writes occur, all replicas eventually converge to the same value.

An immediate read may be stale:

```text
T0: Write product price = ₹1,999 in Region A
T1: Read in Region B returns ₹2,099
T2: Replication completes
T3: Read in Region B returns ₹1,999
```

Eventual consistency provides convergence, not immediate freshness.

Typical use cases:

- product catalog;
- analytics;
- activity feeds;
- view counters;
- search indexes;
- cached profile information.

The application may still need conflict resolution, versioning, timestamps, CRDTs, or domain-specific merge rules.

---

### Session guarantees

Many applications do not need global linearizability but need a predictable user experience.

Common session guarantees include:

| Guarantee | Meaning |
|---|---|
| Read-your-writes | A user sees their own completed changes |
| Monotonic reads | A user does not move backward to an older version |
| Monotonic writes | A user's writes are applied in order |
| Writes-follow-reads | A write is based on a version the user has already observed |

For example, a globally replicated profile service may be eventually consistent across users while guaranteeing that the user who edited the profile immediately sees the new value.

---

## 2.3 Consistency vs transaction isolation

These terms are related but not interchangeable.

### Replication consistency

Asks:

> What can different clients or replicas observe?

Examples: linearizable, causal, eventual.

### Transaction isolation

Asks:

> How do concurrent transactions interact?

Examples: read committed, repeatable read, snapshot isolation, serializable.

### Important distinction

- **Linearizability** commonly describes real-time behavior of individual operations.
- **Serializability** ensures concurrent transactions behave like some serial execution.
- **Strict serializability** combines serializable transactions with real-time ordering.

A system can have serializable transactions inside one database region while replicas in another region remain eventually consistent.

---

# 3. The CAP Theorem

## 3.1 The three CAP properties

CAP refers to:

### Consistency

In the CAP model, consistency is close to **single-copy atomic or linearizable behavior**.

Every read behaves as though the system contains one up-to-date copy of the data.

This is not the `C` in ACID. ACID consistency refers to preserving database rules and invariants.

---

### Availability

Every request sent to a non-failing node eventually receives a valid response.

Availability in CAP is stronger and more formal than saying:

- the monthly uptime is 99.99%;
- the service returned an HTTP response;
- the load balancer is healthy.

Returning an error such as “cannot process because the other region is unavailable” does not preserve CAP availability for that operation.

---

### Partition tolerance

The system continues to follow its defined behavior even when nodes cannot communicate reliably.

A partition can involve:

- dropped messages;
- extreme delay;
- broken network links;
- a region becoming unreachable;
- firewall or routing problems;
- partial connectivity between nodes.

```mermaid
flowchart LR
    C1[Clients in Region A] --> A[Replica A]
    C2[Clients in Region B] --> B[Replica B]
    A <-. Network partition .-> B
```

---

## 3.2 What CAP actually says

During a network partition, a replicated system cannot guarantee both:

- linearizable consistency; and
- availability for every request.

The system must choose what a particular operation does while communication is unavailable.

```mermaid
flowchart TD
    PART[Network partition] --> CONS[Preserve consistency]
    PART --> AVAIL[Preserve availability]
    CONS --> REJECT["Reject, delay, or time out<br/>some operations"]
    AVAIL --> ACCEPT[Accept requests on both sides<br/>and reconcile later]
    REJECT --> CP[CP behavior]
    ACCEPT --> AP[AP behavior]
```

### The most important interpretation

CAP does **not** mean:

> “Choose any two of consistency, availability, and partition tolerance.”

In a real distributed system, partitions are possible. Partition tolerance is therefore part of the operating environment, not a feature that can always be disabled.

The practical choice during a partition is normally:

> **For this operation, should the system reject or delay work to preserve consistency, or accept work and risk temporary inconsistency?**

---

## 3.3 CP, AP, and CA

### CP: Consistency + partition tolerance

During a partition, the system may reject, delay, or make some operations unavailable rather than return stale or conflicting data.

Example:

```text
Two regions cannot communicate.

Request: Reserve the last available hotel room.

CP behavior:
- Only the quorum/leader side accepts the reservation.
- The other side rejects or waits.
- Double booking is prevented.
```

Suitable for operations where conflicting success is unacceptable:

- ledger posting;
- unique username allocation;
- inventory reservation for scarce stock;
- distributed locks;
- configuration control;
- payment state transitions.

CP does not mean the entire product is always unavailable. Only the operations that cannot safely proceed may be affected.

---

### AP: Availability + partition tolerance

Both sides continue serving requests during the partition and reconcile after communication returns.

Example:

```text
Two regions cannot communicate.

Request: Add an item to a shopping cart.

AP behavior:
- Both regions accept updates.
- Cart versions are merged later.
```

Suitable when temporary inconsistency is acceptable and conflicts can be merged or corrected:

- shopping carts;
- likes and counters;
- feeds;
- telemetry;
- some catalog data;
- offline-first applications.

AP does not mean “no consistency.” An AP design may still provide causal consistency, read-your-writes, version checks, conflict-free data types, or deterministic merge rules.

---

### CA: Consistency + availability without partition handling

A single-node database can provide consistent and available behavior while it is healthy because there is no inter-node partition to handle.

A distributed system can also behave like CA when the network is healthy. CAP becomes relevant when communication is partitioned.

Therefore, labeling a real multi-node system as permanently “CA” is usually incomplete.

---

## 3.4 CAP is an operation-level trade-off

A complete platform is rarely purely CP or purely AP.

An e-commerce system may choose:

| Operation | Preferred behavior |
|---|---|
| Browse product descriptions | AP / eventually consistent |
| Display approximate stock | Eventual or bounded-staleness |
| Reserve final stock unit | CP / strongly consistent |
| Add item to cart | AP with merge |
| Capture payment | Strongly controlled and idempotent |
| Analytics ingestion | AP / asynchronous |
| Ledger posting | CP-like invariant protection |

The choice may also differ between reads and writes.

A database can offer:

- eventual reads by default;
- strongly consistent reads on demand;
- conditional writes for critical updates;
- transactions for a small set of records.

For example, current DynamoDB documentation describes eventual and strongly consistent read options for tables and local secondary indexes. Its multi-Region global tables support eventual and strong consistency modes, with different replication behavior and operational trade-offs.

---

## 3.5 Beyond CAP: PACELC

CAP focuses on behavior **during a partition**.

PACELC adds the normal case:

```text
If Partition:
    choose Availability or Consistency
Else:
    choose Latency or Consistency
```

Even without a partition, strong consistency often requires coordination between replicas. Waiting for that coordination increases latency.

For a globally distributed service:

```mermaid
flowchart LR
    subgraph STRONG[Strong consistency]
        C1[Client] --> REG1[Local region]
        REG1 -->|Coordination cost| QUORUM[Remote quorum]
        QUORUM --> RESP1[Response]
    end

    subgraph FAST[Lower-latency consistency]
        C2[Client] --> REG2[Local region]
        REG2 --> RESP2[Response]
        REG2 --> ASYNC[Replicate asynchronously]
    end
```

PACELC is useful because most system-design decisions happen while the network is slow but not fully partitioned.

---

# 4. Choosing Consistency for Real Features

Start with the business invariant, not the database label.

### Decision framework

Ask:

1. What incorrect outcome can stale or conflicting data produce?
2. Can that outcome be repaired later?
3. Is the conflict visible only in the UI, or does it move money or allocate a scarce resource?
4. Can the operation be expressed as a conditional write?
5. How much extra latency is acceptable?
6. What should happen when the coordinating nodes are unavailable?

### Practical selection guide

| Requirement | Reasonable approach |
|---|---|
| Must never overspend an account | Strong consistency, transaction, or conditional update |
| Must not sell the same unique seat twice | Leader/quorum plus atomic reservation |
| User must immediately see own profile edit | Read-your-writes session guarantee |
| Search may lag the source database | Eventual consistency |
| Like count may be approximate briefly | Eventual consistency or CRDT counter |
| Two offline users edit the same document | Causal/versioned merge or conflict resolution |
| Reporting can be several minutes behind | Asynchronous replicas or warehouse pipeline |

### Example: safe stock decrement

Avoid:

```sql
SELECT available_quantity FROM inventory WHERE sku = 'SKU-10';
-- Application sees 1.

UPDATE inventory
SET available_quantity = 0
WHERE sku = 'SKU-10';
```

Two concurrent requests can both read `1` and both succeed.

Prefer an atomic conditional update:

```sql
UPDATE inventory
SET available_quantity = available_quantity - 1
WHERE sku = 'SKU-10'
  AND available_quantity > 0
RETURNING available_quantity;
```

The affected-row count becomes part of the business decision. Database constraints and atomic conditions are more reliable than an application-level “check then update.”

---

# 5. Why Distributed Operations Need Retries

Remote calls fail for temporary reasons:

- connection reset;
- packet loss;
- service restart;
- load-balancer timeout;
- database leader election;
- rate limiting;
- temporary overload;
- DNS or routing issue;
- response lost after successful processing.

Retries improve availability by giving a transient failure another chance.

The difficult part is that a caller often cannot tell whether the first attempt changed state.

---

## 5.1 The ambiguous timeout problem

Consider a payment request:

```mermaid
sequenceDiagram
    participant C as Checkout Service
    participant P as Payment Service
    participant D as Payment DB

    C->>P: POST /payments
    P->>D: Insert successful payment
    D-->>P: Commit successful
    P--xC: Response lost / timeout
    Note over C: Outcome is unknown
```

From the checkout service's perspective, several outcomes look identical:

```text
Observed by caller: timeout

Possible server reality:
A. Request never reached the server
B. Request reached the server but failed before mutation
C. Mutation committed, but response was lost
D. Server is still processing the operation
```

A timeout means **the caller stopped waiting**. It does not prove that the server rolled back or never processed the request.

---

## 5.2 How retries create duplicate effects

Without idempotency:

```mermaid
sequenceDiagram
    participant C as Client
    participant API as Payment API
    participant DB as Database

    C->>API: Create payment ₹5,000
    API->>DB: Insert payment P-101
    DB-->>API: Committed
    API--xC: Response lost

    C->>API: Retry create payment ₹5,000
    API->>DB: Insert payment P-102
    DB-->>API: Committed
    API-->>C: Success

    Note over DB: Customer may be charged twice
```

The retry is technically a second valid `POST`. The server cannot know whether it represents:

- a retry of the same intent; or
- a new intent with identical data.

Comparing request bodies is not enough. A customer may intentionally make two identical ₹5,000 payments.

The client must provide an identifier that expresses business intent.

---

# 6. Idempotency: What Retries Actually Require

An operation is idempotent when repeating the same *intended* operation produces the same business effect as performing it once. "Set the address to Pune", "cancel order `ORD-100`", and "create one payment for checkout attempt `CHK-9001`" already behave that way. "Increment the balance by ₹100", "create a new order", "send an email", and "capture a card payment" do not, and are made idempotent by attaching a stable operation identity and remembering its result.

[Idempotency: Which HTTP Methods Are Idempotent?](../api-design/idempotency-http-methods.md) owns this topic in full — the method matrix, the `Idempotency-Key` contract, the request fingerprint and `409` rule, the `idempotency_records` schema, concurrent-duplicate handling, retention, and the consumer inbox table. The short version, which is what a distributed-systems answer needs:

| Requirement | Why the distributed case needs it |
|---|---|
| A client-generated key per logical intent | A retry must reuse it; a genuinely new intent must not. Two identical payments of the same amount are legitimate, so the request body cannot identify the intent. |
| Key scoped as `tenant + operation + key` | Stops unrelated endpoints and tenants colliding inside one shared store. |
| A stored request fingerprint | The same key with a different payload is a client bug: answer `409 Conflict`, never replay the old result. |
| Claim and mutation in one transaction | A uniqueness constraint is the only reliable concurrency guard. A cache can be evicted, instances restart, and two of them can race. |
| An explicit `unknown` outcome | When a provider call times out, "unknown" is correct and "failed" is dangerous — recording failure invites a second charge. |
| The same key passed downstream | Retry the provider with the *original* key. Minting a fresh key because the last attempt timed out is exactly how double charges happen. |
| Retention longer than the real retry window | Hours for order creation, days for payments, provider-defined for webhook redelivery. |

Idempotency is not exactly-once execution. The handler may genuinely run more than once; what you build is at-least-once delivery plus durable deduplication plus atomic state protection, and together those give **effectively-once** business outcomes. Across an arbitrary network, a database, a queue, and an external provider, "exactly once" is never a transport guarantee — it is assembled from unique operation identifiers, durable deduplication records, transactions, uniqueness constraints, idempotent side effects, and reconciliation.

The `unknown` state deserves its own transition rather than being collapsed into failure:

```mermaid
flowchart TD
    CREATED[created] --> PROCESSING[processing]
    PROCESSING --> SUCCEEDED[succeeded]
    PROCESSING --> FAILED[failed_final]
    PROCESSING --> UNKNOWN[unknown]
    UNKNOWN --> RECONCILING[reconciling]
    RECONCILING --> SUCCEEDED
    RECONCILING --> FAILED
```

Two dual-write patterns pair with the same reasoning. An **inbox** table keyed on `consumer_name + event_id` makes an at-least-once consumer safe, with the insert and the business mutation in one transaction. A **transactional outbox** writes the domain row and the event row in one transaction and publishes later, so a committed state change can never become invisible downstream — but because publishing is retried, consumers still deduplicate on the event ID.

---

# 7. Safe Retry Policy

Idempotency prevents duplicate effects, but retry behavior must still be controlled.

## Retry only failures that may be transient

Often retryable:

- connection timeout;
- connection reset;
- temporary DNS failure;
- `408 Request Timeout`;
- `429 Too Many Requests`;
- `502 Bad Gateway`;
- `503 Service Unavailable`;
- `504 Gateway Timeout`;
- database deadlock or leader failover, when documented as retryable.

Usually not retryable without changing the request:

- validation errors;
- authentication or authorization errors;
- malformed payloads;
- insufficient balance;
- business-rule rejection;
- idempotency key reused with different parameters.

Status code alone is not always enough. Follow the downstream service's documented retry contract.

---

## Use exponential backoff with jitter

Without delay:

```text
Attempt 1 fails
Thousands of clients retry immediately
Dependency becomes more overloaded
More requests fail
```

This is a retry storm.

A common capped full-jitter calculation is:

```python
import random

def retry_delay(attempt: int, base: float = 0.2, cap: float = 10.0) -> float:
    maximum = min(cap, base * (2 ** attempt))
    return random.uniform(0, maximum)
```

Example delay ranges:

```text
Attempt 0: 0.0–0.2 s
Attempt 1: 0.0–0.4 s
Attempt 2: 0.0–0.8 s
Attempt 3: 0.0–1.6 s
...
Maximum:   10 s
```

Jitter spreads retry traffic instead of synchronizing every client.

---

## Apply a total deadline

A call should not retry forever.

```text
Request deadline: 8 seconds
Attempt 1: 1.0 second timeout
Backoff:   0.2 second
Attempt 2: 1.5 second timeout
Backoff:   0.6 second
Attempt 3: remaining budget
```

Propagate the remaining deadline across service boundaries where possible.

---

## Limit attempts

Set a maximum based on:

- end-user latency;
- operation importance;
- downstream recovery time;
- queue redelivery;
- overall request deadline.

For asynchronous jobs, retries can continue longer, but they still need:

- maximum attempts;
- dead-letter handling;
- alerting;
- reconciliation.

---

## Retry at one layer

Suppose a request passes through five services and every layer makes three attempts.

```text
3 × 3 × 3 × 3 × 3 = 243 possible calls
```

Retries can multiply dramatically.

Choose the layer with enough context to make the retry decision. Lower-level libraries may retry very short network failures, while the business workflow controls larger retries.

---

## Respect server signals

Use:

- `Retry-After`;
- rate-limit headers;
- provider-specific retry guidance;
- circuit-breaker state;
- concurrency limits.

---

## Side-effecting requests require idempotency

Before automatically retrying `POST`, payment capture, order creation, email sending, or resource provisioning, confirm that one of these is true:

1. the API has an idempotency-key contract;
2. the business operation uses a natural unique identifier;
3. the server can prove the first attempt was never applied;
4. a reconciliation step determines the actual outcome.

Without one of these, automatic retry can be unsafe.

---

# 8. End-to-End Payment Example

A checkout service must collect ₹5,000 for order `ORD-901`. It sends `POST /v1/payments` carrying `Idempotency-Key: 5fdd80f8-...` and an amount of `500000` — amounts belong in the smallest currency unit, so that no rounding happens in transit.

The point of the example is not the request shape but how many independent things can be repeated behind it while the customer is still charged once.

## Processing flow

```mermaid
sequenceDiagram
    participant C as Checkout
    participant API as Payment API
    participant DB as Payment DB
    participant Q as Worker Queue
    participant PSP as Payment Provider

    C->>API: Create payment, key K
    API->>DB: Insert payment intent + key K
    DB-->>API: payment_id = PAY-101
    API->>Q: Schedule PAY-101
    API-->>C: 202 Processing

    Q->>PSP: Capture ₹5,000 with provider key K
    PSP--xQ: Response lost

    Q->>PSP: Retry capture with same key K
    PSP-->>Q: Existing successful capture PSP-88
    Q->>DB: Mark PAY-101 succeeded

    C->>API: Retry original request with key K
    API->>DB: Read existing result
    API-->>C: PAY-101 succeeded
```

There may be several HTTP attempts, several queue deliveries, several worker executions, and several provider calls — but exactly one effective payment.

---

## Important database constraints

```sql
CREATE UNIQUE INDEX uq_payment_idempotency
ON payments (tenant_id, idempotency_key);

CREATE UNIQUE INDEX uq_payment_provider_reference
ON payments (provider_name, provider_payment_id);

CREATE UNIQUE INDEX uq_single_capture_per_order
ON payments (order_id)
WHERE payment_type = 'capture'
  AND status IN ('processing', 'succeeded');
```

The exact constraints depend on whether the business supports:

- split payments;
- multiple attempts;
- partial captures;
- retries after a definitive failure;
- multiple payment methods.

Do not create a “one payment per order” constraint if the business legitimately permits more than one payment.

---

## Consistency decision

The payment ledger uses strongly controlled state transitions, protects its balance invariants with transactions or atomic writes, and refuses conflicting state changes in two disconnected partitions. Views, notifications, and analytics derived from it update asynchronously.

```text
Critical core:
Payment state + ledger entries
        │
        └── Strong invariants / CP-like behavior

Derived views:
Email, analytics, dashboard counters
        │
        └── Eventual consistency / AP-friendly behavior
```

This is a common system-design approach: keep the correctness-critical core small and strongly protected, then propagate derived data asynchronously.

---

# 9. Observability and Operational Controls

Idempotency failures are difficult to debug without traceable identifiers.

Log the following fields:

```text
request_id
trace_id
tenant_id
operation
idempotency_key_hash
request_hash
idempotency_status
resource_id
attempt_number
downstream_request_id
provider_reference
retry_reason
response_replayed
processing_duration
```

Avoid logging sensitive payloads or raw credentials.

### Useful metrics

- total idempotent requests;
- duplicate request rate;
- replayed response rate;
- key/payload mismatch count;
- records stuck in `processing`;
- retry count by dependency;
- final failure count;
- unknown payment outcomes;
- reconciliation backlog;
- idempotency-store latency;
- deduplication conflicts.

### Alerts

Alert when:

- `processing` records exceed their expected duration;
- provider success exists without matching local success;
- local success exists without a provider reference;
- duplicate side effects are detected;
- retry traffic rises sharply;
- idempotency storage becomes unavailable.

### Recovery job

A periodic reconciler can inspect stale records:

```text
payment_attempt.status = processing
AND updated_at < now() - 10 minutes
```

For each record:

1. query the external provider using the stable key or request ID;
2. update the local state if the provider knows the outcome;
3. retry safely if the provider confirms no operation exists;
4. move unrecoverable cases to manual review.

---

# 10. Design Checklist

## Consistency

- [ ] The business invariant is clearly defined.
- [ ] The required consistency model is chosen per operation.
- [ ] Stale-read behavior is documented.
- [ ] Conflict resolution is defined for AP operations.
- [ ] Strong coordination is limited to correctness-critical state.
- [ ] Database conditions and constraints enforce invariants.
- [ ] Replication lag is considered in read paths.
- [ ] Session guarantees are provided where user experience requires them.

## CAP and failure behavior

- [ ] Behavior during a partition is explicit.
- [ ] The system knows which operations reject, wait, or continue.
- [ ] The design does not describe CAP as simply “choose any two.”
- [ ] Latency vs consistency is considered during normal operation.
- [ ] Read and write behavior may be selected independently.

## Idempotency

See [Idempotency: Which HTTP Methods Are Idempotent?](../api-design/idempotency-http-methods.md) for the full contract checklist.

- [ ] Key registration and the database mutation are atomic.
- [ ] External providers receive a stable downstream key, reused on retry.
- [ ] In-progress, success, failure, and *unknown* states are all defined.
- [ ] Retention exceeds the realistic retry and redelivery window.

## Retries

- [ ] Only transient failures are retried.
- [ ] Side-effecting calls are idempotent before automatic retry.
- [ ] Exponential backoff and jitter are used.
- [ ] The total deadline and maximum attempts are bounded.
- [ ] `Retry-After` and provider guidance are respected.
- [ ] Retry multiplication across layers is controlled.
- [ ] Dead-letter and reconciliation paths exist.
- [ ] Retry and duplicate metrics are monitored.

---

# 11. References

1. Seth Gilbert and Nancy A. Lynch, **Perspectives on the CAP Theorem**, IEEE Computer, 2012.  
   https://groups.csail.mit.edu/tds/papers/Gilbert/Brewer2.pdf

2. IETF, **RFC 9110: HTTP Semantics**, Section 9.2.2, Idempotent Methods.  
   https://datatracker.ietf.org/doc/rfc9110/

3. AWS Builders' Library, **Making retries safe with idempotent APIs**.  
   https://aws.amazon.com/builders-library/making-retries-safe-with-idempotent-APIs/

4. AWS Builders' Library, **Timeouts, retries, and backoff with jitter**.  
   https://aws.amazon.com/builders-library/timeouts-retries-and-backoff-with-jitter/

5. AWS Architecture Blog, **Exponential Backoff and Jitter**.  
   https://aws.amazon.com/blogs/architecture/exponential-backoff-and-jitter/

6. Amazon DynamoDB Developer Guide, **DynamoDB read consistency**.  
   https://docs.aws.amazon.com/amazondynamodb/latest/developerguide/HowItWorks.ReadConsistency.html

7. Stripe API Reference, **Idempotent requests**.  
   https://docs.stripe.com/api/idempotent_requests

---

> **Key takeaway:** Distributed systems cannot remove uncertainty, but they can contain it. Choose the required consistency for each business invariant, expect requests to be retried, and make every retryable side effect idempotent.
