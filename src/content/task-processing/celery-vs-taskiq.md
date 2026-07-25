---
title: "Celery vs Taskiq"
group: "Scheduling & Frameworks"
order: 6
---

# Celery vs Taskiq

> Celery is the mature, sync-first task queue you reach for on Django and established stacks. Taskiq is the async-native one built for FastAPI, with real type hints and FastAPI-style dependency injection.

## What it is
- **Celery** is the long-established Python distributed task queue: a broker, one or more workers, and an optional result backend. Its default worker pool is **prefork** (multiprocessing), so each child process runs one task to completion with no event loop. That is what "sync-first" means, and it carries well over a decade of production mileage.
- **Taskiq** is a newer **async-native** task manager for asyncio, openly modeled on Celery and Dramatiq but built so `async def` tasks run on the event loop. It is typed throughout and borrows FastAPI's dependency injection. Its own docs are blunt: it is not a drop-in Celery replacement and won't serve a purely synchronous codebase.

> [!KEY] Both are the same three pieces - **broker + worker + result backend** - and both are **at-least-once**. The only real fork is the engine underneath: Celery's **process pool** vs Taskiq's **event loop**, and every other difference falls out of that.

They line up feature for feature, but that sync-vs-async origin drives the rest:

| Dimension | **Celery** | **Taskiq** |
| --- | --- | --- |
| Engine | **sync-first** prefork processes | **async-native** asyncio loop |
| Enqueue | **sync** `task.delay()` | **`await`** `task.kiq()` |
| Typing | **minimal**, untyped call API | **fully type-hinted** |
| Dependency injection | **none** built in | **`TaskiqDepends`** (FastAPI-style) |
| Scheduler | **Beat** | **`TaskiqScheduler`** |
| Brokers | Redis, RabbitMQ, **SQS** | Redis, RabbitMQ, NATS, **Kafka** |
| Result backend | **many** (Redis, DB, RPC, S3) | Redis, NATS (**async** clients) |
| Ecosystem | **deep** (Flower, plugins, SO) | **young**, thinner tooling |
| Reach for | **Django** / sync / CPU-bound | **FastAPI** / aiohttp / async |

## Key points
- **Concurrency model.** Celery's prefork pool forks OS processes and runs one task per process at a time - great for CPU-bound work, but no event loop. Taskiq runs tasks on the asyncio loop, so one worker keeps thousands of IO-bound `await`s in flight. Celery offers eventlet/gevent pools for IO concurrency, but that is greenlet monkeypatching, **not asyncio**.
- **Async is the real dividing line.** Celery 5.6 still ships **no native asyncio support**. The maintainers cite time and funding, not ideology, and the workarounds (per-task `asyncio.run()` wrappers, third-party pools like celery-aio-pool) are fiddly or unmaintained. That friction is the reason Taskiq exists.
- **Typing and DI.** Taskiq is fully type-hinted and ships FastAPI-style injection: declare `Annotated[Thing, TaskiqDepends(provider)]` and the same provider that powers your routes, a DB session or an httpx client, resolves inside the task, with generator dependencies handling setup and teardown. Celery has neither.
- **Enqueue API.** Celery's `task.delay(...)` is a thin shortcut over `task.apply_async(...)`, where the real options live (countdown, eta, retry, routing). Taskiq uses `await task.kiq(...)` - the `await` is why it cannot be fired from a plain sync process.
- **The broker decides durability, not the framework.** All three common brokers are at-least-once, and the differences are operational:

| Broker | Ack model | Ordering | Notes |
| --- | --- | --- | --- |
| **RabbitMQ** (AMQP) | **native acks** + publisher confirms | **per-queue FIFO** | **strongest** guarantees, quorum queues in 5.6 |
| **Redis** | **no native ack**, faked via visibility timeout | **best-effort** | **fast** and simple, tune to avoid loss |
| **SQS** (AWS) | **managed**, delete-to-ack + DLQ redrive | **standard best-effort / FIFO strict** | **scalable**, no remote-control or fanout |

- **SQS has no explicit ack.** A received message is hidden for the **visibility timeout** (default 30s, up to 12h). Delete it before the timer expires or it is redelivered. After `maxReceiveCount` deliveries (the **redrive policy**, default 10) it moves to a **dead-letter queue** for inspection.

> [!TIP] Taskiq accepts **sync** task bodies too, so "async-native" describes the engine, not a ban on sync code. The hard wall is the **call site**: `await task.kiq()` needs a running loop.

## Example
```python
# Taskiq: an async task with FastAPI-style dependency injection
from typing import Annotated
from taskiq import TaskiqDepends
from taskiq_redis import RedisStreamBroker, RedisAsyncResultBackend

# RedisStreamBroker acknowledges messages, so work from a crashed worker is
# redelivered. The ListQueue and PubSub brokers don't ack and can drop
# in-flight tasks, so pick the broker that matches the durability you need.
broker = RedisStreamBroker(url="redis://localhost:6379").with_result_backend(
    RedisAsyncResultBackend(redis_url="redis://localhost:6379"),
)

async def get_db() -> "Database":          # the same provider your FastAPI routes use
    ...

@broker.task
async def notify(user_id: int, db: Annotated["Database", TaskiqDepends(get_db)]) -> None:
    user = await db.get_user(user_id)      # a real await, no thread offload needed
    await send_email(user.email)

# enqueuing is itself async, which is why Taskiq can't serve a sync codebase
task = await notify.kiq(42)                # Celery's equivalent call is .delay(42)

# start the worker:  taskiq worker module:broker
```

## Interview Q&A
- **Celery vs Taskiq in one line?** Celery is mature, sync-first, huge ecosystem. Taskiq is async-native, typed, with FastAPI-style DI.
- **When would you pick Taskiq?** A fully async codebase (FastAPI, aiohttp) where you want real `async def` tasks and want to reuse the web app's dependencies inside workers.
- **When do you stay on Celery?** Django or any sync/CPU-bound stack, or when you need the maturity: Beat, Flower, SQS, and a known fix for every edge case.
- **Why can't Celery just run async tasks?** Prefork has no event loop and 5.6 ships no native asyncio support, so an `async def` task does not run concurrently and needs a wrapper. That gap is what Taskiq fills.
- **How do the brokers differ?** RabbitMQ gives the strongest delivery (acks, confirms, durable queues), Redis is fast but fakes acks with a visibility timeout, and SQS is managed and scalable but drops remote-control and fanout. All are at-least-once.

## Gotchas
> [!WARN] A blocking or sync call inside a Taskiq `async` task stalls the **whole event loop** and every other task on that worker. Push CPU-bound or blocking IO to a thread or process executor. Same trap as blocking inside an async FastAPI route.

> [!WARN] Both frameworks are **at-least-once** - a task can and will run twice. Idempotency and retry design are on you either way. Neither one saves you from a duplicate.

- Don't expect `async def` to help on Celery prefork: you get a coroutine that never runs, or a per-task `asyncio.run()` with zero concurrency gain. Real asyncio on Celery means adopting a third-party pool and owning its maintenance risk.
- Taskiq broker choice decides durability. `RedisListQueueBroker` and `RedisPubSubBroker` don't acknowledge messages, so a worker crash mid-task loses the work. Use `RedisStreamBroker` or the aio-pika (RabbitMQ) broker when you can't afford to drop tasks.
- Enqueuing in Taskiq is `await`-only - you can't fire a task from plain sync code without an event loop. Fine for FastAPI, a wall if part of your system is synchronous.
- Run exactly **one** scheduler instance (Beat or `TaskiqScheduler`) or every scheduled task fires twice.

## Revise next
- [Celery architecture](celery-architecture.md) (broker, worker pools, result backend)
- [FastAPI async endpoints](../fastapi/async-endpoints.md) and [dependency injection](../fastapi/dependency-injection-depends.md)
- [Idempotency](idempotency-background-tasks.md) and [retries](retries-dead-letter-queues.md) under at-least-once delivery

*Reviewed against Celery 5.6 / Taskiq 0.12, July 2026.*
