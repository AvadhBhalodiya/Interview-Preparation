---
title: "Message Brokers"
group: "Architecture & Brokers"
order: 2
---

# Message Brokers: Redis vs RabbitMQ vs AWS SQS

> The broker is the transport your workers pull task messages from: Redis is the fast, no-fuss default, RabbitMQ is the full AMQP broker when you need real routing and delivery guarantees, and SQS is the zero-ops managed queue if you already live on AWS.

## What it is
A **broker** is the message transport that Celery and Taskiq use to move task messages from your app (the **producer**) to the **workers** that run them. It is a queue sitting in the middle, and it is deliberately dumb: it moves work, it does not store the results.

Picking a broker settles four things at once - **durability**, **delivery guarantee**, how much **routing** you can do, and how much **operational weight** you carry. Everything below is really about those trade-offs.

> [!KEY] The broker hands a message to a worker and then forgets it. Durability, ordering, and DLQ are just measures of how honestly a given broker keeps that promise when a worker dies mid-task.

The three common choices trade those axes against each other:

| Dimension | Redis | RabbitMQ (AMQP) | AWS SQS |
| --- | --- | --- | --- |
| Delivery guarantee | At-least-once, **acks emulated** by a visibility timeout | At-least-once with **real acks + publisher confirms** | At-least-once, **exactly-once processing on FIFO** (5-min dedup) |
| Persistence / durability | **Weakest** - in-memory, a crash or eviction can drop messages | **Strongest** - durable queues on disk, survive a restart | **Managed** - replicated across AZs by AWS |
| Ordering | **Not guaranteed** - best-effort only | **Per-queue FIFO**, broken by requeues | Best-effort standard, **strict FIFO available** |
| Native DLQ | **No** - emulated at best | **Yes** - dead-letter exchanges | **Yes** - redrive after `maxReceiveCount` |
| Routing | **Emulated** - simple direct/fanout | **Rich** - direct, topic, fanout, priorities | **Basic** - no fanout, no priority |
| Ops overhead | **Trivial** to run, but you run it | **Heaviest** - alarms, quorum queues, clustering | **Zero-ops** - fully managed, no servers |
| When to pick | **Speed and simplicity**, small messages | **Reliability and routing**, losing a task hurts | **On AWS**, want it hands-off |

> [!TIP] All three deliver **at-least-once**, so a task can run twice. Make every task **idempotent** and stop chasing exactly-once - it is cheaper and it is the only thing that actually saves you.

## Key points
- **Why Redis is the "weak" one:** it is an in-memory store, not a broker. Kombu's Redis transport only **emulates** AMQP acks with a visibility timeout, so a crash or an eviction can drop or double-deliver a message. It shines at **rapid transport of small messages** - large payloads congest it.
- **Why RabbitMQ is the safe pick:** a true AMQP broker with **publisher confirms** (the producer learns the broker stored the message) and **real consumer acks** (the broker learns the worker finished). Routing runs through **exchanges** - direct, topic, and fanout - plus priorities and dead-letter exchanges. The price is that you operate it.
- **Why SQS is easy:** **zero servers**. AWS runs it, it auto-scales to effectively infinite throughput, and a DLQ is built in through the **redrive policy** (messages move to it once `maxReceiveCount` is exceeded). You give up priorities, fanout, remote control, and events, and it is poll-based (long polling by default).
- **At-least-once has one caveat.** SQS **FIFO** queues add exactly-once *processing* inside a ~5-minute dedup window and strict per-group ordering, but Celery mostly rides **standard** queues, so assume a task can run twice regardless of broker.
- **Monitoring and remote control are broker features, not Celery ones.** Redis and RabbitMQ support events, `celery inspect`, and remote control. SQS supports **none** of it (no events), so tools like Flower go dark against SQS.
- **The broker is not the result backend.** The **broker** moves work. The **backend** (Redis, a DB, whatever) stores return values and task states. People conflate them because Redis often plays both roles, but they are separate config with separate failure modes.

## Example
```python
from celery import Celery

# The broker URL is what selects the transport. Pick exactly one:
app = Celery("proj", broker="redis://localhost:6379/0")        # Redis
app = Celery("proj", broker="amqp://guest:guest@localhost//")  # RabbitMQ (AMQP)
app = Celery("proj", broker="sqs://")                          # SQS via IAM role

# Redis and SQS only emulate acks with a visibility timeout.
# Keep it comfortably above your longest task or the message redelivers mid-run.
app.conf.broker_transport_options = {"visibility_timeout": 3600}  # seconds
```

Taskiq (~0.12, async-native) wires the broker and result backend explicitly:

```python
from taskiq_aio_pika import AioPikaBroker           # RabbitMQ transport
from taskiq_redis import RedisAsyncResultBackend    # separate result store

# One object owns transport (broker) and outcome storage (backend) separately.
broker = AioPikaBroker("amqp://guest:guest@localhost//").with_result_backend(
    RedisAsyncResultBackend("redis://localhost:6379/0"),
)
```

## Interview Q&A
- **Redis vs RabbitMQ as a broker?** Redis is fast and dead simple, but the transport only **fakes acks** with a visibility timeout and it is memory-bound, so durability is weaker. RabbitMQ is a **true AMQP broker** with durable queues, real acks, publisher confirms, and exchange routing. Reach for RabbitMQ when a lost task is a real problem.
- **Why SQS?** **No broker to run.** It is managed and serverless, auto-scales, and has a DLQ built in. You pay for it with no priority or fanout, no remote control or events, and polling latency.
- **What delivery guarantee do you get?** **At-least-once**, so every task must be idempotent. Do not design for exactly-once, not even on FIFO.
- **Is the broker the same as the result backend?** No. The **broker** queues the work, the **backend** stores the outcome. They are frequently both Redis, but they are distinct systems that fail independently.
- **Can you guarantee ordering?** Not on Redis or standard SQS, both are best-effort. RabbitMQ holds **per-queue FIFO** until a requeue reshuffles it, and only **SQS FIFO** gives strict order, and only within a message group. If order matters, enforce it in your design rather than trusting the broker.
- **What is a dead-letter queue?** A side queue where a message lands after too many failed deliveries, so one poison task stops blocking the rest. RabbitMQ uses **dead-letter exchanges**, SQS uses a **redrive policy** past `maxReceiveCount`, and Redis has **no native DLQ**.

## Gotchas
> [!WARN] The visibility timeout is a **redelivery trap**. Kombu defaults Redis to **1 hour** and SQS to **30 minutes** (AWS caps it at 12 h). If a task, or its ETA/countdown/retry delay, outlives that window, the broker assumes the worker died and **redelivers** it, so it runs again in a loop. Bumping the timeout hurts reliability, so for far-future scheduling use a DB-backed scheduler instead of leaning on the broker.

> [!WARN] Redis is **not a database**. On a crash or an eviction, queued-but-unacked messages are **silently gone**, because the transport only fakes acks. If losing a task actually matters, that alone rules Redis out.

- If one Redis instance is both broker and cache, an eviction policy like `allkeys-lru` can evict **queued task messages** under memory pressure. Give the broker its own instance or DB with `maxmemory-policy noeviction`.
- SQS has **no priorities and no fanout**, so do not architect around features it does not have. An SQS **FIFO queue's DLQ must also be FIFO**, and attaching one can break the strict ordering you chose FIFO for, so weigh dead-lettering against order.
- `celery[sqs]` pulls **boto3** now, not pycurl, so old tutorials that make you compile pycurl are stale. Also avoid the `amqp` result backend on SQS: it creates an unmanaged queue per task and your bill climbs quietly.
- RabbitMQ is only as reliable as your ops. Watch the memory and disk alarms, prefer **quorum queues** for replication (classic mirrored queues were **removed in RabbitMQ 4.0**), and plan clustering before you need it.

## Revise next
- [**Celery architecture**](celery-architecture.md) - producer, broker, worker, and result backend as separate moving parts.
- [**Idempotency in background tasks**](idempotency-background-tasks.md) - dedup keys and safe retries under at-least-once delivery.
- [**Retries and DLQ**](retries-dead-letter-queues.md) - backoff, max retries, and where poison messages finally land.
- **Kombu transports and `broker_transport_options`** - `visibility_timeout`, polling, and the per-broker tuning knobs.

*Reviewed against Celery 5.6, July 2026.*
