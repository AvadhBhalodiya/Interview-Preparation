---
title: "Consistency & CAP"
group: "Design Fundamentals"
order: 1
---

# Consistency, CAP, and Why Retries Need Idempotency

> CAP does not ask you to pick two of three - partitions are imposed on you, so the only real choice is what a node does *during* a partition, and because a failed network call is ambiguous rather than failed, the practical answer in a payments system is always retries plus an idempotency key.

## What it is
The **CAP theorem** (Brewer 2000, proved by Gilbert and Lynch in 2002) says a distributed store cannot simultaneously guarantee **C**onsistency (every read sees the latest write - formally linearizability), **A**vailability (every request to a non-failing node gets a non-error response), and **P**artition tolerance (the system keeps working when the network drops messages between nodes).

The "pick two of three" poster is the misconception. You do not get to decline P: once your data lives on more than one machine, the network *will* partition, and that is a fact about the world, not a design option. So CAP collapses into a much narrower question - **when a partition happens, does a node return possibly-stale data (AP) or refuse to answer (CP)?** The rest of the time, when the network is fine, you get both C and A.

> [!KEY] The C in CAP is **linearizability**, not the C in ACID. A single-node PostgreSQL running `SERIALIZABLE` is fully ACID and has nothing to do with CAP, because there is no partition to tolerate. Conflating the two is the most common way this question is failed.

**PACELC** (Abadi, 2012) is the framing that actually survives contact with a real system: *if* **P**artition, choose **A** or **C**; **E**lse, choose **L**atency or **C**onsistency. That second half is where you spend 99.9% of your uptime. Every synchronous replica you add to make reads consistent is latency you pay on every commit, partition or not.

| Model | What a read guarantees | Cost | Where it fits |
| --- | --- | --- | --- |
| **Strong / linearizable** | Sees every commit that finished before it started | Every write waits for a quorum; latency scales with the slowest replica | Ledger balances, "can this account afford the debit?" |
| **Read-your-writes** | You see *your own* writes; other sessions may lag | Route that session's reads to the primary, or wait on an LSN | Post-payment redirect, "my transactions" page |
| **Monotonic reads** | You never see time go backwards | Pin a session to one replica | Paginated feeds, statement lists |
| **Eventual** | Converges *eventually*, with no bound stated | Cheapest, scales horizontally | Dashboards, analytics, search indexes |

The word doing the damage in that last row is **eventually**. It is not a duration. PostgreSQL streaming replication under load, an ElastiCache replica, a DynamoDB eventually-consistent read - all typically converge in single-digit milliseconds and all can spike to seconds when a `VACUUM` storm, a long-running query on the standby, or a WAL burst delays replay.

## Key points
- **In a partition, CP means an error and AP means a lie - both are outages, priced differently.** A CP payment authoriser returns `503` and the customer retries; an AP one authorises against a stale balance and you discover the overdraft at settlement. For money movement, refusing is nearly always cheaper than being wrong, so bias to CP on the write path and AP only on read paths that nobody reconciles against.
- **PostgreSQL lets you choose per transaction, and the knob is `synchronous_commit`.** The default `on` waits for the local WAL flush only; `remote_apply` waits until a synchronous standby has *replayed* the record, which is what makes a replica read genuinely safe. Set it narrowly - the payment commit gets `remote_apply`, the audit-log insert gets `local` - because a global `remote_apply` puts a network round trip inside every commit.
- **"Eventual" costs a payments flow correctness, not just freshness.** The classic bug: `POST /payments` commits to the primary, the client is redirected to `GET /payments/{id}`, that read lands on a replica 40 ms behind, and returns `404`. Nothing is broken and nothing is retryable - the user simply sees that their money vanished. Read-your-writes is the fix, and it is a routing decision, not a database setting.
- **A failed network call is ambiguous, not failed.** A timeout on `POST /charges` tells you nothing about whether the charge happened - the request may have never landed, or it landed and the response was lost. You cannot distinguish these from the client, ever. So the only safe policy is: retry, and make the retry harmless.
- **Retries plus an idempotency key is the practical answer to CAP-flavoured uncertainty.** Send a stable, caller-derived key (`order_id`, not a fresh `uuid4()` per attempt) and let the receiver dedup. Stripe stores the first result against the key and replays it for **24 hours**, so an unbounded retry loop still charges exactly once. See [Idempotency in background tasks](../task-processing/idempotency-background-tasks.md) for the write-side patterns.
- **Exactly-once *delivery* is impossible; exactly-once *effect* is routine.** No protocol over a lossy network can guarantee a message is delivered precisely once - that is the Two Generals problem. What ships in real systems is **at-least-once delivery plus idempotent processing**, which observers call "effectively-once". SQS FIFO advertises exactly-once processing and implements it as content-based deduplication over a **5-minute** window, which is dedup with a deadline, not a proof.

> [!WARN] `retry_on_timeout` without an idempotency key is a double-charge generator. It converts a rare ambiguous failure into a guaranteed duplicate every time the network hiccups, and neither your logs nor your error rate will show it - only the customer's statement will.

## Example
Read-your-writes is a routing problem. The cheapest correct version is to pin a session's reads to the primary for a short window after it writes:

```python
# settings.py -> DATABASE_ROUTERS = ["app.routers.PaymentRouter"]
import time
from django.core.cache import cache

WRITE_STICKY_SECONDS = 5   # comfortably above p99 replica lag, not a guess -
                           # measure it from pg_stat_replication.replay_lag

def mark_wrote(user_id: int) -> None:
    # Called after any commit that the same user will immediately read back.
    cache.set(f"wrote:{user_id}", 1, timeout=WRITE_STICKY_SECONDS)

class PaymentRouter:
    def db_for_read(self, model, **hints):
        user_id = get_current_user_id()          # from middleware / contextvar
        # Recent writer -> primary. Everyone else -> replica. This keeps the
        # replica useful for the 99% of reads that tolerate staleness.
        if user_id and cache.get(f"wrote:{user_id}"):
            return "default"
        return "replica"

    def db_for_write(self, model, **hints):
        return "default"
```

The precise version waits on the WAL position instead of guessing a duration, which matters when lag is spiky rather than bounded:

```sql
-- On the primary, right after COMMIT: capture where we are in the WAL.
SELECT pg_current_wal_lsn();          -- e.g. 3A/7F0001C8

-- On the replica, before serving the read-back: has it replayed that far?
-- Returns immediately if yes; false means fall back to the primary.
SELECT pg_last_wal_replay_lsn() >= '3A/7F0001C8'::pg_lsn;
```

And the retry itself - the thing that makes an ambiguous timeout safe:

```python
import httpx
from tenacity import retry, stop_after_attempt, wait_exponential_jitter

@retry(stop=stop_after_attempt(5), wait=wait_exponential_jitter(initial=0.2, max=10))
def charge(order_id: str, amount_minor: int) -> dict:
    # The key is derived from the ORDER, so all five attempts share it.
    # A per-attempt uuid4() here would defeat the whole mechanism.
    resp = httpx.post(
        "https://api.stripe.com/v1/payment_intents",
        headers={"Idempotency-Key": f"order:{order_id}"},
        data={"amount": amount_minor, "currency": "inr"},
        timeout=10.0,
    )
    resp.raise_for_status()   # a 5xx or timeout retries; the key makes that safe
    return resp.json()
```

## Interview Q&A
- **Does CAP mean you pick two of the three?** No - partition tolerance is not optional for anything distributed, so the real choice is binary and only applies during a partition: return stale data or return an error. Outside a partition you get both C and A, which is why PACELC's latency-versus-consistency trade-off describes normal operation better.
- **Is PostgreSQL CP or AP?** A single primary with synchronous replication behaves as CP - if the sync standby is unreachable, commits block rather than diverge. Flip `synchronous_commit` to `local` and add async read replicas, and the read path becomes AP: it stays available and serves stale rows. The answer depends on the replication settings, not on the product.
- **What is read-your-writes and how do you implement it?** It guarantees a session sees its own writes even when other sessions lag. Implement it by routing that session's reads to the primary for a short sticky window, or precisely by capturing `pg_current_wal_lsn()` at commit and only using a replica once `pg_last_wal_replay_lsn()` has caught up.
- **Why does eventual consistency break a payments flow specifically?** Because the read-back after a write is not decorative - a balance check, a "did my transfer go through" screen, or a duplicate-payment guard reading a stale replica gives an answer that is wrong rather than merely old, and money decisions get made on it.
- **Can you get exactly-once delivery?** Not over an unreliable network - that is the Two Generals problem. You get at-least-once delivery and make the effect exactly-once with idempotency keys and dedup. SQS FIFO's "exactly-once processing" is content dedup over a 5-minute window, which is the same trick with a vendor label.
- **A payment API call times out. What do you do?** Retry with exponential backoff and jitter, reusing the same idempotency key, because a timeout does not tell you whether the charge happened. Then reconcile: query the provider by that key rather than assuming either outcome.

## Gotchas
> [!WARN] **Retrying a non-idempotent write across a partition is how you double-spend.** The first attempt may have committed on the far side of the break. Never retry a bare `INSERT INTO ledger (...)` - retry an `INSERT ... ON CONFLICT (idempotency_key) DO NOTHING`, and treat "zero rows affected" as success, not as an error.

> [!WARN] **Adding read replicas silently downgrades your consistency model.** Nothing warns you. The queries do not change, the tests still pass against a single database in CI, and the bug only shows up in production as a `404` on a resource that definitely exists. Any read that gates a write decision must be pinned to the primary.

- **Retry storms turn a blip into an outage.** Fixed-interval retries across thousands of clients re-synchronise into a wave that keeps a recovering database down. Always use exponential backoff *with jitter*, and cap total attempts - AWS SDKs default to adaptive retries with jitter for exactly this reason.
- **A stuck standby stalls the primary under `remote_apply`.** If a synchronous standby stops replaying, commits on the primary block indefinitely. Run at least two candidate standbys with `synchronous_standby_names = 'ANY 1 (s1, s2)'` so one slow node cannot hold the write path hostage.
- **Long queries on a replica cause lag, not just slow reads.** A reporting query holding a snapshot conflicts with WAL replay; PostgreSQL waits `max_standby_streaming_delay` (default **30s**) before cancelling it. Turning on `hot_standby_feedback` avoids the cancellation but pushes bloat onto the primary instead - you are moving the pain, not removing it.
- **Idempotency keys expire.** Stripe's are honoured for 24 hours. A retry from a dead-letter queue replayed three days later is a fresh charge, not a dedup hit, so DLQ replays need their own guard.

## Revise next
- [Scaling the database](db-scaling.md): read replicas are where replica lag and read-your-writes become your problem
- [Idempotency in background tasks](../task-processing/idempotency-background-tasks.md): the write-side patterns that make a retry safe
- [Replication, sharding, and partitioning](../databases/replication-sharding-partitioning.md): the mechanism behind the lag
- [Transaction isolation levels](../databases/transaction-isolation-levels.md): the single-node consistency guarantees CAP is *not* talking about

*Reviewed against PostgreSQL 18, Stripe API and AWS SQS docs, July 2026.*
