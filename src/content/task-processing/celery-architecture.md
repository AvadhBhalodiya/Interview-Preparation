---
title: "Celery Architecture"
group: "Architecture & Brokers"
order: 1
---

# Celery Architecture: Broker, Worker, Result Backend

> Celery pushes work out of the request cycle: your app drops a task message on a broker, a pool of worker processes pulls it off and runs it, and an optional result backend stores the outcome for whoever wants to read it.

## What it is
Celery is a **distributed task queue**. You hand off work that has no business blocking a web request (sending email, rendering a PDF, calling a slow third-party API) and it runs on separate worker processes, in parallel, with retries when you ask for them.

The catch that trips people up: **Celery does not store or run tasks itself**. It is a client library plus a worker daemon that talk through someone else's queue. Name the parts and the system falls into place:

| Component | Role |
| --- | --- |
| **Producer** (your app) | Calls `.delay()` / `.apply_async()`, serializes the call, publishes it, returns at once |
| **Broker** (Redis \| RabbitMQ \| SQS) | The **message transport** - holds tasks until a worker is free |
| **Worker** (prefork \| gevent pool) | Long-running daemon that pulls messages and **executes** the task body |
| **Result backend** (Redis \| DB \| RPC) | **Optional** store for the return value and state, read via `AsyncResult(id).get()` |
| **Beat** (scheduler) | Enqueues tasks on a schedule - it **only publishes, never executes** |

> [!KEY] Celery keeps no state of its own: the **broker is the queue** and the **workers are the muscle**. Producer and worker never talk directly - every task is a message that flows producer -> broker -> worker.

## Key points
- **`delay()` vs `apply_async()`.** Both publish the same message and hand back an `AsyncResult`. Reach for `apply_async` the moment you need delivery options.

| Call | Use it when |
| --- | --- |
| `add.delay(2, 3)` | The **common case** - just args and kwargs. It literally calls `apply_async` for you |
| `add.apply_async(args=(2, 3), ...)` | You need **execution options**: `countdown`, `eta`, `queue`, `priority`, `expires`, `retry` |

- **The broker is the queue, not Celery.** All three transports below are Stable in 5.6, so pick by the delivery guarantees you need.

| Transport | Redelivery model | Routing & DLQ | Ordering |
| --- | --- | --- | --- |
| **RabbitMQ** (AMQP) | **Ack + heartbeat**: detects a dead worker over the connection, no timer | Full routing, priorities, native **dead-letter exchange** | Per-queue FIFO |
| **Redis** | **Visibility timeout** (default **1 hour**): unacked task redelivered on expiry | Lists / sorted sets, **no native DLQ** | Best-effort |
| **Amazon SQS** | Visibility timeout + **redrive policy** to a DLQ after `maxReceiveCount` | Managed DLQ, **no remote control or events** in Celery | Standard best-effort \| **FIFO strict** |

- **Workers run a pool.** The pool type decides whether concurrency means processes or greenlets.

| Pool | Concurrency unit | Best for |
| --- | --- | --- |
| `prefork` (default) | **OS processes**, one per `-c` slot (defaults to CPU count) | **CPU-bound** or blocking work |
| `gevent` / `eventlet` | **Greenlets** in one process, hundreds at once | **IO-bound**, high-concurrency network waits |
| `solo` | Runs **inline** in the main process | Debugging only |

- **The result backend is optional.** Values and state land in Redis, a SQL database (SQLAlchemy or the Django ORM), or the RPC backend that ships results back over the broker. If nothing calls `.get()`, set `ignore_result=True` and skip the write. Storing a result nobody reads is wasted IO on every task.
- **Task states:** `PENDING -> STARTED -> SUCCESS | FAILURE | RETRY`. `STARTED` only appears with `track_started=True`, so by default a running task still reports `PENDING`.
- **Routing stops workloads starving each other.** Declare named queues and pin a worker to each with `-Q`. Park slow report jobs on a `heavy` queue with their own workers so fast `emails` tasks never sit behind them. The stock default queue is literally named `celery`.
- **Task bodies run synchronously.** Even when your web app is async, the task runs sync inside the worker - there is no `await` in the body. For an asyncio-native queue with the same broker/worker/backend shape, look at **Taskiq** (~0.12, it bills itself as an "asyncio Celery"). It is not a drop-in and targets async-only projects.

## Example
```python
# tasks.py
from celery import Celery

app = Celery(
    "proj",
    broker="redis://localhost:6379/0",     # where messages queue up
    backend="redis://localhost:6379/1",    # where results land (optional)
)

@app.task
def add(x, y):
    return x + y
```
```python
# caller runs in your web process and returns immediately
result = add.delay(2, 3)                  # shorthand: serialized and pushed to the broker
add.apply_async((2, 3), countdown=10)     # same task, but run it 10s from now
result.get(timeout=5)                     # blocks up to 5s until the worker writes the result
```
```bash
# start a worker: 4 prefork processes, consuming two queues
celery -A tasks worker -c 4 --pool=prefork -Q celery,emails
```

## Interview Q&A
- **What are Celery's core components?** Producer (your app), broker (message transport), worker (executor), plus an optional result backend. If someone says Celery stores the tasks, that is the tell they have missed the point - the broker does.
- **What does the broker actually do?** It is the queue. Your app publishes a message, the broker holds it and hands it to a free worker. Celery keeps no state between the two.
- **`delay()` vs `apply_async()`?** Identical under the hood, since `delay()` just calls `apply_async(args, kwargs)`. Use `apply_async` when you need execution options (countdown, eta, queue, priority, expires).
- **When can you drop the result backend?** When nothing reads the outcome. Set `ignore_result=True` and save a write per task. Just do not call `.get()` afterward, because there is nothing to read back.
- **prefork vs gevent?** prefork is OS processes, for CPU-bound and blocking tasks. gevent/eventlet are greenlets in a single process, for high-concurrency IO where forking that many processes would fall over.

## Gotchas
> [!WARN] **PENDING does not mean "queued."** With the default backend, any unknown task id reads as `PENDING`. A task genuinely waiting to run and a task id you typo'd are indistinguishable - there is no "not found" state.

- **Prefetch starves long tasks.** `worker_prefetch_multiplier` defaults to **4**, so each process reserves up to `4 x concurrency` messages up front. One worker can grab a stack of slow jobs while others sit idle. For long tasks set it to `1`.
- **The Redis broker redelivers long tasks.** Its visibility timeout is one hour by default. A task that runs past it without acking looks dead to Redis, which hands the same message to another worker, so it runs twice (and can loop). Keep tasks well under the timeout, or use RabbitMQ, whose acks are not driven by a timer.
- **No backend, no `.get()`.** Call `.get()` with no result backend configured and it blocks to the timeout, then errors. Skipping the backend is fine. Half-configuring it is the trap.

> [!WARN] **`acks_late` demands idempotency.** Ack timing is really a delivery-guarantee switch, and a late ack re-runs any task whose worker died mid-flight.

| Setting | Ack timing | Guarantee | Worker dies mid-task |
| --- | --- | --- | --- |
| **ack-early** (default, `task_acks_late=False`) | Before the task runs | **At-most-once** | Message is **lost** |
| **ack-late** (`task_acks_late=True`) | After the task returns | **At-least-once** | Message is **re-run** |

## Revise next
- [Retries](retries-dead-letter-queues.md): `autoretry_for`, `retry_backoff`, and dead-letter handling
- Celery **canvas**: chaining tasks with `chain`, `group`, and `chord`
- [Celery **Beat**](celery-beat-periodic-tasks.md) for periodic and scheduled tasks
- [**Taskiq**](celery-vs-taskiq.md), an asyncio-native queue for when Celery's sync workers do not fit

*Reviewed against Celery 5.6, July 2026.*
