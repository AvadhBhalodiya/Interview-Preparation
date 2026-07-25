---
title: "Design a Job Scheduler"
group: "Classic Designs"
order: 12
---

# Design a Job Scheduler and Queue

> A queue answers "run this soon", a scheduler answers "run this at 02:00 every day", and the interesting half of the design is everything after that: exactly one process deciding what is due, an atomic claim so two workers never take the same job, at-least-once delivery paired with idempotent handlers, and an alert on queue *age* rather than queue depth.

## What it is
Two different problems get bundled under "job scheduler", and separating them is the first thing to say out loud:

| Concern | Question it answers | Component | Failure if you skip it |
| --- | --- | --- | --- |
| **Queue** | "Run this **soon**, off the request path" | Broker + workers | The HTTP request blocks on slow work |
| **Scheduler** | "Run this **at T**, or every T" | Beat / a due-work poller | Nothing fires, or everything fires twice |
| **Dispatcher** | "**Which** job runs next, for whom" | Routing, priorities, fairness | One tenant starves everyone else |
| **Supervisor** | "What happens when it **fails**" | Retries, DLQ, alerting | Work vanishes silently |

Size the thing before you design it. **10,000 jobs a day is 0.12 per second on average** - two or three orders of magnitude below what a single Redis and four Celery workers handle comfortably. The pressure is not throughput, it is the burst (a month-end batch dumping 8,000 jobs in ten minutes is 13/s) and the tail: one job that takes 40 minutes while the rest take 200 ms. Saying that out loud is the senior signal; proposing Kafka for 10k/day is the opposite.

> [!KEY] A broker gives you **at-least-once** delivery, never exactly-once. Every design decision below - the atomic claim, the visibility timeout, the retry policy - only bounds *how often* a duplicate happens. **Idempotent handlers are what make duplicates harmless**, and there is no configuration that substitutes for them.

## Key points
- **Do not schedule far-future work in the broker.** Celery's `eta`/`countdown` with a Redis broker means the worker **fetches the message now and holds it in memory** until it is due: it occupies a prefetch slot, it is invisible to inspection, and a worker restart or deploy loses it. Anything more than a few minutes out belongs in a `scheduled_job` table with a `run_at` column, polled every 10-30 seconds by a small dispatcher. SQS is blunter still - `DelaySeconds` caps at **15 minutes**.
- **Exactly one process may decide what is due.** Two beat processes mean every periodic task fires twice, and "we set the ECS desired count to 1" is not a guarantee - a rolling deploy runs the old and new task concurrently for a few seconds, which is exactly when the cron tick lands. Hold a **lease**: `SET beat:leader <uuid> NX PX 30000` renewed every 10 seconds, or a Postgres advisory lock, or RedBeat which does this for you.
- **Claim work atomically with `FOR UPDATE SKIP LOCKED`.** It is the one-line answer to "how do N workers pull from one table without collisions": the lock is taken and the row is skipped by other transactions in the same statement, so there is no check-then-act race and no lock convoy. Available in PostgreSQL since 9.5.
- **Backoff must have jitter, and retries must have a floor.** `2 ** attempt` seconds capped at 10 minutes is standard; the jitter is what stops 500 jobs that failed on the same downstream outage from retrying in the same instant and re-killing it. In Celery: `autoretry_for`, `retry_backoff=True`, `retry_backoff_max=600`, `retry_jitter=True` (on by default), `max_retries`. Retry only **transient** failures - a `ValidationError` will fail identically on attempt five, so it should go straight to the DLQ.
- **Set the visibility timeout above your slowest job.** This is the most common production incident in this design. Celery's Redis transport defaults to a **1-hour** visibility timeout and its SQS transport to **30 minutes** (raw SQS defaults to 30 seconds); when a job outlives it, the broker hands the same message to a second worker while the first is still running, and you get concurrent duplicate execution rather than an error.
- **Separate queues, not priority numbers, are how you get fairness.** Priority support is uneven across brokers (Redis emulates it with per-priority key suffixes; RabbitMQ needs `x-max-priority` on the queue), and a numeric priority still lets one tenant with 50,000 queued jobs starve everyone. Route by class of work - `payments`, `default`, `bulk` - with dedicated workers, and cap concurrency per tenant when one customer can flood the queue.

> [!TIP] Alert on **lag**, not depth. A depth of 5,000 is fine if it drains in a minute; a depth of 12 is an incident if the oldest message has been waiting an hour. SQS exposes this directly as `ApproximateAgeOfOldestMessage`; with Celery, stamp `enqueued_at` in the task headers and record `started_at - enqueued_at` as a histogram.

## Example
The durable half - a jobs table that is its own schedule, with a claim that is safe against any number of concurrent dispatchers:

```sql
CREATE TABLE scheduled_job (
  id           BIGSERIAL PRIMARY KEY,
  task         TEXT        NOT NULL,
  payload      JSONB       NOT NULL,
  run_at       TIMESTAMPTZ NOT NULL,
  status       TEXT        NOT NULL DEFAULT 'pending',
  attempts     INT         NOT NULL DEFAULT 0,
  dedupe_key   TEXT UNIQUE                      -- a replay collides here instead of re-running
);
-- Partial index: the dispatcher's query only ever touches pending rows, so the index
-- stays small even when the table holds ten million finished jobs.
CREATE INDEX job_due ON scheduled_job (run_at) WHERE status = 'pending';
```

```sql
-- The claim. SKIP LOCKED is what lets ten dispatchers run this concurrently:
-- each transaction locks a disjoint set of rows instead of queueing behind the others.
UPDATE scheduled_job SET status = 'claimed', attempts = attempts + 1
WHERE id IN (
  SELECT id FROM scheduled_job
  WHERE status = 'pending' AND run_at <= now()
  ORDER BY run_at
  FOR UPDATE SKIP LOCKED
  LIMIT 100
)
RETURNING id, task, payload;
```

The worker side. The retry policy is declarative; the leader lease is what keeps beat honest:

```python
@app.task(
    bind=True, acks_late=True,
    autoretry_for=(RequestException,),       # transient only - never retry a ValidationError
    retry_backoff=True, retry_backoff_max=600, retry_jitter=True, max_retries=5,
)
def settle_payout(self, job_id: str) -> str:
    job = ScheduledJob.objects.get(id=job_id)
    # Idempotent by construction: the same key returns the first result from the provider,
    # so a redelivery after a visibility timeout cannot pay out twice.
    return psp.payout(job.payload, idempotency_key=f"payout:{job.dedupe_key}")

@app.task
def enqueue_due_jobs() -> None:
    # Beat runs every 15s on every instance; only the lease holder does the work.
    if not redis.set("beat:leader", INSTANCE_ID, nx=True, px=30_000):
        return
    for job in claim_due_jobs(limit=100):
        settle_payout.apply_async(args=[job.id], queue=queue_for(job))
```

## Interview Q&A
- **How do you stop a periodic task firing twice when you run several schedulers?** Only one process may publish, enforced by a short-lived lease rather than by hoping the deployment keeps exactly one alive - a Redis `SET NX PX` renewed on a timer, or a Postgres advisory lock. Then make the task idempotent anyway, because the lease can expire mid-run during a GC pause or a network partition.
- **Why not use Celery's `countdown` for a job due in six hours?** Because with Redis the message is delivered to a worker immediately and held in memory until due: it burns a prefetch slot, it disappears on the next deploy, and you cannot query or cancel it. Persist the schedule in Postgres and let a poller enqueue what is actually due.
- **Ten workers, one jobs table - how do they not collide?** `SELECT ... FOR UPDATE SKIP LOCKED LIMIT N` inside the claiming transaction. Each worker locks a disjoint batch, unclaimed rows stay available, and nobody blocks on anybody's lock.
- **A job runs longer than the visibility timeout. What happens?** The broker assumes the worker died and redelivers, so two workers execute the same job at once - and unlike a crash this produces no error anywhere. Fix the timeout to exceed the p99 runtime, split the long job into chunks, or extend the lease with a heartbeat.
- **When does a message go to the DLQ, and what do you do with it?** After the retry budget is exhausted or when the failure is permanent by classification. The DLQ is a quarantine for humans: alert on any arrival, inspect the payload, fix the cause, then replay. A DLQ nobody watches is a slower way of deleting work.
- **How do you keep a bulk import from starving payment jobs?** Route them to different queues with dedicated workers, so bulk congestion cannot consume the payment workers' concurrency. Within a queue, cap in-flight jobs per tenant, otherwise one customer's 50,000 rows sit ahead of everyone else's.

## Gotchas
> [!WARN] **`acks_late=True` is only safe on idempotent tasks.** It acks after the task returns, so a worker that dies mid-job gets the message redelivered instead of dropping it - which is what you want, and which guarantees a partial re-run. On a non-idempotent handler it upgrades "duplicate on crash" from rare to expected. It also does not survive a `SIGKILL` unless `task_reject_on_worker_lost=True` is set.

> [!WARN] **Passing an ORM object into a task is a race, not a serialization error.** Pass the id and re-fetch inside the task, and if you enqueue from inside `transaction.atomic`, use `transaction.on_commit` - otherwise the worker can pick the job up before the row it needs is visible, and you get a phantom `DoesNotExist` that never reproduces locally.

- **A claimed job whose worker died is stranded forever** unless something resets it. Store `claimed_at` and sweep rows stuck in `claimed` past a threshold back to `pending`.
- **Unbounded retries on a poisoned payload loop until the queue melts.** Every retry policy needs `max_retries` and a terminal state.
- **Beat catches up on missed ticks.** A scheduler down for two hours can fire a stack of hourly jobs on restart; guard with a dedupe key on the scheduled period, so replays collapse into one.
- **Queue depth alone hides the real problem.** Depth zero with every worker stuck on a 40-minute job is a stalled system that looks perfectly healthy on the dashboard.

## Revise next
- [Idempotency in background tasks](../task-processing/idempotency-background-tasks.md) - the contract everything above depends on
- [Retries, backoff and the DLQ](../task-processing/retries-dead-letter-queues.md)
- [Celery Beat](../task-processing/celery-beat-periodic-tasks.md) and [message brokers](../task-processing/message-brokers-redis-rabbitmq-sqs.md)
- [Design a payment system](payment-system.md): the outbox relay is exactly this dispatcher

*Reviewed against the Celery 5.6 docs, PostgreSQL 18 `SKIP LOCKED`, and the Amazon SQS developer guide, July 2026.*
