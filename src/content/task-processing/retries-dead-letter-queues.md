---
title: "Retries & DLQ"
group: "Reliability"
order: 4
---

# Retry Strategies + Dead-Letter Queues (DLQ)

> Retries re-run a failed task with growing backoff so transient blips heal on their own, and a dead-letter queue quarantines the messages that keep failing so a human can look at them instead of letting them loop forever or vanish.

## What it is
- **Retry:** catch a failure and run the task again a little later, waiting longer each time (**backoff**). The point is to ride out transient problems - a DB that blinked, an API returning 503 - with nobody paged.
- **Dead-letter queue (DLQ):** a separate queue (or table) a message lands in once it has been retried to death. It is a holding pen, not a fix. You alert on it, look at why the message is "poison," then replay it after the fix or drop it.

The lifecycle of one failing message:

1. **Task fails** on a transient error (a timeout, a dropped connection, a 429/503).
2. **Backoff retry** re-queues it after a growing delay - 1s, 2s, 4s, 8s ... (exponential, capped) - plus **jitter** so a fleet of workers does not all retry on the same tick.
3. **`max_retries` is hit** and the retry budget is spent.
4. **Dead-letter**: the message moves to the DLQ to be inspected, fixed, and replayed.

> [!KEY] Two layers, and people mix them up: **retries live in your task framework** (Celery, Taskiq), while a real **DLQ almost always lives in the broker** underneath (RabbitMQ, SQS).

## Key points
- **Retry only transient failures.** Timeouts, dropped connections, 429/503 - things that might work next time. A validation error or a `KeyError` in your own code fails identically on every attempt, so let it fail fast. Retrying it just burns workers and floods the DLQ with **poison messages** (a message that can never succeed, no matter how many times you redeliver it).
- **Backoff and jitter solve two different problems.** Backoff stops you pounding a dependency that is already on its knees. Jitter scatters the retries so a whole fleet does not fire in lockstep and rebuild the exact spike you were dodging (the **thundering herd**).

Celery gives you two ways to retry - reach for automatic first, drop to manual when the decision is conditional:

|  | **Automatic** | **Manual** |
| --- | --- | --- |
| Trigger | `autoretry_for=(...)` on the **decorator** | `raise self.retry(exc=e, countdown=...)` with **`bind=True`** |
| Backoff | `retry_backoff=True` -> 1,2,4,8s, **jitter on by default** | **you** compute the `countdown` |
| Reach for it | "retry this exception with backoff" - the **default** | the delay or exception set is **conditional** |
| Final failure | re-raises your **original exception** | you can catch **`MaxRetriesExceededError`** and DLQ |

Learn the defaults - they catch people:

| Setting | Default | Note |
| --- | --- | --- |
| `max_retries` | **3** | not unlimited - `None` retries **forever**, never on side effects |
| `default_retry_delay` | **180s** | used when you pass no `countdown` or backoff |
| `retry_backoff_max` | **600s** (10 min) | caps exponential growth - **set it lower** for user-facing work |

Celery ships no DLQ, so you lean on the broker or route dead tasks yourself - and the two brokers do it very differently:

|  | **RabbitMQ** (dead-letter exchange) | **Amazon SQS** (redrive policy) |
| --- | --- | --- |
| Wire-up | point a queue at an exchange via `x-dead-letter-exchange`, set with a **policy** not hardcoded args | `deadLetterTargetArn` + **`maxReceiveCount`** (default 10, range 1-1000) |
| Dead-letters on | nack/reject **requeue=false**, per-message TTL, queue-length overflow, or a quorum queue's **delivery-limit** | `ReceiveCount` exceeds `maxReceiveCount` after the **visibility timeout** lapses that many times |
| Constraints | routing via `x-dead-letter-routing-key` | DLQ must be **same account, region, and type** (standard/FIFO) - give it longer retention |

> [!TIP] On SQS the **visibility timeout is your retry delay**: a message reappears (and `ReceiveCount` ticks) only after it lapses. Set it longer than the task's worst-case runtime, or a slow task gets redelivered and runs twice while the first copy is still going.

- **The catch:** a broker DLQ does not fire on an ordinary task exception. Celery acks the message once the worker handles the task - even one that raised and exhausted its retries - so `maxReceiveCount` and the delivery-limit only tick on **redelivery** (a worker crash or lost connection under **`acks_late`**). To DLQ a normal exception, route it yourself from `on_failure` or `MaxRetriesExceededError`.
- **Taskiq** (the async-native option, ~0.12) does retries as middleware: `SimpleRetryMiddleware(default_retry_count=3)` plus `@broker.task(retry_on_error=True, max_retries=...)`, or `SmartRetryMiddleware` for backoff and jitter. It has no DLQ of its own either - that stays the broker's job.
- **Retries assume idempotency.** A retry re-runs the whole body, and `acks_late` can redeliver a message whose side effects already partly landed. If "charge the card" is not safe to run twice, backoff will not save you - an **idempotency key** will.

## Example
```python
# The 90% case: auto-retry the transient error, backoff capped, jitter on by default.
@app.task(autoretry_for=(ConnectionError,),
          retry_backoff=True, retry_backoff_max=60, max_retries=5)
def sync_user(user_id):
    save(external_api.get(user_id))       # ConnectionError -> re-queued after 1,2,4,8,16s
```

```python
# Manual control + a real DLQ, since Celery gives you neither for free.
from celery.exceptions import MaxRetriesExceededError

@app.task(bind=True, max_retries=5)
def charge(self, order_id):
    try:
        gateway.charge(order_id)          # must be idempotent on order_id
    except TimeoutError as exc:
        try:
            # note: self.request.retries starts at 0, so countdown is 1,2,4,8...
            raise self.retry(exc=exc, countdown=2 ** self.request.retries)
        except MaxRetriesExceededError:
            dead_letter.put(order_id, reason=str(exc))   # a table or queue you actually watch
```

## Interview Q&A
- **How do you retry a Celery task?** Two ways: `raise self.retry(...)` with `bind=True` when you want to pick the delay and which exceptions count, or `autoretry_for=(...)` with `retry_backoff` when you just want "retry this exception type with backoff." Reach for autoretry first. Drop to manual when the decision is conditional.
- **Why exponential backoff, and why jitter on top?** Backoff gives a struggling dependency room to recover instead of getting hit every second. Jitter spreads the retries out so a whole worker fleet doesn't fire on the same tick and rebuild the spike you were trying to dodge.
- **What is a DLQ actually for?** Somewhere to park messages that failed past their retry budget, so you can inspect and replay them instead of losing them or looping forever. It's triage, not a cure.
- **Does Celery have a built-in DLQ?** No. You use the broker's (SQS redrive policy, RabbitMQ dead-letter exchange) or route dead tasks yourself in `on_failure` / on `MaxRetriesExceededError`. And remember the broker DLQ only catches redeliveries - crashes, lost workers under `acks_late` - not an ordinary exception that ran out of retries.
- **What has to be true for retries to be safe?** The task has to be idempotent. A retry re-runs the whole body, so any side effect that already landed lands again unless an idempotency key or a dedupe check guards it.

## Gotchas
> [!WARN] **Non-idempotent task + retries = duplicated side effects.** A retry (or an `acks_late` redelivery) re-runs the whole body, so any effect that already landed lands again. The classic is the double charge or the double email. Guard it with an idempotency key, not with backoff.

> [!WARN] **`max_retries=None` retries forever.** The default is 3, but `None` is genuinely unbounded, so never set it on anything with side effects. Uncapped `retry_backoff` also drifts out to 10-minute waits (`retry_backoff_max` default 600s) - fine for a nightly sync, awful for a user waiting on a response.

- Retrying non-transient errors (validation, your own bugs, 4xx you caused) is pure waste - same input, same failure, every time, and now the DLQ is full of noise.
- With `autoretry_for`, the final failure re-raises your **original** exception, not `MaxRetriesExceededError` (celery/celery#5061). To catch exhaustion for a DLQ, use manual `self.retry` (like the example) or handle it in `on_failure`.
- Don't confuse the two "retry"s in Celery: `retry` / `retry_policy` on `apply_async` is about **reconnecting to the broker**, not re-running your task. Different knob entirely.

## Revise next
- [Idempotency in background tasks](idempotency-background-tasks.md) (the other half of a safe retry)
- [Broker DLQ mechanics](message-brokers-redis-rabbitmq-sqs.md): SQS redrive policy vs RabbitMQ dead-letter exchange
- Celery `acks_late` + `task_reject_on_worker_lost` (what actually gets redelivered)
- Taskiq `SmartRetryMiddleware` if you're on the async stack

*Reviewed against Celery 5.6, RabbitMQ and Amazon SQS docs, July 2026.*
