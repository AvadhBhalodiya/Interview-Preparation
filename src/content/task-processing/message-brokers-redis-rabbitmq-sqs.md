---
title: "Message Brokers"
group: "Architecture & Brokers"
order: 2
updated: "30 July 2026"
---

# Message Brokers: Redis vs RabbitMQ vs AWS SQS

> Understand how Redis, RabbitMQ, and Amazon SQS behave as message brokers and how to select the right broker for production task processing.
>
> **Relevant current documentation:** Redis Open Source 8.8, RabbitMQ 4.3.4, Celery 5.6.x

## In short

- A broker moves non-immediate work out of the request-response path and provides storage, decoupling, buffering, retry, and acknowledgment — it is not the worker.
- Redis is an in-memory data platform with messaging features: Lists give a simple FIFO queue, Pub/Sub is fire-and-forget at-most-once fan-out, Streams give a durable log with consumer groups, acknowledgments, and replay.
- RabbitMQ is a dedicated broker: exchanges (direct, topic, fanout, headers) plus bindings for routing, manual ACK/NACK, publisher confirms, prefetch, dead-letter exchanges, and quorum queues.
- Amazon SQS is a fully managed poll-based queue: visibility timeout (30 seconds default, 12 hours maximum), at-least-once Standard queues, FIFO ordering within a `MessageGroupId`, and a DLQ driven by `maxReceiveCount`.
- Delivery is at-most-once, at-least-once, or exactly-once; production task processing runs at-least-once, so every consumer must be idempotent.
- Acknowledge only after the work is committed (`Receive -> Process -> Commit -> ACK/Delete`), and bound every retry policy with backoff, jitter, a maximum attempt count, and a dead-letter queue.
- Choose on operating model, not benchmark: Redis if you already run it and tasks are short, RabbitMQ if routing and broker control are core requirements, SQS if you are AWS-native and want no broker administration.

```mermaid
flowchart LR
    subgraph REDIS[Redis]
        P1[Producer] --> Q1[[Redis queue]]
        Q1 --> W1[Worker]
    end
    subgraph RABBIT[RabbitMQ]
        P2[Publisher] --> EX{Exchange}
        EX --> BN[Binding]
        BN --> Q2[[Queue]]
        Q2 --> C2[Consumer]
    end
    subgraph AWSSQS[SQS]
        P3[Producer] --> Q3[[SQS queue]]
        C3[Polling consumer] --> Q3
    end
```

**Interview answer:** Redis when it is already in the stack and the tasks are simple and short — very low latency and one technology for broker and result backend, but reliable queue behavior depends on the structure chosen and Pub/Sub is not durable. RabbitMQ when messaging itself is a core capability: exchange-based routing, publisher confirms, manual acknowledgments, DLX retry topologies, and quorum queues, at the cost of operating a broker. SQS when the system is AWS-native and bursty and managed durability and scaling matter more than routing, accepting polling latency, basic routing, and at-least-once delivery.

**Gotcha:** Assuming a reliable broker gives exactly-once processing. A broker can confirm that a message was delivered and acknowledged, but a worker that crashes after committing the database change and before the ACK will receive the same message again — so at-least-once delivery plus idempotent consumers, not a broker feature, is what stops a payment being charged twice.

---

# 1. Why Message Brokers Are Needed

In a synchronous application, the client waits while the server completes every operation.

For example, consider an API that performs all of these operations during a single request:

1. Creates an order.
2. Generates an invoice.
3. Sends an email.
4. Updates analytics.
5. Notifies an external system.

```mermaid
flowchart TD
    C[Client] --> A[API Server]
    A --> W1[Create order]
    A --> W2[Generate invoice]
    A --> W3[Send email]
    A --> W4[Update analytics]
    A --> W5[Call external service]
    W1 --> R[Response]
    W2 --> R
    W3 --> R
    W4 --> R
    W5 --> R
```

This design creates several problems:

- The API response becomes slow.
- A failure in a secondary operation can fail the complete request.
- Sudden traffic can overload downstream services.
- Long-running work consumes web-server processes or threads.
- The producer and consumer become tightly coupled.

A message broker moves non-immediate work outside the request-response path.

```mermaid
flowchart LR
    C[Client] --> API[API Server]
    API --> DB[(Database)]
    API --> B[(Message Broker)]
    API --> C

    B --> W1[Email Worker]
    B --> W2[Invoice Worker]
    B --> W3[Analytics Worker]
```

The API stores the primary business data, publishes a message, and returns quickly. Background workers process the message independently.

## What the broker provides

A message broker commonly provides:

- Temporary message storage
- Producer-consumer decoupling
- Load buffering
- Worker distribution
- Retry or redelivery behavior
- Message acknowledgment
- Routing
- Failure isolation
- Horizontal scaling

A broker is not the worker. It transports and stores messages until a worker can process them.

---

# 2. Core Message-Broker Architecture

A basic asynchronous system contains four important components.

```mermaid
flowchart LR
    P[Producer] -->|Publish message| B[(Broker / Queue)]
    B -->|Deliver or return message| W[Worker / Consumer]
    W -->|Read or write business data| DB[(Database)]
    W -->|Store task state if required| RB[(Result Backend)]
```

## 2.1 Producer

The producer creates a message.

Examples:

- Django API
- FastAPI service
- Scheduled job
- Another microservice
- Event listener

```python
generate_invoice.delay(invoice_id=4821)
```

The producer should normally send an identifier and small metadata rather than a complete database record or large file.

---

## 2.2 Broker

The broker accepts and stores the message until it can be processed.

Examples:

- Redis
- RabbitMQ
- Amazon SQS

The broker controls how messages are delivered, acknowledged, retried, routed, retained, or removed.

---

## 2.3 Worker or Consumer

A worker receives a message and performs the actual task.

```python
@celery_app.task
def generate_invoice(invoice_id: int) -> None:
    invoice = Invoice.objects.get(id=invoice_id)
    create_invoice_pdf(invoice)
```

Multiple workers can consume from the same queue. This is called the **competing consumers** pattern. Each task is normally processed by one worker.

---

## 2.4 Result Backend

A result backend stores task state or return values.

Possible states include:

```mermaid
flowchart LR
    P[PENDING] --> S[STARTED]
    S --> OK[SUCCESS]
    S --> F[FAILURE]
    S --> R[RETRY]
```

The result backend and broker are separate concepts.

For example:

```python
broker_url = "amqp://guest:guest@rabbitmq:5672//"
result_backend = "redis://redis:6379/1"
```

Here:

- RabbitMQ transports tasks.
- Redis stores task results.

A result backend is unnecessary when the application never checks task status or return values.

---

# 3. Important Messaging Concepts

Before comparing the brokers, understand the dimensions that matter in production.

## 3.1 Push vs Poll

### Push-based delivery

The broker sends messages to connected consumers. RabbitMQ commonly uses this model.

Benefits:

- Low delivery latency
- Efficient for continuously connected workers
- No repeated empty receive requests

### Poll-based delivery

Consumers request available messages with `ReceiveMessage`. Amazon SQS uses this model.

SQS supports long polling, where the receive request waits for messages instead of immediately returning an empty response.

Redis clients may use blocking operations, so practical behavior can appear push-like even though the client is waiting on a Redis command.

---

## 3.2 Acknowledgment

An acknowledgment tells the broker that processing succeeded, after which the broker removes or completes the message.

When the worker fails before acknowledgment, the broker or transport can make the message available again.

---

## 3.3 Visibility Timeout

A visibility timeout temporarily hides a received message from other workers.

This concept is central to Amazon SQS and is also implemented by Celery's Redis and SQS transports.

```mermaid
sequenceDiagram
    participant Q as Queue
    participant W1 as Worker 1
    participant W2 as Worker 2

    W1->>Q: Receive message
    Q-->>W1: Message
    Note over Q: Message becomes invisible
    W1--xW1: Worker crashes
    Note over Q: Visibility timeout expires
    W2->>Q: Receive message
    Q-->>W2: Same message
```

The visibility timeout must be longer than normal task execution time, or the same message may be processed concurrently by another worker.

---

## 3.4 Durability

Durability describes whether messages survive failures such as:

- Broker restart
- Machine failure
- Process termination
- Network interruption
- Availability-zone failure

Durability is not enabled by selecting a durable queue alone. Depending on the broker, the message itself, queue type, replication, persistence settings, acknowledgment mode, and publisher confirmation can all affect data safety.

---

## 3.5 Routing

Routing determines where a message goes. Simple routing is `Producer -> Queue -> Worker`; advanced routing sends a message through an intermediate component that selects queues by pattern.

RabbitMQ provides the richest native routing model through exchanges, routing keys, and bindings.

---

## 3.6 Backpressure

Backpressure occurs when producers create messages faster than workers can process them: a producer rate of 5,000 messages/sec against a consumer rate of 3,000 messages/sec grows the backlog by 2,000 messages/sec.

A broker buffers the difference, but no queue should be allowed to grow forever. Monitor queue depth and the age of the oldest message.

---

## 3.7 Delivery Is Not the Same as Processing

A broker can confirm that a message was delivered or acknowledged. It cannot automatically guarantee that every external side effect occurred exactly once.

For example:

```text
1. Worker charges payment.
2. Worker crashes before ACK.
3. Broker redelivers message.
4. Worker charges payment again.
```

This is why idempotency is required even when the broker is described as reliable.

---

# 4. Redis as a Message Broker

Redis is primarily an in-memory data platform, but it can also support messaging and job queues.

It is popular as a Celery broker because it is:

- Easy to install
- Fast
- Familiar to many backend teams
- Useful for both broker and result-backend roles
- Convenient for local development and small-to-medium systems

However, the phrase **Redis messaging** can refer to different Redis data structures with very different behavior.

---

## 4.1 Redis Lists

Redis Lists can implement a simple queue: the producer pushes with `LPUSH`/`RPUSH` and the worker pops with `BRPOP`/`BLPOP`.

A basic queue may look like this:

```python
import json
import redis

client = redis.Redis(host="localhost", port=6379, decode_responses=True)

job = {
    "task": "generate_invoice",
    "invoice_id": 4821,
}

client.lpush("jobs:invoice", json.dumps(job))
```

A worker can block until a message becomes available:

```python
while True:
    _, raw_message = client.brpop("jobs:invoice")
    message = json.loads(raw_message)
    generate_invoice(message["invoice_id"])
```

### Problem with a basic pop operation

A normal pop removes the message before processing, so a worker that crashes after popping loses the message.

A reliable Redis queue therefore requires a processing list, acknowledgment logic, or a library such as Celery/Kombu that implements redelivery behavior.

```mermaid
flowchart LR
    P[Pending List] -->|Atomic claim| PR[Processing List]
    PR -->|Successful processing| D[Remove job]
    PR -->|Worker timeout/crash| P
```

Do not implement a production-grade reliable queue with only `LPUSH` and `BRPOP` unless message loss is acceptable.

---

## 4.2 Redis Pub/Sub

Redis Pub/Sub broadcasts a message to currently connected subscribers.

```mermaid
flowchart LR
    P[Publisher] --> C[Redis Channel]
    C --> S1[Subscriber 1]
    C --> S2[Subscriber 2]
    C --> S3[Subscriber 3]
```

Redis Pub/Sub is **fire-and-forget**:

- Messages are not persisted for offline subscribers.
- There is no replay history.
- There is no consumer acknowledgment.
- A disconnected subscriber misses messages.
- Delivery is at-most-once.

### Good Pub/Sub use cases

- Live notifications
- WebSocket fan-out
- Cache invalidation
- Presence updates
- Non-critical real-time signals

### Poor Pub/Sub use cases

- Payment processing
- Invoice generation
- Durable background jobs
- Tasks that must be retried
- Work that must survive worker downtime

Redis Pub/Sub should not be treated as a durable task queue.

---

## 4.3 Redis Streams

Redis Streams provide a durable append-only event log.

```mermaid
flowchart LR
    P[Producer] -->|XADD| S[(Redis Stream)]
    S --> G1[Consumer Group A]
    S --> G2[Consumer Group B]
    G1 --> C1[Consumer A1]
    G1 --> C2[Consumer A2]
```

Important Redis Streams features include:

- Ordered stream entries
- Message IDs
- Consumer groups
- Acknowledgments
- Pending entries
- Message replay
- Retention or trimming
- Recovery of unacknowledged messages
- At-least-once processing patterns

Example:

```python
from redis import Redis

redis_client = Redis(decode_responses=True)

redis_client.xadd(
    "orders",
    {
        "event_type": "order.created",
        "order_id": "ORD-4821",
    },
)
```

Create a consumer group:

```python
redis_client.xgroup_create(
    name="orders",
    groupname="billing-service",
    id="0",
    mkstream=True,
)
```

Read and acknowledge:

```python
messages = redis_client.xreadgroup(
    groupname="billing-service",
    consumername="billing-worker-1",
    streams={"orders": ">"},
    count=10,
    block=5_000,
)

for _, entries in messages:
    for message_id, fields in entries:
        process_order(fields["order_id"])
        redis_client.xack("orders", "billing-service", message_id)
```

Redis Streams are more appropriate than Pub/Sub when messages need persistence, acknowledgment, or replay.

---

## 4.4 Redis with Celery

Celery hides most low-level Redis queue behavior.

```python
from celery import Celery

celery_app = Celery(
    "application",
    broker="redis://redis:6379/0",
    backend="redis://redis:6379/1",
)
```

Celery's Redis transport uses a visibility-timeout model. If a worker does not acknowledge a task before the timeout, the task can be redelivered.

```python
celery_app.conf.broker_transport_options = {
    "visibility_timeout": 3_600,
}
```

As of Celery 5.6, the documented default Redis visibility timeout is one hour.

### Important Redis/Celery caveat

A task with a long `countdown` or ETA can exceed the visibility timeout and be redelivered repeatedly.

```python
send_report.apply_async(
    args=[report_id],
    countdown=7_200,
)
```

If the visibility timeout is one hour and the task is delayed for two hours, duplicate delivery loops can occur.

For distant scheduling, use a database-backed scheduler or dedicated scheduling service rather than keeping messages reserved in the broker for a long period.

---

## 4.5 Redis Persistence

Redis supports different levels of on-disk persistence:

- RDB snapshots
- Append-only file (AOF)
- Both RDB and AOF
- No persistence

Persistence improves recovery but does not automatically provide the same messaging guarantees as a dedicated broker.

When Redis is used as a production task broker:

- Configure persistence according to acceptable data-loss risk.
- Configure replication or managed high availability.
- Avoid key eviction for broker data.
- Do not mix broker queues with an aggressively evicting cache.
- Set memory alerts.
- Test broker restart and failover.

A common design is to use separate Redis instances or logical services for:

```text
Redis A: application cache with eviction
Redis B: Celery broker with no eviction
Redis C: optional task result backend
```

Using a single Redis instance for all three roles creates a larger failure domain.

---

## 4.6 Redis Strengths

- Very low latency for simple operations
- Simple local setup
- Can also serve as a result backend
- Familiar data structures
- Useful for lightweight queues and moderate event streams
- Managed Redis services reduce some operational work

---

## 4.7 Redis Limitations

- Redis is not only a broker; messaging reliability depends on the selected structure and configuration.
- Pub/Sub is non-durable.
- Memory capacity and eviction policies require attention.
- Broker and cache workloads can compete for memory.
- Long-running or long-delay Celery tasks require careful visibility-timeout configuration.
- Self-managed high availability requires operational knowledge.

---

## 4.8 When Redis Is a Good Choice

Use Redis when:

- Redis already exists in the application stack.
- Tasks are simple and relatively short.
- Very low queue latency is useful.
- The team wants quick local development.
- The system has moderate reliability requirements.
- Celery is used and Redis's operational trade-offs are understood.
- Redis Streams are sufficient for a moderate event-processing workload.
- A single technology for broker and result storage simplifies an early-stage system.

Example workloads:

- Thumbnail generation
- Email sending
- Cache warming
- Search-index refresh
- Short report generation
- Non-financial notifications
- Development and staging environments

---

# 5. RabbitMQ as a Message Broker

RabbitMQ is a dedicated message and streaming broker.

It is designed around messaging concepts such as:

- Publishers
- Exchanges
- Routing keys
- Bindings
- Queues
- Consumers
- Acknowledgments
- Publisher confirms
- Dead-letter exchanges
- Queue policies
- Quorum queues

RabbitMQ is normally chosen when messaging is an important part of the system rather than a secondary use of an existing datastore.

---

## 5.1 RabbitMQ Message Flow

In RabbitMQ, a producer normally publishes to an exchange rather than directly selecting a consumer.

```mermaid
flowchart LR
    P[Publisher] -->|Message + routing key| E{Exchange}
    E -->|Binding rule| Q1[Queue A]
    E -->|Binding rule| Q2[Queue B]
    Q1 --> C1[Consumer A]
    Q2 --> C2[Consumer B]
```

The exchange routes the message to one or more queues.

The queue stores the message.

A consumer receives the message from the queue.

---

## 5.2 Exchange Types

### Direct exchange

A direct exchange uses an exact routing-key match.

```mermaid
flowchart LR
    P[Publisher] --> E{Direct Exchange}
    E -->|routing key = email| Q1[Email Queue]
    E -->|routing key = invoice| Q2[Invoice Queue]
```

Use it for:

- Task type routing
- Service-specific commands
- Exact category matching

---

### Topic exchange

A topic exchange uses routing patterns.

```text
order.created
order.cancelled
payment.completed
payment.failed
```

Bindings may use wildcards:

```text
order.*       -> Order audit queue
payment.*     -> Payment analytics queue
*.failed      -> Failure alert queue
```

```mermaid
flowchart LR
    P[Publisher] --> E{Topic Exchange}
    E -->|order.*| O[Order Queue]
    E -->|*.failed| F[Failure Queue]
    E -->|payment.*| PA[Payment Analytics Queue]
```

Use it for:

- Domain events
- Event-driven microservices
- Selective subscriptions
- Flexible routing without producer-consumer coupling

---

### Fanout exchange

A fanout exchange sends a copy to every bound queue.

```mermaid
flowchart LR
    P[Publisher] --> E{Fanout Exchange}
    E --> A[Audit Queue]
    E --> N[Notification Queue]
    E --> M[Metrics Queue]
```

Use it for:

- Broadcasting
- Multiple independent downstream consumers
- System-wide notifications
- Event fan-out

---

### Headers exchange

A headers exchange routes messages using header values rather than a routing-key string.

Use it when routing depends on several metadata fields, although topic exchanges are usually simpler for most applications.

---

## 5.3 Consumer Acknowledgments

RabbitMQ can use automatic or manual acknowledgment.

### Automatic acknowledgment

RabbitMQ considers the message handled as soon as it sends it to the consumer.

This offers high throughput but can lose work when the consumer crashes after receiving the message.

### Manual acknowledgment

The consumer acknowledges only after successful processing.

```mermaid
sequenceDiagram
    participant P as Publisher
    participant R as RabbitMQ
    participant C as Consumer

    P->>R: Publish message
    R->>C: Deliver message
    C->>C: Process task
    C->>R: basic.ack
    R->>R: Remove message
```

Manual acknowledgment is normally preferred for important work.

If the connection or consumer fails before acknowledgment, RabbitMQ can redeliver the message.

---

## 5.4 Negative Acknowledgment

A consumer can reject a message.

Conceptually:

```text
ACK                 -> processing succeeded
NACK + requeue      -> retry using the queue
NACK + no requeue   -> drop or dead-letter
```

Avoid immediate infinite requeue loops.

```mermaid
flowchart TD
    A[Message fails] --> B[Requeue immediately]
    B --> C[Same worker receives it again]
    C --> D[CPU and broker resources are consumed continuously]
```

Use delayed retries, a delivery limit, or dead-letter routing instead.

---

## 5.5 Publisher Confirms

Consumer acknowledgments protect the consumer side.

Publisher confirms protect the producer side.

```mermaid
sequenceDiagram
    participant P as Publisher
    participant R as RabbitMQ

    P->>R: Publish message
    R->>R: Accept/store/route as configured
    R-->>P: Publisher confirm
```

Without publisher confirms, a producer may not know whether a message was accepted before a connection failed.

Even with confirms, duplicates can occur:

```text
1. RabbitMQ accepts message.
2. RabbitMQ sends confirmation.
3. Network fails before producer receives confirmation.
4. Producer republishes.
5. Consumer may receive duplicate.
```

Consumers must still be idempotent.

---

## 5.6 Durable and Persistent Messages

For important messages, commonly combine:

- Durable queue
- Persistent messages
- Publisher confirms
- Manual consumer acknowledgments
- Replicated queue where high availability is needed

A durable queue alone does not guarantee message safety. A complete reliability design is required.

---

## 5.7 Classic Queues and Quorum Queues

### Classic queue

A classic queue is useful for general workloads where replication or quorum-based data safety is not required.

### Quorum queue

A quorum queue is:

- Durable
- Replicated
- Based on the Raft consensus algorithm
- Designed for data safety
- Suitable for highly available task queues
- The preferred RabbitMQ queue type when a replicated queue is required

```mermaid
flowchart LR
    P[Publisher] --> L[Queue Leader]
    L --> R1[Replica 1]
    L --> R2[Replica 2]
    L --> C[Consumer]
```

A majority of replicas must remain available for the quorum queue to continue safely.

RabbitMQ recommends odd cluster sizes such as three or five nodes for consensus-based features.

RabbitMQ 4.3 documentation identifies 4.3.4 as the current release at the time this guide was verified.

---

## 5.8 RabbitMQ Dead-Letter Exchanges

A dead-letter exchange receives messages that cannot continue through the normal processing flow.

A message can be dead-lettered because:

- The consumer rejects it without requeue.
- The message expires.
- A queue length limit is exceeded.
- A quorum queue delivery limit is exceeded.

```mermaid
flowchart LR
    Q[Main Queue] --> W[Worker]
    W -->|Success: ACK| DONE[Completed]
    W -->|Permanent failure: NACK no requeue| DLX{Dead-Letter Exchange}
    DLX --> DLQ[Dead-Letter Queue]
```

RabbitMQ calls the routing component a **dead-letter exchange**. The final queue is often called a **dead-letter queue**.

RabbitMQ 4.x quorum queues support delivery limits and can provide safer at-least-once dead-letter transfer when configured appropriately.

---

## 5.9 Prefetch and Fair Distribution

Prefetch limits the number of unacknowledged messages RabbitMQ sends to a consumer. `prefetch = 1` means a consumer receives one unacknowledged message at a time.

Low prefetch:

- Better fairness for long tasks
- Lower per-worker buffering
- May reduce throughput for short tasks

High prefetch:

- Better throughput for short tasks
- More work reserved by each consumer
- Can create uneven distribution
- Increases redelivery volume when a worker fails

Choose prefetch based on task duration and variability.

---

## 5.10 RabbitMQ Strengths

- Purpose-built messaging broker
- Manual acknowledgment
- Publisher confirms
- Message TTL and queue policies
- Priority support
- Quorum queues for replicated, highly available workloads
- Strong management UI and monitoring ecosystem
- Multiple messaging protocols

---

## 5.11 RabbitMQ Limitations

- Requires broker deployment and maintenance unless using a managed service.
- Clustering, upgrades, storage, networking, and partitions require expertise.
- Incorrect prefetch or acknowledgment settings can create reliability problems.
- Rich features add configuration complexity.
- Large backlogs must be planned carefully.
- Cross-region architecture requires deliberate design.

---

## 5.12 When RabbitMQ Is a Good Choice

Use RabbitMQ when:

- Complex routing is required.
- Several queues receive different subsets of messages.
- Low delivery latency matters.
- The application needs acknowledgments and publisher confirms.
- Broker-level dead-lettering and retry topology are important.
- Messaging is a core system capability.
- The team can operate RabbitMQ or use a managed RabbitMQ service.
- Celery worker control and event monitoring are required.
- On-premises or cloud-neutral deployment is important.

Example workloads:

- Order workflow commands
- Payment-state events
- Multi-service business processes
- Email, billing, and analytics routing
- Priority task queues
- Enterprise integration
- On-premises task-processing platforms

---

# 6. Amazon SQS as a Message Broker

Amazon Simple Queue Service is a fully managed queue service.

The application does not manage queue servers, disks, replication, or broker clusters.

```mermaid
flowchart LR
    P[Producer] -->|SendMessage| SQS[(Amazon SQS)]
    W1[Worker 1] -->|ReceiveMessage| SQS
    W2[Worker 2] -->|ReceiveMessage| SQS
    W3[Worker 3] -->|ReceiveMessage| SQS
```

SQS is attractive when:

- The application already runs on AWS.
- Operational simplicity is more important than advanced routing.
- Automatic scaling is required.
- Queue traffic is bursty.
- AWS IAM and CloudWatch integration are useful.

---

## 6.1 SQS Is Pull-Based

Workers poll SQS using `ReceiveMessage`.

### Short polling

Short polling returns immediately, possibly with no messages.

### Long polling

Long polling waits for a message for up to 20 seconds.

```python
response = sqs.receive_message(
    QueueUrl=queue_url,
    MaxNumberOfMessages=10,
    WaitTimeSeconds=20,
)
```

Long polling:

- Reduces empty responses
- Reduces unnecessary API calls
- Usually lowers cost
- Improves worker efficiency

---

## 6.2 SQS Message Lifecycle

```mermaid
sequenceDiagram
    participant P as Producer
    participant Q as SQS
    participant W as Worker

    P->>Q: SendMessage
    W->>Q: ReceiveMessage
    Q-->>W: Message + receipt handle
    Note over Q: Message becomes invisible
    W->>W: Process task
    W->>Q: DeleteMessage
    Q->>Q: Permanently remove message
```

Receiving a message does not delete it. The message stays in SQS, becomes invisible for the visibility-timeout period, and is removed only when the worker calls `DeleteMessage`.

If the worker does not delete it, the message becomes visible again.

---

## 6.3 Visibility Timeout

The AWS queue default is 30 seconds. The documented allowed range is 0 seconds minimum to 12 hours maximum.

The timeout should cover normal processing time plus a safety margin.

Example:

```text
Typical task time:       40 seconds
P99 task time:           85 seconds
Initial visibility:     120 seconds
Heartbeat extension:     enabled for long tasks
```

For variable-length tasks, the worker can call `ChangeMessageVisibility` periodically.

```mermaid
sequenceDiagram
    participant Q as SQS
    participant W as Worker

    Q->>W: Deliver message
    Note over Q: Invisible for 120 seconds
    W->>Q: Extend visibility
    Note over Q: Invisible for longer
    W->>Q: Delete after success
```

A timeout that is too short can cause concurrent duplicate processing.

A timeout that is too long delays retry after a worker crashes.

---

## 6.4 Standard Queues

SQS Standard queues provide:

- Very high, nearly unlimited API throughput
- At-least-once delivery
- Best-effort ordering
- Automatic scaling

A message can occasionally be delivered more than once.

Messages may not always arrive in the exact sending order.

Use Standard queues when:

- Maximum throughput is important.
- Strict ordering is unnecessary.
- Consumers are idempotent.
- Work can be processed independently.

---

## 6.5 FIFO Queues

FIFO means First-In-First-Out.

SQS FIFO queues support ordered processing within a message group. Messages with the same `MessageGroupId` are processed sequentially.

```text
Group: customer-101
    payment-1
    payment-2
    payment-3
```

While `payment-1` is in flight, later messages in `customer-101` are not released.

Different groups can be processed concurrently.

```mermaid
flowchart TB
    Q[(FIFO Queue)]
    Q --> G1[Group: customer-101]
    Q --> G2[Group: customer-202]
    Q --> G3[Group: customer-303]

    G1 --> W1[Sequential]
    G2 --> W2[Sequential]
    G3 --> W3[Sequential]
```

For higher throughput, distribute work across many group IDs rather than sending everything under one group.

FIFO queues also provide producer-side deduplication using:

- `MessageDeduplicationId`, or
- Content-based deduplication

This deduplication does not remove the need for idempotent business processing.

---

## 6.6 Current SQS Limits Relevant to Task Processing

As documented when this guide was verified:

| Property | SQS behavior |
|---|---|
| Maximum message size | 1 MiB |
| Messages per batch request | Up to 10 |
| Default retention | 4 days |
| Retention range | 1 minute to 14 days |
| Default queue visibility timeout | 30 seconds |
| Maximum visibility timeout | 12 hours |
| Maximum message delay | 15 minutes |
| Maximum long-poll wait | 20 seconds |
| Standard queue delivery | At least once |
| Standard ordering | Best effort |
| FIFO ordering | Strict within a message group |

For large payloads, store the data in Amazon S3 and send only the object key and metadata through SQS.

```json
{
  "message_id": "d72ad27a-6089-4d60-b6ac-84e87d45d2f5",
  "task_type": "document.ocr",
  "s3_bucket": "incoming-documents",
  "s3_key": "claims/2026/4821/menu.pdf"
}
```

---

## 6.7 SQS Dead-Letter Queues

An SQS queue can be configured with a redrive policy.

After a message is received too many times, SQS moves it to a dead-letter queue.

```mermaid
flowchart LR
    Q[Source Queue] --> W[Worker]
    W -->|Success: DeleteMessage| D[Completed]
    W -->|Failure / no delete| Q
    Q -->|Receive count exceeds limit| DLQ[Dead-Letter Queue]
```

The important setting is `maxReceiveCount`. With `maxReceiveCount = 5`, a permanently failing message is isolated after five receives rather than retrying forever.

A DLQ should have:

- An alarm
- A documented investigation process
- Message retention long enough for diagnosis
- A redrive or replay procedure
- Access controls
- Correlation IDs and failure metadata

---

## 6.8 SQS Delay Queues

SQS can delay message availability for up to 15 minutes.

```python
sqs.send_message(
    QueueUrl=queue_url,
    MessageBody=message_body,
    DelaySeconds=300,
)
```

For scheduling hours, days, or months in the future, use a scheduler rather than retaining a delayed task inside a worker queue.

---

## 6.9 SQS with Other AWS Services

SQS integrates naturally with:

- AWS Lambda
- Amazon EC2
- Amazon ECS
- Amazon EKS
- Amazon SNS
- Amazon EventBridge
- AWS Step Functions
- Amazon S3
- Amazon CloudWatch
- AWS IAM
- AWS Key Management Service

A common fan-out pattern uses SNS with multiple SQS queues.

```mermaid
flowchart LR
    P[Producer] --> SNS{SNS Topic}
    SNS --> Q1[SQS: Billing]
    SNS --> Q2[SQS: Analytics]
    SNS --> Q3[SQS: Notifications]
```

SQS alone does not provide RabbitMQ-style exchange routing. SNS or EventBridge is commonly added when fan-out or event routing is needed.

---

## 6.10 SQS Strengths

- Fully managed
- Durable service
- Strong AWS IAM integration
- CloudWatch metrics
- Standard and FIFO queue options
- Long polling
- Good fit for Lambda, ECS, EKS, and EC2 workloads
- Pay-per-request model
- Useful for bursty traffic

---

## 6.11 SQS Limitations

- AWS-specific service
- Polling introduces more latency than a local push-based broker in many workloads.
- API requests create usage cost.
- At-least-once delivery requires idempotent consumers.
- Delay is limited to 15 minutes.
- Visibility timeout requires careful configuration.
- Celery's SQS transport does not support all RabbitMQ/Redis capabilities.
- Local development requires mocking, emulation, or access to AWS.
- Cross-account and IAM policies can add configuration complexity.

---

## 6.12 When SQS Is a Good Choice

Use SQS when:

- The system runs primarily on AWS.
- The team wants almost no broker administration.
- Workloads are highly variable or bursty.
- High availability and durability are required without cluster management.
- Simple queue semantics are sufficient.
- Lambda or container autoscaling consumes the queue.
- Eventual task execution is acceptable.
- AWS-native security and monitoring are preferred.

Example workloads:

- File-processing pipelines
- OCR jobs
- Image processing
- Email and notification dispatch
- Order fulfillment
- Serverless background processing
- Cross-service buffering
- Traffic spike absorption
- Batch imports

---

# 7. Redis vs RabbitMQ vs SQS

## 7.1 Main Comparison

| Area | Redis | RabbitMQ | Amazon SQS |
|---|---|---|---|
| Primary identity | In-memory data platform with messaging features | Dedicated message broker | Fully managed cloud queue service |
| Operational model | Self-managed or managed Redis | Self-managed or managed RabbitMQ | AWS-managed |
| Delivery style | Blocking operations / transport-dependent | Primarily push-based | Poll-based |
| Typical latency | Very low | Low | Network and polling dependent |
| Routing | Basic | Excellent through exchanges and bindings | Basic; combine with SNS/EventBridge for richer routing |
| Consumer acknowledgment | Depends on structure/library | First-class manual ACK/NACK | Delete after successful processing |
| Retry mechanism | Application/Celery/Streams design | Requeue, TTL, DLX, delivery limits | Visibility timeout and redrive policy |
| Native DLQ experience | Usually application-managed | Strong DLX/DLQ topology | Strong managed DLQ support |
| Ordering | Depends on List/Stream and concurrency | FIFO queue order with practical caveats | Best effort for Standard; per-group ordering for FIFO |
| Replay | Streams support replay | Queues are normally consumed; Streams provide log behavior | DLQ/redrive; not a general event-log replay platform |
| High availability | Requires replication/Sentinel/Cluster or managed service | Quorum queues and cluster design | Built into service |
| Scaling effort | Requires capacity and memory planning | Requires broker and queue architecture | Automatically scales within quotas |
| Complex pub/sub | Limited Pub/Sub or Streams patterns | Excellent | Usually SNS/EventBridge + SQS |
| Celery support | Feature-complete transport | Feature-complete transport | Supported with limitations |
| Worker remote control in Celery | Supported | Supported | Not supported |
| Celery events/monitoring | Supported | Supported | Not supported by current transport |
| Best fit | Simple low-latency tasks and existing Redis stacks | Feature-rich, controlled enterprise messaging | AWS-native, scalable, low-operations queues |

---

## 7.2 Architecture Complexity

RabbitMQ has more concepts, but those concepts provide more control.

SQS has fewer broker concepts because AWS operates and abstracts the infrastructure.

Redis appears simple, but reliable queue behavior depends heavily on the chosen Redis structure and client framework.

---

## 7.3 Cost Model

### Redis

Typical cost components:

- Redis server or managed service
- Memory
- Replicas
- Persistence storage
- Operations and monitoring

Cost is often mostly capacity-based.

### RabbitMQ

Typical cost components:

- Broker nodes
- Storage
- Replication
- Load balancers or networking
- Operations
- Managed service fee when applicable

Cost is often capacity- and operations-based.

### SQS

Typical cost components:

- API requests
- Data transfer in some architectures
- Optional KMS usage
- Related services such as Lambda, SNS, or EventBridge

Cost is primarily usage-based.

Do not choose only by the queue's direct price. Include engineering effort, incident risk, monitoring, upgrades, and scaling work.

---

# 8. Message Delivery Semantics

Messaging systems are commonly described with three delivery models.

## 8.1 At-Most-Once

> Message is processed zero or one time.

A message may be lost, but it is not intentionally retried.

Example:

- Redis Pub/Sub to an offline subscriber

Suitable for:

- Live status updates
- Non-critical notifications
- Metrics where occasional loss is acceptable

---

## 8.2 At-Least-Once

> Message is processed one or more times.

The system prefers duplicate delivery over message loss.

Common examples:

- SQS Standard queues
- RabbitMQ with manual acknowledgments and redelivery
- Redis Streams consumer-group processing
- Celery Redis transport with visibility timeout

At-least-once delivery requires idempotent consumers.

---

## 8.3 Exactly-Once

True end-to-end exactly-once processing is difficult because the broker and business database are separate systems.

```mermaid
sequenceDiagram
    participant B as Broker
    participant W as Worker
    participant DB as Database

    B->>W: Deliver message
    W->>DB: Commit business change
    W--xB: ACK lost due to crash
    B->>W: Redeliver message
    W->>DB: Business change attempted again
```

A broker may provide deduplication or exactly-once-like delivery within a defined boundary, but it cannot automatically make an external API call, payment, email, and database update globally exactly once.

The practical solution is at-least-once delivery plus idempotent processing, transactional state, and a deduplication key.

---

# 9. Ordering and Concurrency

Ordering is often misunderstood.

## 9.1 Queue Order vs Completion Order

Suppose tasks enter in the order `A -> B -> C` and three workers receive one task each.

```text
Worker 1: A takes 10 seconds
Worker 2: B takes 1 second
Worker 3: C takes 2 seconds
```

Completion order becomes `B -> C -> A`.

The queue may deliver in FIFO order, but parallel processing changes completion order.

---

## 9.2 Redis Ordering

### Lists

A List can provide FIFO queue behavior when push/pop directions are selected consistently.

Multiple workers, retries, and task duration still affect completion order.

### Pub/Sub

Pub/Sub delivers live messages but provides no durable ordering for disconnected subscribers.

### Streams

Entries have ordered IDs. Each consumer group tracks its own position.

Parallel consumers can process different entries concurrently, so business completion may not remain globally ordered.

---

## 9.3 RabbitMQ Ordering

RabbitMQ queues maintain enqueue order under normal single-channel publishing.

Observed order can be affected by:

- Multiple publishers
- Multiple channels
- Multiple consumers
- Redelivery
- Requeueing
- Priorities
- Consumer prefetch

Strict sequential processing normally requires one queue, one active consumer, no priority reordering, and controlled retry behavior. This reduces throughput.

---

## 9.4 SQS Ordering

### Standard queue

- Best-effort ordering
- Duplicates possible
- High parallelism

### FIFO queue

- Strict order within a `MessageGroupId`
- Different groups can run in parallel
- One group can become a throughput bottleneck

Good group IDs are `customer_id`, `account_id`, `order_id`, or `tenant_id`.

Choose the grouping key based on the business entity that requires sequential processing.

---

# 10. Retries, Dead-Letter Queues, and Poison Messages

A **transient failure** may succeed later.

Examples:

- Temporary network error
- External API timeout
- Database connection interruption
- Rate limit

A **permanent failure** will not succeed without changing data or code.

Examples:

- Invalid email address
- Missing required field
- Unsupported file type
- Deleted customer
- Corrupt payload

A **poison message** repeatedly crashes or fails the consumer.

---

## 10.1 Retry with Exponential Backoff

Do not retry every failure immediately.

```text
Attempt 1 -> wait 5 seconds
Attempt 2 -> wait 30 seconds
Attempt 3 -> wait 2 minutes
Attempt 4 -> wait 10 minutes
Attempt 5 -> dead-letter
```

A common formula is `delay = min(base * 2^attempt, maximum_delay) + jitter`.

Jitter prevents many failed messages from retrying at exactly the same time.

---

## 10.2 Redis Retry Approach

With Celery:

```python
@celery_app.task(
    bind=True,
    autoretry_for=(TimeoutError,),
    retry_backoff=True,
    retry_backoff_max=600,
    retry_jitter=True,
    max_retries=5,
)
def call_external_api(self, resource_id: int) -> None:
    perform_external_call(resource_id)
```

For custom Redis Streams consumers:

- Leave failed messages pending for retry.
- Track retry count in metadata.
- Claim stale messages.
- Move permanently failing entries to a separate dead-letter Stream.
- Acknowledge the original only after safely recording the failure.

---

## 10.3 RabbitMQ Retry Approach

Typical RabbitMQ patterns include:

### Immediate requeue

Simple but dangerous for repeated failures.

### Retry queue with TTL and DLX

```mermaid
flowchart LR
    MAIN[Main Queue] --> W[Worker]
    W -->|Temporary failure| RETRY[Retry Queue with TTL]
    RETRY -->|TTL expires via DLX| MAIN
    W -->|Permanent failure| DLQ[Dead-Letter Queue]
```

### Quorum queue delivery limit

RabbitMQ quorum queues can limit repeated redeliveries and then drop or dead-letter the message according to policy.

RabbitMQ 4.0 and later use a default quorum-queue delivery limit of 20 unless configured differently.

Define the production retry policy explicitly instead of relying only on a default.

---

## 10.4 SQS Retry Approach

SQS naturally retries when a message is not deleted: the visibility timeout expires and the message becomes available again.

Use:

- Visibility timeout
- `ChangeMessageVisibility`
- Receive count
- DLQ redrive policy
- Application-level backoff

Celery's SQS transport also supports a backoff policy that changes message visibility based on retry count for predefined queues.

---

## 10.5 What to Store in a Dead-Letter Message

Include enough information to diagnose and safely replay the task.

```json
{
  "message_id": "d72ad27a-6089-4d60-b6ac-84e87d45d2f5",
  "task_type": "invoice.generate",
  "payload_version": 2,
  "correlation_id": "req-8c8134",
  "idempotency_key": "invoice:4821:v2",
  "attempt": 5,
  "first_failed_at": "2026-07-30T06:10:00Z",
  "last_failed_at": "2026-07-30T06:18:41Z",
  "error_code": "CUSTOMER_ADDRESS_MISSING",
  "payload": {
    "invoice_id": 4821
  }
}
```

Do not expose secrets or unnecessary personal data in broker messages or DLQs.

---

# 11. Idempotent Task Processing

An idempotent operation produces the same final result when executed multiple times: running `process(message)` three times leaves the business state correct.

---

## 11.1 Database Deduplication Record

Create a table with a unique message ID.

```sql
CREATE TABLE processed_messages (
    message_id UUID PRIMARY KEY,
    processed_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
```

Worker logic:

```python
from django.db import IntegrityError, transaction

@transaction.atomic
def process_payment_event(message: dict) -> None:
    try:
        ProcessedMessage.objects.create(
            message_id=message["message_id"],
        )
    except IntegrityError:
        return  # Already processed

    Payment.objects.filter(
        id=message["payment_id"],
        status="pending",
    ).update(status="completed")
```

The deduplication insert and business update should be part of the same database transaction when possible.

---

## 11.2 State-Transition Guard

Instead of blindly performing an action, update only from the expected state.

```sql
UPDATE invoices
SET status = 'generated'
WHERE id = 4821
  AND status = 'pending';
```

If zero rows are updated, the task has already been completed or is no longer valid.

---

## 11.3 External API Idempotency Key

When calling an external provider, send an idempotency key if the provider supports one.

```python
payment_provider.charge(
    customer_id=customer_id,
    amount=amount,
    idempotency_key=f"order:{order_id}:payment:v1",
)
```

This is especially important for:

- Payments
- Refunds
- Subscription changes
- Order submission
- Resource creation

---

## 11.4 Transactional Outbox Pattern

A common failure occurs between database commit and message publication.

```text
1. Save order.
2. Application crashes.
3. order.created message is never published.
```

The transactional outbox solves this by writing the business record and outgoing event in one database transaction.

```mermaid
flowchart LR
    API[Application] --> TX{Database Transaction}
    TX --> O[(Orders)]
    TX --> OB[(Outbox)]
    R[Outbox Relay] --> OB
    R --> B[(Broker)]
    B --> C[Consumer]
```

Example:

```sql
BEGIN;

INSERT INTO orders (id, status)
VALUES (4821, 'created');

INSERT INTO outbox_events (
    event_id,
    event_type,
    aggregate_id,
    payload
)
VALUES (
    gen_random_uuid(),
    'order.created',
    '4821',
    '{"order_id": 4821}'
);

COMMIT;
```

A relay publishes unsent outbox records and marks them as published.

Because the relay can publish twice after a crash, consumers still need idempotency.

---

# 12. Celery Configuration Examples

Celery uses a broker to transport tasks.

The examples below use current Celery 5.6-style configuration.

---

## 12.1 Shared Task

```python
# tasks.py

from celery import shared_task

@shared_task(
    bind=True,
    autoretry_for=(TimeoutError,),
    retry_backoff=True,
    retry_jitter=True,
    max_retries=5,
    acks_late=True,
)
def generate_invoice(self, invoice_id: int) -> None:
    invoice = load_invoice(invoice_id)

    if invoice.status == "generated":
        return

    create_invoice(invoice)
    mark_invoice_generated(invoice_id)
```

Important:

- `acks_late=True` acknowledges after task execution rather than before.
- The task must be idempotent.
- Retry only errors that may succeed later.
- Do not retry invalid business input forever.

---

## 12.2 Celery with Redis

```python
# celery.py

from celery import Celery

app = Celery("my_application")

app.conf.update(
    broker_url="redis://redis:6379/0",
    result_backend="redis://redis:6379/1",
    broker_transport_options={
        "visibility_timeout": 3_600,
    },
    result_backend_transport_options={
        "visibility_timeout": 3_600,
        "global_keyprefix": "myapp:",
    },
    visibility_timeout=3_600,
    task_serializer="json",
    result_serializer="json",
    accept_content=["json"],
    task_track_started=True,
    timezone="UTC",
)
```

Production notes:

- Use authentication and TLS.
- Use a non-evicting Redis policy for broker data.
- Separate cache and broker workloads where possible.
- Set visibility timeout based on task duration.
- Avoid distant ETA tasks in the broker.
- Configure Sentinel, replication, or managed high availability.

---

## 12.3 Celery with RabbitMQ

```python
# celery.py

from celery import Celery
from kombu import Exchange, Queue

app = Celery("my_application")

tasks_exchange = Exchange(
    "tasks",
    type="topic",
    durable=True,
)

app.conf.update(
    broker_url="amqp://app_user:strong_password@rabbitmq:5672/app_vhost",
    result_backend="redis://redis:6379/1",
    task_serializer="json",
    result_serializer="json",
    accept_content=["json"],
    task_acks_late=True,
    task_reject_on_worker_lost=True,
    worker_prefetch_multiplier=1,
    task_default_exchange="tasks",
    task_default_exchange_type="topic",
    task_default_routing_key="default",
    task_queues=(
        Queue(
            "billing",
            exchange=tasks_exchange,
            routing_key="billing.#",
            durable=True,
        ),
        Queue(
            "notifications",
            exchange=tasks_exchange,
            routing_key="notification.#",
            durable=True,
        ),
    ),
    task_routes={
        "billing.tasks.*": {
            "queue": "billing",
            "routing_key": "billing.standard",
        },
        "notifications.tasks.*": {
            "queue": "notifications",
            "routing_key": "notification.email",
        },
    },
)
```

Production notes:

- Use TLS.
- Use durable queues.
- Use publisher confirms when publishing outside Celery or when the client supports explicit configuration.
- Use quorum queues for replicated high-availability workloads.
- Configure DLX, TTL, retry, and delivery-limit policies.
- Monitor ready and unacknowledged messages.
- Tune prefetch based on task duration.

---

## 12.4 Celery with Amazon SQS

Prefer IAM roles rather than long-lived access keys.

```python
# celery.py

from celery import Celery

app = Celery("my_application")

app.conf.update(
    broker_url="sqs://",
    broker_transport_options={
        "region": "ap-south-1",
        "visibility_timeout": 3_600,
        "wait_time_seconds": 20,
        "polling_interval": 1,
        "queue_name_prefix": "myapp-",
    },
    task_serializer="json",
    accept_content=["json"],
    timezone="UTC",
)
```

When queues are provisioned using infrastructure as code, use predefined queues.

```python
app.conf.broker_transport_options = {
    "region": "ap-south-1",
    "wait_time_seconds": 20,
    "predefined_queues": {
        "billing": {
            "url": (
                "https://sqs.ap-south-1.amazonaws.com/"
                "123456789012/myapp-billing"
            ),
        },
        "notifications": {
            "url": (
                "https://sqs.ap-south-1.amazonaws.com/"
                "123456789012/myapp-notifications"
            ),
        },
    },
}
```

When using IAM roles, SDK credential resolution supplies credentials automatically.

### Celery SQS limitations

Current Celery documentation states that the SQS transport does not support:

- Worker remote-control commands
- Celery events
- Celery event-based monitors

SQS polling is also not suitable when sub-millisecond task-delivery precision is required.

---

## 12.5 Broker and Result Backend Are Independent

Common combinations:

```text
Redis broker + Redis result backend
RabbitMQ broker + Redis result backend
RabbitMQ broker + PostgreSQL result backend
SQS broker + PostgreSQL result backend
SQS broker + no result backend
```

A task that only performs a side effect often does not need its return value stored.

```python
app.conf.task_ignore_result = True
```

This reduces storage and network overhead.

---

# 13. Production Architecture Examples

## 13.1 Existing Django Application with Short Tasks

Requirements:

- Email sending
- Thumbnail generation
- Search indexing
- Team already operates Redis
- Moderate traffic
- No advanced routing

```mermaid
flowchart LR
    U[User] --> D[Django API]
    D --> PG[(PostgreSQL)]
    D --> R[(Redis Broker)]
    R --> C1[Celery Worker]
    R --> C2[Celery Worker]
    C1 --> S3[Object Storage]
    C2 --> E[Email Provider]
```

Recommended starting point: Redis + Celery.

Important controls:

- Separate cache and broker memory
- No-eviction broker policy
- Idempotent tasks
- Visibility timeout
- Queue-depth alerts

---

## 13.2 Business Workflow with Advanced Routing

Requirements:

- Orders publish domain events
- Billing, inventory, notifications, and audit consume different events
- Low latency
- On-premises support
- Dead-letter routing
- Strong operational control

```mermaid
flowchart LR
    O[Order Service] --> EX{RabbitMQ Topic Exchange}
    EX -->|order.created| BQ[Billing Queue]
    EX -->|order.created| IQ[Inventory Queue]
    EX -->|order.*| AQ[Audit Queue]
    EX -->|order.shipped| NQ[Notification Queue]

    BQ --> B[Billing Worker]
    IQ --> I[Inventory Worker]
    AQ --> A[Audit Worker]
    NQ --> N[Notification Worker]
```

Recommended: RabbitMQ.

Important controls:

- Publisher confirms
- Manual acknowledgments
- Quorum queues
- Delivery limits
- DLX/DLQ
- Prefetch tuning
- Idempotent consumers

---

## 13.3 AWS File-Processing Pipeline

Requirements:

- Uploaded files create OCR jobs
- Workload is highly bursty
- Workers run in ECS or Lambda
- Minimal broker operations
- Failed jobs need a managed DLQ

```mermaid
flowchart LR
    U[User Upload] --> S3[(Amazon S3)]
    S3 --> API[Application]
    API --> Q[(SQS OCR Queue)]
    Q --> W1[ECS/Lambda Worker]
    Q --> W2[ECS/Lambda Worker]
    W1 --> DB[(Database)]
    W2 --> DB
    Q --> DLQ[(SQS DLQ)]
```

Recommended: Amazon SQS.

Message:

```json
{
  "message_id": "f00c02f2-1ea1-4a49-9e04-79653cc254e1",
  "job_type": "menu.ocr",
  "restaurant_id": 884,
  "bucket": "restaurant-menus",
  "key": "uploads/884/menu-2026-07.pdf"
}
```

Do not place the PDF itself in the queue.

---

## 13.4 Hybrid Celery Architecture

A common production design uses RabbitMQ as the broker and Redis as the result backend.

```mermaid
flowchart LR
    API[API] --> RMQ[(RabbitMQ Broker)]
    RMQ --> W[Celery Workers]
    W --> DB[(PostgreSQL)]
    W --> R[(Redis Result Backend)]
    API --> R
```

Why this combination is common:

- RabbitMQ provides rich broker behavior.
- Redis provides fast task-status lookup.
- Broker and result workloads are isolated.
- Each tool is used for a role it handles well.

---

# 14. Performance and Scaling

Performance depends on more than broker brand.

Important variables include:

- Message size
- Serialization
- Producer connections
- Consumer concurrency
- Task execution time
- Network latency
- Persistence
- Replication
- Acknowledgment mode
- Prefetch
- Polling interval
- Batch size
- Queue count
- Ordering requirements

---

## 14.1 Keep Messages Small

Bad:

```json
{
  "task": "generate_report",
  "complete_customer_record": {
    "...": "thousands of fields"
  },
  "pdf_bytes": "..."
}
```

Better:

```json
{
  "message_id": "e4e25d35-343f-4f76-98fc-b10c760f564e",
  "task": "generate_report",
  "report_id": 4821,
  "payload_version": 1
}
```

Benefits:

- Lower network usage
- Lower broker memory or storage
- Faster serialization
- Easier retries
- Better security
- Smaller DLQs

---

## 14.2 Scale Consumers Based on Backlog

A useful scaling signal is not only queue length. Use queue depth, oldest message age, incoming message rate, completion rate, average and P95 task duration, worker utilization, and failure rate.

Example:

```text
Incoming:       1,000 jobs/minute
Each worker:       50 jobs/minute
Required workers:  20 minimum

Add safety capacity for spikes and failures.
```

---

## 14.3 Separate Queues by Workload

Do not put every task in one queue.

```mermaid
flowchart LR
    P[Application] --> Q1[Fast Queue]
    P --> Q2[Slow Queue]
    P --> Q3[High-Priority Queue]
    P --> Q4[External API Queue]

    Q1 --> W1[Fast Workers]
    Q2 --> W2[Slow Workers]
    Q3 --> W3[Priority Workers]
    Q4 --> W4[Rate-Limited Workers]
```

Benefits:

- Slow tasks do not block fast tasks.
- Different worker concurrency can be used.
- External rate limits can be isolated.
- Priority workloads receive dedicated capacity.
- Failures are easier to diagnose.

---

## 14.4 Backlog Capacity

A broker should absorb temporary spikes, not replace capacity planning.

Estimate backlog growth as `backlog_growth_per_second = producer_rate - consumer_rate`, and time to drain as `drain_time = backlog_size / (consumer_rate - producer_rate)`.

The drain formula applies only when consumer rate is greater than producer rate.

---

## 14.5 Redis Scaling Considerations

- Memory is a primary constraint.
- Persistence can affect latency.
- Replication increases cost and network traffic.
- Hot keys or queues can limit distribution.
- Cache eviction must not remove broker state.
- Redis Streams should be trimmed deliberately.
- Test failover behavior with actual clients.

---

## 14.6 RabbitMQ Scaling Considerations

- Use separate queues to distribute work.
- A single queue has practical throughput limits.
- Quorum replication adds safety and write cost.
- Prefetch affects fairness and throughput.
- Disk alarms and memory alarms can trigger flow control.
- Large queues and large messages require storage planning.
- Use odd-node clusters for quorum-based components.
- Test node loss and leader election.

---

## 14.7 SQS Scaling Considerations

- Standard queues scale automatically for very high throughput.
- Use batches of up to ten messages where appropriate.
- Use long polling.
- Scale workers using visible backlog and oldest-message age.
- FIFO throughput depends on queue mode, region quotas, batching, and message-group distribution.
- One FIFO message group processes sequentially.
- Monitor in-flight message counts.
- Request quota increases before expected peaks where required.

---

# 15. Security and Operations

## 15.1 Redis Security

Use:

- TLS
- ACL users
- Strong authentication
- Private network access
- Separate credentials by application
- Restricted commands where appropriate
- Encryption at rest in managed deployments
- Backup and recovery testing

Never expose Redis directly to the public internet.

---

## 15.2 RabbitMQ Security

Use:

- TLS for client and cluster traffic
- Separate virtual hosts
- Per-service users
- Configure/read/write permissions
- Short-lived credentials where supported
- Private networking
- Secret rotation
- Management UI access restrictions
- Audit and connection monitoring

Example isolation:

```text
Vhost: /billing
User: billing-service
Permissions: only billing exchanges and queues
```

---

## 15.3 SQS Security

Use:

- IAM roles instead of embedded access keys
- Least-privilege queue policies
- Server-side encryption
- KMS keys where required
- VPC endpoints for private AWS access
- Separate queues by environment
- CloudTrail auditing
- Resource tags
- Cross-account policies only when required

Example permission scope:

```text
Producer role:
  sqs:SendMessage

Consumer role:
  sqs:ReceiveMessage
  sqs:DeleteMessage
  sqs:ChangeMessageVisibility
  sqs:GetQueueAttributes
```

The producer normally does not need receive or delete permissions.

---

## 15.4 Environment Isolation

Use separate broker resources for development, testing, staging, and production.

Do not rely only on queue-name prefixes when stronger account, cluster, vhost, or network isolation is available.

---

## 15.5 Graceful Worker Shutdown

During deployment:

1. Stop accepting new work.
2. Allow running tasks to finish within a limit.
3. Requeue or release unacknowledged tasks.
4. Shut down the worker.
5. Start replacement workers.

A forced kill can delay SQS or Redis redelivery until visibility timeout expires.

Test shutdown behavior before production.

---

# 16. Monitoring and Observability

A queue is healthy when work is entering and leaving at the expected rate—not merely when the broker is reachable.

## 16.1 Common Metrics

Monitor:

| Metric | Meaning |
|---|---|
| Ready or visible messages | Waiting backlog |
| Unacknowledged or in-flight messages | Currently reserved/processing |
| Oldest message age | How delayed the system is |
| Publish rate | Incoming workload |
| Delivery/receive rate | Worker intake |
| Acknowledgment/delete rate | Successful completion flow |
| Retry rate | Transient or systemic failures |
| DLQ depth | Permanently failing work |
| Processing duration | Worker performance |
| Worker concurrency | Available execution capacity |
| Broker memory/disk | Infrastructure pressure |
| Connection/channel count | Client health |
| Empty polls | SQS polling efficiency |

---

## 16.2 Most Important Alert

Queue length alone can be misleading.

A queue of 100,000 messages may be normal if it drains in seconds.

A queue of 50 messages may be critical if the oldest message is two hours old.

The most useful operational signal is often the age of the oldest unprocessed message.

---

## 16.3 Correlation and Trace IDs

Include identifiers in every message.

```json
{
  "message_id": "bcd33041-6598-4747-a0d7-a86245f788c2",
  "correlation_id": "request-3902a5",
  "causation_id": "event-d2ff91",
  "task_type": "invoice.generate",
  "payload_version": 1,
  "payload": {
    "invoice_id": 4821
  }
}
```

Log these values in:

- Producer logs
- Broker metadata
- Worker logs
- Database audit records
- External API requests
- DLQ entries

This makes distributed failures traceable.

---

## 16.4 Broker-Specific Monitoring

### Redis

Monitor:

- Used memory
- Evicted keys
- Connected clients
- Blocked clients
- Replication lag
- Persistence health
- Stream length
- Pending entries
- Consumer lag

### RabbitMQ

Monitor:

- Ready messages
- Unacknowledged messages
- Publish/confirm rates
- Deliver/ack rates
- Connection and channel count
- Consumer count
- Node memory
- Disk free space
- Flow-control state
- Queue leader and replica health
- Redeliveries
- Dead-letter counts

### SQS

Monitor using CloudWatch:

- Approximate number of visible messages
- Approximate number of not-visible messages
- Approximate age of oldest message
- Messages sent
- Messages received
- Messages deleted
- Empty receives
- DLQ message count

Remember that many SQS metrics are approximate and that received/deleted counts do not equal unique business operations.

---

# 17. How to Choose the Right Broker

## 17.1 Decision Flow

```mermaid
flowchart TD
    A[Need a task broker] --> B{Already fully AWS-based?}
    B -->|Yes| C{Need RabbitMQ-style routing or Celery remote control?}
    C -->|No| SQS[Choose Amazon SQS]
    C -->|Yes| RMQ[Choose RabbitMQ or managed RabbitMQ]

    B -->|No| D{Need complex routing, DLX, confirms, or broker control?}
    D -->|Yes| RMQ
    D -->|No| E{Already operate Redis and tasks are simple/short?}
    E -->|Yes| REDIS[Choose Redis]
    E -->|No| F{Want minimal broker operations?}
    F -->|Yes and AWS acceptable| SQS
    F -->|No or cloud-neutral| RMQ
```

---

## 17.2 Practical Recommendation Matrix

| Scenario | Recommended starting choice | Reason |
|---|---|---|
| Small Django app already using Redis | Redis | Lowest setup complexity |
| Celery app requiring rich routing | RabbitMQ | Exchanges and queue control |
| AWS serverless task processing | SQS | Native managed integration |
| Payment workflow | RabbitMQ or SQS FIFO | Reliability controls and ordered entity processing |
| WebSocket live notifications | Redis Pub/Sub | Fast live fan-out when loss is acceptable |
| Durable moderate event stream with replay | Redis Streams | Consumer groups and replay |
| Multi-cloud/on-premises enterprise messaging | RabbitMQ | Cloud-neutral broker |
| Massive burst absorption on AWS | SQS Standard | Managed automatic scaling |
| Strict per-account sequencing on AWS | SQS FIFO | Ordering by message group |
| Celery with full event monitoring | Redis or RabbitMQ | Current SQS transport lacks Celery events |

---

# 18. Best Practices

## 18.1 Design Every Consumer for Duplicate Delivery

Assume a task may run more than once.

Use:

- Unique message ID
- Idempotency key
- Database uniqueness
- Conditional state transitions
- External API idempotency
- Transactional processing

---

## 18.2 Acknowledge Only After Success

Incorrect: `Receive -> ACK -> Process`. A crash after ACK loses the task.

Preferred for important tasks: `Receive -> Process -> Commit -> ACK/Delete`.

The task must be idempotent because a crash can occur after commit but before ACK.

---

## 18.3 Separate Temporary and Permanent Failures

Retry:

- Timeout
- Connection reset
- Rate limit
- Temporary service unavailable

Do not repeatedly retry:

- Invalid schema
- Missing mandatory business data
- Unsupported operation
- Authentication misconfiguration
- Deleted resource where deletion is final

Send permanent failures to a DLQ or mark them as rejected.

---

## 18.4 Use Bounded Retries

Every retry policy needs:

- Maximum attempts
- Backoff
- Jitter
- Maximum delay
- DLQ behavior
- Alerting
- Replay procedure

---

## 18.5 Keep Payloads Small and Versioned

Recommended envelope:

```json
{
  "message_id": "uuid",
  "event_type": "order.created",
  "payload_version": 1,
  "occurred_at": "2026-07-30T07:00:00Z",
  "correlation_id": "request-id",
  "idempotency_key": "order:4821:created:v1",
  "payload": {
    "order_id": 4821
  }
}
```

Version the payload so producers and consumers can evolve independently.

---

## 18.6 Store Large Data Outside the Broker

Store:

- Images
- PDFs
- Videos
- Large JSON documents
- Database exports

in object storage.

Send only:

- Object location
- Content type
- Checksum
- Record ID
- Processing instructions

---

## 18.7 Do Not Use the Broker as a Long-Term Scheduler

A task queue is optimized for work that should be processed relatively soon.

For distant execution:

- Store schedule state durably.
- Use Celery Beat with a durable schedule store.
- Use a managed scheduler.
- Publish the task near execution time.

---

## 18.8 Isolate Workloads

Use different queues for:

- Fast and slow tasks
- High and normal priority
- Rate-limited external APIs
- CPU-heavy and I/O-heavy tasks
- Tenant-sensitive ordering
- Business-critical and best-effort work

---

## 18.9 Test Failure Scenarios

Test:

- Worker crash before acknowledgment
- Worker crash after database commit
- Broker restart
- Network interruption
- Duplicate message
- Invalid payload
- DLQ movement
- Retry exhaustion
- Queue backlog
- Slow downstream service
- Credential expiration
- Deployment shutdown
- Redis failover
- RabbitMQ node loss
- SQS visibility timeout expiration

A queue design is not production-ready until redelivery behavior has been observed in testing.

---

## 18.10 Use Infrastructure as Code

Provision queues, policies, alarms, users, permissions, and DLQs through:

- Terraform
- AWS CloudFormation or CDK
- Kubernetes operators
- RabbitMQ definitions/policies
- Deployment automation

Avoid manually creating production queues without version-controlled configuration.

---

# 19. Official References

The guide was checked against the following official documentation:

## Redis

- Redis documentation: https://redis.io/docs/latest/
- Redis job queue pattern: https://redis.io/docs/latest/develop/use-cases/job-queue/
- Redis Streams: https://redis.io/docs/latest/develop/data-types/streams/
- Redis streaming use case: https://redis.io/docs/latest/develop/use-cases/streaming/
- Redis Pub/Sub: https://redis.io/docs/latest/develop/pubsub/
- Redis persistence: https://redis.io/docs/latest/operate/oss_and_stack/management/persistence/

## RabbitMQ

- RabbitMQ 4.3 documentation: https://www.rabbitmq.com/docs
- AMQP model and exchanges: https://www.rabbitmq.com/tutorials/amqp-concepts
- RabbitMQ queues: https://www.rabbitmq.com/docs/queues
- RabbitMQ reliability guide: https://www.rabbitmq.com/docs/reliability
- Consumer acknowledgments and publisher confirms: https://www.rabbitmq.com/docs/confirms
- Quorum queues: https://www.rabbitmq.com/docs/quorum-queues
- Dead-letter exchanges: https://www.rabbitmq.com/docs/dlx
- Message and queue TTL: https://www.rabbitmq.com/docs/ttl
- Consumer prefetch: https://www.rabbitmq.com/docs/consumer-prefetch
- RabbitMQ installation and current release: https://www.rabbitmq.com/docs/download

## Amazon SQS

- Amazon SQS Developer Guide: https://docs.aws.amazon.com/AWSSimpleQueueService/latest/SQSDeveloperGuide/
- SQS queue types: https://docs.aws.amazon.com/AWSSimpleQueueService/latest/SQSDeveloperGuide/sqs-queue-types.html
- Standard queues: https://docs.aws.amazon.com/AWSSimpleQueueService/latest/SQSDeveloperGuide/standard-queues.html
- FIFO queues: https://docs.aws.amazon.com/AWSSimpleQueueService/latest/SQSDeveloperGuide/sqs-fifo-queues.html
- Visibility timeout: https://docs.aws.amazon.com/AWSSimpleQueueService/latest/SQSDeveloperGuide/sqs-visibility-timeout.html
- Message quotas: https://docs.aws.amazon.com/AWSSimpleQueueService/latest/SQSDeveloperGuide/quotas-messages.html
- Long polling: https://docs.aws.amazon.com/AWSSimpleQueueService/latest/SQSDeveloperGuide/best-practices-setting-up-long-polling.html
- Dead-letter queues: https://docs.aws.amazon.com/AWSSimpleQueueService/latest/SQSDeveloperGuide/sqs-dead-letter-queues.html
- CloudWatch metrics: https://docs.aws.amazon.com/AWSSimpleQueueService/latest/SQSDeveloperGuide/sqs-available-cloudwatch-metrics.html

## Celery

- Celery brokers and result backends: https://docs.celeryq.dev/en/latest/getting-started/backends-and-brokers/
- Celery with Redis: https://docs.celeryq.dev/en/latest/getting-started/backends-and-brokers/redis.html
- Celery with RabbitMQ: https://docs.celeryq.dev/en/latest/getting-started/backends-and-brokers/rabbitmq.html
- Celery with Amazon SQS: https://docs.celeryq.dev/en/latest/getting-started/backends-and-brokers/sqs.html
