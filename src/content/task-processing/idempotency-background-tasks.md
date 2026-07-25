---
title: "Idempotency (Tasks)"
group: "Reliability"
order: 3
---

# Idempotency in Background Tasks

> A task is idempotent when running it many times leaves the system exactly where a single run would, which is the contract you need because every real broker delivers at-least-once and will replay the same job on a retry, a redelivery, or a crash mid-execution.

## What it is
**Idempotent** means calling the function again with the same arguments changes nothing beyond the first call - Celery's glossary calls it "a function that can be called multiple times without changing the result." You design for it because a queue's honest guarantee is **at-least-once**, never exactly-once. "Exactly-once delivery" is marketing: the real contract is "we will deliver it, possibly more than once, and not double-acting is your job."

> [!KEY] Reads are **nullipotent** (free to repeat, no side effect), so it is the **writes** you must make replay-safe. Nail the write side and the whole class of duplicate-execution bugs vanishes.

A duplicate is not an edge case - the broker hands the same message to another worker whenever an ack is lost or a timeout expires. Five strategies make a handler safe on replay, cheapest first:

| Strategy | How replay stays safe | Reach for it when |
| --- | --- | --- |
| **Natural idempotency** | The write is **already a no-op on repeat**: `SET status='paid'`, not `balance += 10` | You can set an **absolute state** instead of incrementing |
| **Dedup / idempotency key** | Store a **stable key from the payload** (`order_id`), skip if already seen | The side effect **cannot be a no-op** on its own |
| **DB unique constraint** | A duplicate insert **raises instead of double-writing** | You want the **database** to enforce once-only |
| **Upsert** (`INSERT ... ON CONFLICT`) | Insert-or-update in **one atomic statement**, no check-then-act race | **Concurrent** workers may touch the same row |
| **Distributed lock** | A short-lived Redis `SET NX` with a **TTL** serialises the section | **Last resort** for effects with no natural key |

## Key points
- **Where the duplicate comes from:** an automatic retry, an `acks_late` task whose worker died before acking, a visibility timeout expiring while the task still runs, or a finished task whose ack was lost on the wire. Each broker surfaces this differently:

| Broker | Redelivery mechanism | Ordering | Dead-letter |
| --- | --- | --- | --- |
| **RabbitMQ / AMQP** | **Consumer ack**: an unacked message is requeued when the consumer drops | Per-queue FIFO (best effort) | **Dead-letter exchange (DLX)** |
| **Redis** | Visibility timeout, Celery default **1 hour** | No strong guarantee | None native |
| **Amazon SQS** | Visibility timeout, Celery default **30 min** (raw AWS 30 s) | Best-effort standard \| strict **FIFO** | **Redrive policy** → DLQ after `maxReceiveCount` (default 10) |

- **Reach for naturally idempotent writes first.** `UPSERT`, `SET status='paid'`, and `INSERT ... ON CONFLICT DO NOTHING` all collapse a repeat into a no-op. The one that bites is the increment: `balance = balance + 10` run twice is a real bug, `SET balance = 110` run twice is not.
- **When a side effect is unavoidable, dedup on a stable key** and record-and-check in one atomic statement, because a separate `SELECT` then `INSERT` races under concurrency.
- **Push idempotency to the boundary you don't control.** Your DB claim can't un-charge a card, so let the provider dedup: Stripe and most payment or email APIs accept an idempotency key and return the first response on a repeat. Send the same key on every retry and the external call becomes replay-safe.
- **`acks_late=True` (off by default) acks after the task returns,** so a lost task is redelivered instead of silently dropped - enable it only for idempotent tasks. Frameworks differ: **Celery acks early** so a started task never reruns, while **Taskiq** defaults to `--ack-type when_saved`, acking only after the result is stored.

> [!TIP] Derive the dedup key from the **payload** (`order_id`), never a `uuid4()` minted inside the task. A retry would generate a fresh key and the dedup would silently do nothing.

## Example
```python
@app.task(bind=True, acks_late=True, max_retries=3)
def charge_order(self, order_id):
    order = Order.objects.get(id=order_id)
    if order.status == "paid":
        return "already paid"          # cheap short-circuit, not the safety net

    try:
        # The real guard: the same key means the provider charges at most once,
        # even if a retry or a redelivery calls this again.
        charge_payment(order_id, idempotency_key=f"charge:{order_id}")
    except TransientError as exc:
        raise self.retry(exc=exc, countdown=5)   # a retry runs this task again

    # Mark paid last. A crash here just replays a charge that is already idempotent.
    Order.objects.filter(id=order_id).update(status="paid")
    return "charged"
```

When there is no external provider to lean on, let the database be the guard - one atomic write, no check-then-act:

```python
def mark_shipped(order_id):
    # The UPDATE is the lock: exactly one worker flips pending -> shipped.
    rows = Order.objects.filter(
        id=order_id, status="pending"
    ).update(status="shipped")
    if rows == 0:
        return "already shipped"        # a replay updates 0 rows -> safe no-op
    return "shipped"
```

## Interview Q&A
- **What makes a task idempotent?** Running it N times leaves the system in the same state as running it once. The pass/fail pair to quote: `set_status('paid')` is fine on repeat, `balance += amount` double-counts.
- **Why is it required, not optional?** Brokers deliver at-least-once. Retries, `acks_late` worker crashes, and visibility-timeout redelivery all replay the same message, so any non-idempotent task is a latent double-execution bug.
- **How do you make charging a card safe, since a charge isn't naturally idempotent?** You can't make the charge itself idempotent, so move the guarantee to the provider: pass a stable idempotency key and let them return the first result on a repeat. Back it with an atomic DB claim for a cheap early short-circuit.
- **Is it safe to turn on `acks_late` everywhere?** No. It is safe only for idempotent tasks. On a non-idempotent one it upgrades "duplicate on crash" from rare to expected.
- **Does `acks_late` guarantee redelivery on every crash?** No. A hard-killed worker child still acks the message unless you also set `task_reject_on_worker_lost=True`.

## Gotchas
> [!WARN] At-least-once delivery means a task **CAN run more than once** - a retry, a lost ack, or an expired visibility timeout all replay it. Design every handler to be **safe on replay**, because "exactly-once delivery" is a myth: products advertising it run at-least-once plus idempotent dedup underneath.

> [!WARN] **`acks_late` alone doesn't survive a killed worker.** Per the Celery docs, even with late acks the worker acks the task when its child is signaled (KILL/INT) or OOM-killed. You need `task_reject_on_worker_lost=True` to requeue it, and that reintroduces duplicates - so the task had better be idempotent anyway.

- **Check-then-act without atomicity races.** Two workers both read `status='pending'` and both proceed. Collapse it into a single `UPDATE ... WHERE status='pending'` and trust the affected-row count instead of a prior `SELECT`.
- **A claim you never release strands the work.** Flip a row to `'charging'`, crash before finishing, and redelivery sees "not pending" and skips it forever. Either make the side effect idempotent so re-entry is safe, or reset the claim on failure.
- **Duplicated side effects fail silently.** A double charge or double email raises no error - the customer just gets two, and nothing in your logs screams about it. Guard each external effect explicitly rather than hoping retries stay rare.

## Revise next
- [Retries, backoff, and the dead-letter queue](retries-dead-letter-queues.md)
- [Message brokers and at-least-once delivery](message-brokers-redis-rabbitmq-sqs.md): AMQP consumer acks vs Redis/SQS visibility timeout
- [DB transactions](../django/transactions-atomic.md), unique constraints, and `INSERT ... ON CONFLICT`

*Reviewed against Celery 5.6 and Taskiq docs, July 2026.*
