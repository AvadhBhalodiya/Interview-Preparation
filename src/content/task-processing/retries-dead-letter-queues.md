---
title: "Retries & DLQ"
group: "Reliability"
order: 4
---

# Retry Strategies and Dead-Letter Queues (DLQ)

> **Category:** Async & Task Processing  
> **Audience:** Developers with 3+ years of experience  
> **Purpose:** Understand how production systems retry failed tasks safely, isolate poison messages, and recover messages from a Dead-Letter Queue without creating duplicate work or retry storms.  
> **Reviewed against current official documentation:** July 2026

---

# 1. Why Failures Need a Strategy

Background tasks fail for normal reasons:

- A downstream API temporarily returns `503 Service Unavailable`.
- A database connection is interrupted.
- A network request times out.
- A rate limit is exceeded.
- A worker crashes during processing.
- The message contains invalid or outdated data.
- A code bug causes the same task to fail every time.

A reliable system should not treat every failure in the same way.

A temporary network error may succeed after a short delay. An invalid email address will not become valid merely because the task is attempted 100 times.

The goal is therefore not simply **“retry every failed task.”** The real goal is:

> Retry failures that may recover, stop retrying failures that cannot recover, and preserve unresolved messages for investigation or controlled recovery.

This normally requires three related mechanisms:

```text
Retry policy + retry limit + dead-letter handling
```

Without these controls, a failed message may repeatedly consume worker capacity, overload a dependency, increase infrastructure cost, and block useful work.

---

# 2. The Core Processing Model

A typical asynchronous processing flow contains four major components:

```text
Producer  --->  Broker/Queue  --->  Worker  --->  External dependency
   |                |                |                  |
Creates task     Stores task      Processes task     API / DB / service
```

Example:

```text
Checkout API
    |
    | publishes "send order confirmation"
    v
Email Queue
    |
    v
Email Worker
    |
    v
Email Provider
```

A task can finish in one of three meaningful states:

| State | Meaning | Typical action |
|---|---|---|
| Success | Processing completed | Acknowledge/delete message |
| Retryable failure | Failure may recover | Retry after a controlled delay |
| Non-retryable or exhausted failure | Retrying is useless or limit reached | Send to DLQ or terminal-failure store |

The important design decision is made at the failure boundary:

```text
                    +----------------------+
                    |   Task processing    |
                    +----------+-----------+
                               |
                         Did it succeed?
                          /           \
                        Yes            No
                        /               \
              ACK/Delete          Is error retryable?
                                   /              \
                                 Yes               No
                                  |                 |
                         Attempts remaining?       DLQ
                           /           \
                         Yes            No
                          |              |
                     Delay + retry      DLQ
```

---

# 3. Classifying Failures Before Retrying

Retry behavior should be based on the type of failure, not merely on the fact that an exception occurred.

## 3.1 Transient failures

A transient failure is temporary and may disappear without changing the message.

Examples:

- HTTP `408 Request Timeout`
- HTTP `429 Too Many Requests`
- HTTP `502 Bad Gateway`
- HTTP `503 Service Unavailable`
- Connection reset
- Temporary DNS failure
- Database deadlock
- Short-lived broker or network interruption

**Recommended action:** Retry with a delay, usually exponential backoff and jitter.

---

## 3.2 Permanent failures

A permanent failure is caused by input or business conditions that will not change through repetition.

Examples:

- Invalid email address
- Unsupported file format
- Missing required field
- Unknown customer ID
- Malformed JSON
- Business rule rejection
- HTTP `400 Bad Request`
- HTTP `401 Unauthorized` caused by permanently invalid credentials
- HTTP `404 Not Found` when the referenced entity is permanently absent

**Recommended action:** Do not blindly retry. Record the failure and route the message to a DLQ, validation-failure queue, or business-rejection workflow.

---

## 3.3 Unknown failures

Some failures cannot be classified immediately.

Examples:

- Unexpected exception from application code
- New third-party error code
- Deserialization behavior changed after a deployment
- Dependency returns an undocumented response

A reasonable policy is:

1. Retry a small number of times.
2. Capture detailed context.
3. Move the task to the DLQ when the retry limit is reached.
4. Alert the owning team if the failure rate is abnormal.

---

## 3.4 Failure-classification example

```python
from dataclasses import dataclass


class RetryableTaskError(Exception):
    """The operation may succeed later."""


class PermanentTaskError(Exception):
    """The same message should not be retried unchanged."""


@dataclass(frozen=True)
class HttpResult:
    status_code: int
    body: str


def classify_http_result(result: HttpResult) -> None:
    if 200 <= result.status_code < 300:
        return

    if result.status_code in {408, 425, 429, 500, 502, 503, 504}:
        raise RetryableTaskError(
            f"Temporary downstream failure: {result.status_code}"
        )

    raise PermanentTaskError(
        f"Permanent request failure: {result.status_code}: {result.body}"
    )
```

The exact classification depends on the dependency and business context. For example, a `404` may be permanent in one workflow but temporary in an eventually consistent system.

---

# 4. Common Retry Strategies

A retry strategy determines **when** the next attempt occurs.

## 4.1 Immediate retry

The task is retried without a meaningful delay.

```text
Attempt 1 -> fail -> Attempt 2 -> fail -> Attempt 3
```

### Suitable for

- Extremely brief race conditions
- Local optimistic-concurrency conflicts
- Operations expected to recover in milliseconds

### Risk

Immediate retry can create a tight loop. If the dependency is already overloaded, immediate retries add more load precisely when the dependency needs less traffic.

Use it only for a very small number of attempts and a clearly understood failure mode.

---

## 4.2 Fixed-delay retry

Every retry waits for the same duration.

```text
Attempt 1 --10s--> Attempt 2 --10s--> Attempt 3 --10s--> Attempt 4
```

Formula:

```text
Delay(n) = constant_delay
```

Example:

```text
10s, 10s, 10s, 10s
```

### Suitable for

- A dependency that usually recovers within a predictable interval
- Simple internal workflows
- Low-volume systems where synchronized retries are not dangerous

### Limitation

Many failed tasks may become ready at the same time and produce a sudden traffic spike.

---

## 4.3 Linear backoff

The delay increases by a fixed amount after each attempt.

Formula:

```text
Delay(n) = base_delay × n
```

With a five-second base delay:

```text
5s, 10s, 15s, 20s, 25s
```

### Suitable for

- Moderate retry growth
- Workflows where exponential delay would become too large too quickly

### Limitation

It still provides less protection than exponential backoff when a dependency has a major outage.

---

## 4.4 Exponential backoff

The delay grows exponentially after every failed attempt.

A common formula is:

```text
Delay(n) = min(max_delay, base_delay × 2^(n - 1))
```

With `base_delay = 2 seconds`:

| Retry number | Delay |
|---:|---:|
| 1 | 2 seconds |
| 2 | 4 seconds |
| 3 | 8 seconds |
| 4 | 16 seconds |
| 5 | 32 seconds |
| 6 | 64 seconds |

If `max_delay = 60 seconds`, later retries stay capped at 60 seconds.

### Why it works

Exponential backoff gives a failing dependency increasing time to recover and prevents workers from continuously sending requests during an outage.

### Limitation

If thousands of tasks fail at the same time, they may still retry together at `2s`, `4s`, `8s`, and so on. This synchronized behavior is known as a **thundering herd**.

---

## 4.5 Exponential backoff with jitter

Jitter adds randomness to each retry delay.

Instead of every task waiting exactly eight seconds, tasks receive different delays:

```text
Task A: 2.1 seconds
Task B: 5.8 seconds
Task C: 7.4 seconds
Task D: 1.6 seconds
```

This spreads traffic across time.

### Full jitter

```text
maximum = min(max_delay, base_delay × 2^(n - 1))
actual_delay = random(0, maximum)
```

### Equal jitter

```text
maximum = min(max_delay, base_delay × 2^(n - 1))
actual_delay = maximum / 2 + random(0, maximum / 2)
```

### Decorrelated jitter

```text
actual_delay = min(max_delay, random(base_delay, previous_delay × 3))
```

For most background-task systems, **exponential backoff with jitter and a maximum delay** is a strong default.

```text
No jitter

0s      2s      4s          8s
|-------|-------|------------|
AAAA    AAAA    AAAA         AAAA

With jitter

0s      2s      4s          8s
|-------|-------|------------|
 A A       A  A    A A   A        A
```

---

# 5. Choosing Retry Limits and Time Budgets

A retry policy should include more than `max_attempts`.

Useful controls are:

| Control | Purpose |
|---|---|
| Maximum attempts | Stops infinite retries |
| Maximum elapsed time | Stops retries after the business deadline |
| Initial delay | Controls how quickly the first retry occurs |
| Maximum delay | Prevents excessively long waits |
| Jitter | Avoids synchronized retry traffic |
| Per-attempt timeout | Prevents one attempt from hanging indefinitely |
| Task expiration | Prevents stale work from executing later |

## 5.1 Attempts versus retries

Be precise with terminology.

```text
1 initial attempt + 3 retries = 4 total attempts
```

Some frameworks configure `max_retries`; others configure `max_attempts` or `max_receive_count`. These values do not always mean the same thing.

---

## 5.2 Use a retry time budget

Suppose a payment-status synchronization task is useful only for five minutes.

A policy such as this is incorrect:

```text
Retry forever every 10 minutes
```

A better policy is:

```text
Maximum attempts: 6
Maximum elapsed time: 5 minutes
Backoff: exponential with jitter
Per-attempt HTTP timeout: 10 seconds
```

The task should be abandoned or moved to a reconciliation workflow after the useful business window closes.

---

## 5.3 Consider dependency recovery time

Different dependencies need different policies.

| Dependency/failure | Example policy |
|---|---|
| Brief database deadlock | 2–3 quick retries with small jitter |
| Rate-limited API | Respect `Retry-After`, then exponential backoff |
| Email provider outage | Retry over minutes or hours |
| Invalid payload | No retry; send to failure workflow |
| Worker process crash | Broker redelivery, protected by idempotency |
| Long external outage | Limited retries, then DLQ or scheduled reconciliation |

---

## 5.4 Respect server guidance

When a downstream service returns a valid `Retry-After` header or equivalent retry timestamp, prefer that guidance over a locally calculated delay, while still applying safety limits.

```python
retry_delay = min(
    dependency_retry_after_seconds,
    application_max_retry_delay,
)
```

Validate the value before trusting it. A malformed or extremely large delay should not silently keep a message in an in-flight state forever.

---

# 6. Dead-Letter Queue Fundamentals

A **Dead-Letter Queue (DLQ)** is a separate queue or topic used to isolate messages that could not be processed successfully.

A message usually enters a DLQ because:

- It exceeded the configured delivery or retry limit.
- The consumer explicitly rejected it as non-retryable.
- The message expired.
- Queue-length or broker policies dead-lettered it.
- A routing or processing policy intentionally diverted it.

```text
Main Queue
    |
    | delivery attempt 1
    | delivery attempt 2
    | delivery attempt 3
    v
Dead-Letter Queue
```

A DLQ is not a trash bin. It is an operational safety mechanism.

Messages in a DLQ should have a defined lifecycle:

```text
Detect -> inspect -> classify -> fix -> redrive or discard -> audit
```

---

## 6.1 What a DLQ solves

### Prevents poison-message loops

A poison message is a message that repeatedly causes processing to fail.

Without a retry limit:

```text
Receive -> fail -> requeue -> receive -> fail -> requeue -> ... forever
```

With a DLQ:

```text
Receive -> fail -> retry -> fail -> retry -> fail -> DLQ
```

### Protects queue throughput

A small set of bad messages should not continuously consume worker slots that could process healthy messages.

### Preserves failed work

Instead of deleting a failed message, the system retains it for diagnosis and recovery.

### Improves debugging

The team can inspect:

- Original payload
- Message ID
- Correlation or trace ID
- Attempt count
- Failure type
- Last error
- First and last failure times
- Producer and schema version

---

## 6.2 What a DLQ does not solve

A DLQ does not automatically:

- Fix broken code
- Correct invalid data
- Prevent duplicate side effects
- Decide whether redrive is safe
- Guarantee that failure context is present
- Replace monitoring and ownership

A system with a DLQ but no alerts or recovery procedure merely stores failures more neatly.

---

# 7. Complete Retry-to-DLQ Flow

```text
+-------------------+
|   Producer/API    |
+---------+---------+
          |
          | Publish task
          v
+-------------------+
|    Main Queue     |
+---------+---------+
          |
          | Deliver message
          v
+-------------------+
|      Worker       |
+---------+---------+
          |
          | Execute task
          v
+-------------------+
|   Processing OK?  |
+----+-----------+--+
     |           |
    Yes          No
     |           |
     v           v
 ACK/Delete   Classify error
                 |
          +------+------+
          |             |
     Retryable      Permanent
          |             |
          v             v
 Attempts left?        DLQ
     /       \
   Yes        No
    |          |
 Delay         DLQ
    |
    +--------> Main queue / retry queue
```

A mature flow also records state:

```text
Task ID: order-email-8451
Attempt: 3
First seen: 2026-07-30T07:00:00Z
Last error: ProviderTimeout
Next attempt: 2026-07-30T07:01:18Z
Trace ID: 15e4...
```

---

# 8. Acknowledgements, Visibility Timeouts, and Redelivery

Retries are closely connected to how a broker decides that a message has been processed.

## 8.1 Acknowledgement model

In acknowledgement-based brokers, the worker generally performs one of these actions:

| Worker action | Broker behavior |
|---|---|
| ACK | Mark message successfully processed and remove it |
| NACK/reject with requeue | Return message for another delivery |
| NACK/reject without requeue | Remove or dead-letter it, depending on configuration |
| Worker disconnects before ACK | Message may be redelivered |

The acknowledgement should normally happen **after** the required side effect has been committed.

Incorrect:

```text
ACK message -> update database -> worker crashes
```

The message is already gone, but the database operation may not have completed.

Safer:

```text
Update database -> commit transaction -> ACK message
```

This still does not eliminate every duplicate scenario. A worker can commit the transaction and crash before acknowledging the message. The broker then redelivers it. This is why idempotency is necessary.

---

## 8.2 Visibility-timeout model

Amazon SQS uses a visibility timeout rather than a traditional AMQP ACK/NACK protocol.

```text
Receive message
      |
      v
Message becomes temporarily invisible
      |
      +--> Processing succeeds -> delete message
      |
      +--> Processing fails/crashes -> do not delete
                                      |
                                      v
                            Visibility timeout expires
                                      |
                                      v
                             Message visible again
```

The timeout must be long enough for normal processing. If it is too short, another worker may receive the same message while the first worker is still processing it. If it is too long, recovery after a crash is delayed.

For variable-duration tasks, use a heartbeat to extend visibility while the worker is still making progress.

---

## 8.3 Redelivery is not always application retry

Two retry mechanisms may exist:

1. **Broker redelivery** because the message was not acknowledged or deleted.
2. **Application retry** where the task code intentionally schedules another attempt.

They should not be configured independently without thought. Otherwise, the total attempts can be much larger than expected.

Example:

```text
Application retries: 3
Broker deliveries per application attempt: 5
Possible processing executions: up to 15
```

Define one clear owner for the retry count or calculate the combined behavior explicitly.

---

# 9. Idempotency: The Safety Net for Retries

At-least-once delivery systems can execute the same message more than once. A retry-safe task should therefore be idempotent.

> An idempotent task produces the same final state when the same logical operation is applied multiple times.

## 9.1 Unsafe example

```python
def charge_customer(customer_id: str, amount_cents: int) -> None:
    payment_gateway.charge(customer_id, amount_cents)
```

If the worker charges the customer and crashes before acknowledging the message, the task may charge the customer again.

---

## 9.2 Safer example with an idempotency key

```python
def charge_customer(
    order_id: str,
    customer_id: str,
    amount_cents: int,
) -> None:
    payment_gateway.charge(
        customer_id=customer_id,
        amount_cents=amount_cents,
        idempotency_key=f"order-charge:{order_id}",
    )
```

The downstream provider returns the original result when the same key is submitted again.

---

## 9.3 Database deduplication

```sql
CREATE TABLE processed_messages (
    message_id UUID PRIMARY KEY,
    processed_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
```

A consumer can reserve the message ID in the same database transaction as its business update.

```python
from uuid import UUID


def process_order_event(db, message_id: UUID, order_id: UUID) -> None:
    with db.transaction():
        inserted = db.execute(
            """
            INSERT INTO processed_messages (message_id)
            VALUES (%s)
            ON CONFLICT DO NOTHING
            RETURNING message_id
            """,
            [message_id],
        ).fetchone()

        if inserted is None:
            return  # Duplicate delivery; work was already committed.

        db.execute(
            "UPDATE orders SET confirmation_sent = TRUE WHERE id = %s",
            [order_id],
        )
```

This is commonly called the **idempotent consumer** pattern.

---

## 9.4 Idempotency storage considerations

The deduplication key should be:

- Stable across retries
- Unique to the logical operation
- Stored for at least the maximum possible redelivery period
- Written atomically with the business effect when possible

Do not generate a new idempotency key during every attempt. That defeats deduplication.

---

# 10. Retry at the Correct Layer

A production request may pass through several layers:

```text
Task framework -> service client -> HTTP SDK -> load balancer -> downstream service
```

Each layer may already retry. Uncoordinated retries multiply traffic.

Example:

```text
Celery task retries:        4 attempts
HTTP client retries:        3 attempts each
Downstream SDK retries:     2 attempts each

Maximum downstream calls = 4 × 3 × 2 = 24
```

During an outage, 1,000 task messages could create up to 24,000 downstream calls.

## 10.1 Practical ownership model

Use different retry scopes for different failures:

| Layer | Retry responsibility |
|---|---|
| Network/SDK | Very short transport-level retries |
| Task/application | Business-aware retries over seconds or minutes |
| Broker | Redelivery after worker loss; final delivery limit/DLQ |
| Scheduled reconciliation | Long-term recovery after extended outage |

Keep low-level retries small, and let the application-level task policy control the broader time window.

---

## 10.2 Circuit breaker interaction

A circuit breaker temporarily stops calls to a failing dependency.

```text
Closed -> failures cross threshold -> Open -> wait -> Half-open -> test request
```

Retry and circuit breaker solve different problems:

- **Retry:** Reattempts an individual operation.
- **Circuit breaker:** Protects the system from repeatedly calling a dependency that is broadly unhealthy.

A good combination is:

```text
Per request: timeout + small retry
Across requests: circuit breaker
Across task lifetime: exponential retry + DLQ
```

When the circuit is open, the task should normally schedule a later retry rather than repeatedly calling the dependency.

---

# 11. Practical Python Retry Implementation

The following asynchronous helper includes:

- Retryable exception filtering
- Exponential backoff
- Full jitter
- Maximum delay
- Maximum attempts
- A total time budget

```python
from __future__ import annotations

import asyncio
import random
import time
from collections.abc import Awaitable, Callable
from typing import TypeVar

T = TypeVar("T")


class RetryExhaustedError(RuntimeError):
    pass


async def retry_async(
    operation: Callable[[], Awaitable[T]],
    *,
    retry_on: tuple[type[Exception], ...],
    max_attempts: int = 5,
    base_delay_seconds: float = 1.0,
    max_delay_seconds: float = 30.0,
    max_elapsed_seconds: float = 120.0,
) -> T:
    if max_attempts < 1:
        raise ValueError("max_attempts must be at least 1")

    started_at = time.monotonic()
    last_exception: Exception | None = None

    for attempt in range(1, max_attempts + 1):
        try:
            return await operation()
        except retry_on as exc:
            last_exception = exc

            if attempt == max_attempts:
                break

            exponential_cap = min(
                max_delay_seconds,
                base_delay_seconds * (2 ** (attempt - 1)),
            )

            # Full jitter: choose a random duration from zero to the cap.
            delay = random.uniform(0, exponential_cap)
            elapsed = time.monotonic() - started_at

            if elapsed + delay > max_elapsed_seconds:
                break

            await asyncio.sleep(delay)

    raise RetryExhaustedError(
        f"Operation failed after {max_attempts} configured attempts"
    ) from last_exception
```

Usage:

```python
import httpx


async def fetch_inventory() -> dict:
    async with httpx.AsyncClient(timeout=10.0) as client:
        response = await client.get("https://inventory.internal/items/42")

        if response.status_code in {429, 500, 502, 503, 504}:
            raise RetryableTaskError(
                f"Inventory service returned {response.status_code}"
            )

        response.raise_for_status()
        return response.json()


inventory = await retry_async(
    fetch_inventory,
    retry_on=(RetryableTaskError, httpx.TransportError),
    max_attempts=5,
    base_delay_seconds=1,
    max_delay_seconds=20,
    max_elapsed_seconds=60,
)
```

In a real queue consumer, do not sleep inside a worker for long retry delays. Reschedule the message through the task system or a retry queue so the worker slot can process other work.

---

# 12. Celery Retry Configuration

Celery supports explicit retry through `Task.retry()` and automatic retry through task options.

The examples below match the current stable Celery 5.6 documentation reviewed in July 2026.

## 12.1 Explicit retry

```python
from celery import shared_task
import httpx


@shared_task(bind=True, max_retries=5)
def synchronize_customer(self, customer_id: str) -> None:
    try:
        response = httpx.post(
            "https://crm.example.com/sync",
            json={"customer_id": customer_id},
            timeout=10.0,
        )
        response.raise_for_status()

    except (httpx.TimeoutException, httpx.NetworkError) as exc:
        countdown = min(300, 2 ** self.request.retries)
        raise self.retry(exc=exc, countdown=countdown)
```

Important details:

- A bound task receives `self`.
- `self.request.retries` starts at zero.
- `self.retry()` raises Celery's internal `Retry` exception.
- Retried executions use the same Celery task ID and are sent to the same destination queue.

---

## 12.2 Automatic retry with backoff and jitter

```python
from celery import shared_task
import httpx


@shared_task(
    autoretry_for=(httpx.TimeoutException, httpx.NetworkError),
    retry_kwargs={"max_retries": 5},
    retry_backoff=True,
    retry_backoff_max=600,
    retry_jitter=True,
)
def synchronize_customer(customer_id: str) -> None:
    response = httpx.post(
        "https://crm.example.com/sync",
        json={"customer_id": customer_id},
        timeout=10.0,
    )
    response.raise_for_status()
```

With Celery's automatic retry settings:

- `retry_backoff=True` enables exponential backoff.
- `retry_backoff_max` caps the delay in seconds.
- `retry_jitter=True` randomizes delay to spread retry traffic.
- `autoretry_for` should contain only exceptions that are safe to retry.

Avoid this broad configuration unless every exception is genuinely retryable:

```python
@shared_task(autoretry_for=(Exception,))
def process_message(payload: dict) -> None:
    ...
```

It may repeatedly retry validation errors, programming bugs, and permanent business failures.

---

## 12.3 Separate permanent and retryable failures

```python
from celery import shared_task
from pydantic import BaseModel, ValidationError
import httpx


class CustomerSyncPayload(BaseModel):
    customer_id: str
    email: str


@shared_task(bind=True, max_retries=5)
def synchronize_customer(self, raw_payload: dict) -> None:
    try:
        payload = CustomerSyncPayload.model_validate(raw_payload)
    except ValidationError as exc:
        record_terminal_failure(
            payload=raw_payload,
            reason="validation_error",
            details=str(exc),
        )
        return

    try:
        send_to_crm(payload.model_dump())
    except (httpx.TimeoutException, httpx.NetworkError) as exc:
        raise self.retry(exc=exc, countdown=calculate_retry_delay(self.request.retries))
```

The task does not retry malformed input. It retries only temporary transport failures.

---

## 12.4 Celery and a DLQ

Celery's `max_retries` marks a task as failed after the limit, but a broker-level DLQ is a separate concern.

Common choices are:

1. Record terminal task failures in an application failure table.
2. Publish a sanitized failure envelope to a dedicated failure queue.
3. Configure RabbitMQ dead-lettering for rejected messages.
4. Configure the underlying SQS queue with an SQS DLQ.

A useful terminal-failure envelope:

```json
{
  "original_task_id": "be45e9ad-...",
  "task_name": "customers.synchronize_customer",
  "payload_reference": "s3://secure-bucket/tasks/be45e9ad.json",
  "attempts": 6,
  "failure_type": "crm_timeout",
  "last_error": "ReadTimeout",
  "failed_at": "2026-07-30T07:30:00Z",
  "trace_id": "f7ac2d...",
  "schema_version": 2
}
```

Avoid copying secrets, access tokens, full card details, or sensitive personal data into the DLQ payload.

---

# 13. Amazon SQS with a DLQ

Amazon SQS moves a repeatedly received message to a configured DLQ after its receive count exceeds the source queue's `maxReceiveCount` policy.

```text
orders-main
    |
    | receive count exceeds limit
    v
orders-dlq
```

## 13.1 Redrive policy example

```json
{
  "deadLetterTargetArn": "arn:aws:sqs:us-east-1:123456789012:orders-dlq",
  "maxReceiveCount": "5"
}
```

Interpretation:

- A consumer receives a message from `orders-main`.
- If it is not deleted successfully, it becomes visible again after its visibility timeout.
- The receive count increases with repeated deliveries.
- After the configured threshold is exceeded, SQS moves it to `orders-dlq`.

Do not set the value too low. A count of one would dead-letter a message after a single failed receive cycle, leaving little tolerance for transient worker or network failures.

---

## 13.2 Consumer example with error classification

```python
from __future__ import annotations

import json
import logging
from typing import Any

import boto3
from botocore.exceptions import BotoCoreError, ClientError

logger = logging.getLogger(__name__)
sqs = boto3.client("sqs")

QUEUE_URL = "https://sqs.us-east-1.amazonaws.com/123456789012/orders-main"


class PermanentMessageError(Exception):
    pass


def process_order(payload: dict[str, Any]) -> None:
    if "order_id" not in payload:
        raise PermanentMessageError("order_id is required")

    # Perform idempotent business processing here.


def consume_once() -> None:
    response = sqs.receive_message(
        QueueUrl=QUEUE_URL,
        MaxNumberOfMessages=10,
        WaitTimeSeconds=20,
        AttributeNames=["ApproximateReceiveCount"],
    )

    for message in response.get("Messages", []):
        receipt_handle = message["ReceiptHandle"]
        receive_count = int(message["Attributes"]["ApproximateReceiveCount"])

        try:
            payload = json.loads(message["Body"])
            process_order(payload)

        except (json.JSONDecodeError, PermanentMessageError):
            # Do not delete the message. It will eventually reach the broker DLQ
            # through the redrive policy. Optionally shorten visibility to speed
            # up terminal routing, but guard against a high-frequency hot loop.
            logger.exception(
                "Permanent message failure",
                extra={"receive_count": receive_count},
            )

        except (BotoCoreError, ClientError, TimeoutError):
            # Temporary failure: leave the message undeleted so SQS can redeliver it.
            logger.exception(
                "Retryable processing failure",
                extra={"receive_count": receive_count},
            )

        else:
            sqs.delete_message(
                QueueUrl=QUEUE_URL,
                ReceiptHandle=receipt_handle,
            )
```

This simplified example relies on SQS redelivery. Production code should also include:

- Per-operation timeouts
- Visibility extension for long processing
- Idempotency
- Structured logs and tracing
- Graceful shutdown
- Batch partial-failure handling where applicable
- An explicit approach for permanent failures instead of repeatedly burning through the receive limit

---

## 13.3 Visibility timeout and backoff

SQS visibility timeout acts as the processing lease. It is not automatically an exponential retry scheduler.

A consumer may adjust visibility for a failed message:

```python
sqs.change_message_visibility(
    QueueUrl=QUEUE_URL,
    ReceiptHandle=receipt_handle,
    VisibilityTimeout=next_retry_delay_seconds,
)
```

Use this carefully:

- Keep the delay within the SQS visibility constraints.
- Do not hold messages invisible for longer than their business usefulness.
- Remember that a received message is counted as in flight.
- Use a heartbeat to extend visibility only while real processing is active.

For complex retry schedules, teams often use dedicated retry queues, EventBridge Scheduler, Step Functions, or application scheduling rather than depending entirely on visibility changes.

---

## 13.4 Retention behavior

For SQS standard queues, a message's original enqueue timestamp is retained when it moves to a DLQ. Therefore, the DLQ retention period should generally be longer than the source queue retention period.

For FIFO queues, the enqueue timestamp resets when the message moves to the DLQ.

Also consider ordering: moving one failed FIFO message to a DLQ can allow later work to proceed and may break the business sequence expected by the application. Ordering-sensitive workflows require a deliberate recovery design.

---

## 13.5 SQS redrive

SQS can move DLQ messages back to a source queue or another destination queue through DLQ redrive.

Redrive should be controlled because a large batch can overload the recovered service.

A safe process is:

```text
Fix root cause
   -> test one message
   -> redrive a small batch
   -> monitor error and latency metrics
   -> gradually increase redrive velocity
```

Do not redrive the entire queue merely because the deployment has completed.

---

# 14. RabbitMQ Retry and Dead-Letter Exchanges

RabbitMQ uses a **Dead Letter Exchange (DLX)**. A queue dead-letters a message to an exchange, and that exchange routes the message to one or more queues.

```text
Main Queue --dead-letter--> DLX --> Dead-Letter Queue
```

A message may be dead-lettered when:

- A consumer rejects or negatively acknowledges it with `requeue=false`.
- The message expires.
- The queue exceeds a length limit under the configured behavior.
- A quorum queue message exceeds its delivery limit.

---

## 14.1 Basic DLX policy

Policies are generally preferable to hard-coded queue arguments because operations teams can update them without redeploying every producer or consumer.

```bash
rabbitmqctl set_policy orders-dlx \
  '^orders\.main$' \
  '{"dead-letter-exchange":"orders.dead","dead-letter-routing-key":"orders.failed"}' \
  --apply-to queues
```

Topology:

```text
orders.exchange
      |
      v
orders.main queue
      |
      | reject(requeue=false)
      v
orders.dead exchange
      |
      v
orders.dlq queue
```

---

## 14.2 Consumer acknowledgement behavior

```python
import json
import pika


class PermanentMessageError(Exception):
    pass


def callback(channel, method, properties, body: bytes) -> None:
    try:
        payload = json.loads(body)
        process_order(payload)

    except PermanentMessageError:
        # Reject without requeue. The DLX policy can route it to the DLQ.
        channel.basic_nack(
            delivery_tag=method.delivery_tag,
            requeue=False,
        )

    except RetryableTaskError:
        # Direct requeue is simple but can create a tight redelivery loop.
        channel.basic_nack(
            delivery_tag=method.delivery_tag,
            requeue=True,
        )

    else:
        channel.basic_ack(delivery_tag=method.delivery_tag)
```

Repeated immediate `requeue=True` calls are dangerous because the same message can circulate rapidly. Prefer delayed retry queues or a retry scheduler for recoverable failures.

---

## 14.3 Delayed retry queues with TTL and DLX

A common RabbitMQ design uses separate retry queues.

```text
                         processing failure
                                |
                                v
Main Queue ---> Worker ---> Retry Exchange
   ^                            |
   |                            v
   +---- DLX after TTL ---- Retry Queue (no consumer)
```

Example retry tiers:

```text
orders.retry.10s
orders.retry.1m
orders.retry.10m
```

Each retry queue has:

- A queue-level message TTL
- A dead-letter exchange pointing back to the main exchange
- No consumer

When the TTL expires, RabbitMQ dead-letters the message back to the main route.

Example arguments for a 60-second retry queue:

```json
{
  "x-message-ttl": 60000,
  "x-dead-letter-exchange": "orders.exchange",
  "x-dead-letter-routing-key": "orders.process"
}
```

Using delay buckets avoids keeping a worker asleep and provides predictable retry intervals.

---

## 14.4 Quorum queue delivery limits

RabbitMQ quorum queues track unsuccessful redelivery attempts in the `x-delivery-count` header.

In RabbitMQ 4.2 documentation, quorum queues have a default delivery limit of 20, introduced starting with RabbitMQ 4.0. When the limit is crossed, the message is dropped unless dead-lettering is configured.

For that reason, configure a DLX for quorum queues that may contain important messages.

Example policy:

```bash
rabbitmqctl set_policy qq-overrides \
  '^orders\.' \
  '{"delivery-limit":5,"dead-letter-exchange":"orders.dead"}' \
  --priority 100 \
  --apply-to quorum_queues
```

Do not disable delivery limits casually. Unlimited redelivery can preserve a poison-message loop and consume storage or worker capacity indefinitely.

---

## 14.5 Avoid dead-letter cycles

It is possible to route a dead-lettered message back into the same queue repeatedly.

```text
Queue A -> DLX -> Queue A -> DLX -> Queue A
```

Use explicit exchanges, routing keys, and topology tests. RabbitMQ can detect certain dead-letter cycles and drop messages, but the application should not depend on cycle detection as its retry policy.

---

# 15. Google Cloud Pub/Sub Dead-Letter Topics

Google Cloud Pub/Sub configures dead lettering on a **subscription**, not on the source topic itself.

```text
Source Topic
     |
     v
Subscription ---> Subscriber
     |
     | delivery attempts exhausted
     v
Dead-Letter Topic ---> DLQ Subscription ---> Investigation worker
```

The current official documentation allows a maximum-delivery-attempt value from 5 to 100, with a default of 5 when dead lettering is configured.

Example command:

```bash
gcloud pubsub subscriptions create orders-subscription \
  --topic=orders \
  --dead-letter-topic=orders-dead-letter \
  --max-delivery-attempts=10
```

Important operational detail: create a subscription on the dead-letter topic. A topic alone does not provide a consumer backlog that your investigation worker can read later.

Pub/Sub subscription retry can use:

- Immediate redelivery
- Exponential backoff

The service account used by Pub/Sub also needs permission to publish to the dead-letter topic and acknowledge forwarded messages on the source subscription.

---

# 16. DLQ Redrive and Message Recovery

**Redrive** means moving a failed message from the DLQ back into normal processing.

Redrive is not equivalent to retrying. It is an operational recovery action taken after understanding the failure.

## 16.1 Safe redrive process

```text
1. Detect DLQ growth
2. Inspect representative failures
3. Group messages by root cause
4. Fix code, configuration, credentials, or data
5. Validate the fix in a non-production environment where possible
6. Redrive one or a small sample
7. Confirm successful side effects
8. Redrive gradually with rate controls
9. Monitor main-queue age, failures, and dependency health
10. Close the incident with an audit record
```

---

## 16.2 Redrive options

| Option | Suitable when |
|---|---|
| Redrive unchanged | Message was valid; code or dependency was fixed |
| Transform then redrive | Schema or data requires a known correction |
| Send to a dedicated recovery workflow | Manual review or enrichment is required |
| Discard with audit record | Message is obsolete, invalid, or legally required to be removed |
| Compensate instead of redrive | Original operation is no longer safe or useful |

---

## 16.3 Do not redrive blindly

Blind redrive can cause:

- Duplicate payments
- Duplicate emails or notifications
- Repeated webhook delivery
- Inventory double-decrement
- Reopening completed workflows
- Another retry storm

Before redrive, confirm:

```text
Is the operation idempotent?
Is the message still valid?
Has its business deadline expired?
Did part of the operation already succeed?
Can the dependency absorb the redrive rate?
Does the payload match the current schema?
```

---

## 16.4 Schema evolution

A DLQ message may remain stored across several deployments. Its payload may use an older schema.

Include a schema version:

```json
{
  "schema_version": 3,
  "event_type": "order.confirmation.requested",
  "order_id": "8451"
}
```

At redrive time, use one of these approaches:

- Support multiple schema versions in the consumer.
- Transform the old payload to the current version.
- Route old messages to a compatibility worker.
- Reject versions that are no longer safe, with an auditable reason.

---

## 16.5 Redrive identity

Preserve the original logical operation identity during redrive.

Useful fields:

```text
original_message_id
original_task_id
correlation_id
causation_id
first_enqueued_at
first_failed_at
redrive_batch_id
redrive_count
```

Do not lose the original ID and create a completely unrelated operation identity, especially when idempotency depends on that ID.

---

# 17. Observability and Alerting

A retry and DLQ design is incomplete without metrics, logs, traces, and ownership.

## 17.1 Core metrics

| Metric | Why it matters |
|---|---|
| Task success rate | Shows overall processing health |
| Retry count/rate | Early warning before DLQ growth |
| Attempts per successful task | Indicates dependency instability |
| DLQ message count | Shows unresolved failures |
| DLQ ingress rate | Detects active incidents |
| Age of oldest DLQ message | Shows unresolved operational debt |
| Main queue depth | Shows backlog |
| Age of oldest main-queue message | Better than depth alone for user impact |
| Processing latency | Measures task completion time |
| Redrive success/failure rate | Confirms recovery quality |
| Visibility extensions or NACK count | Indicates long or failing processing |
| Failure count by exception/category | Helps find root cause quickly |

---

## 17.2 Useful structured log fields

```json
{
  "event": "task_retry_scheduled",
  "task_name": "orders.send_confirmation",
  "message_id": "8ea7...",
  "correlation_id": "checkout-8451",
  "attempt": 3,
  "max_attempts": 6,
  "error_type": "EmailProviderTimeout",
  "retry_delay_seconds": 18.4,
  "queue": "email-main",
  "worker": "worker-email-07"
}
```

Do not rely only on a free-text exception stack. Structured fields make grouping and alerting practical.

---

## 17.3 Alert examples

### Urgent alert

```text
DLQ ingress > 100 messages in 5 minutes
AND failure type is payment_processing_error
```

### Warning alert

```text
Retry rate > 10% for 15 minutes
```

### Operational-debt alert

```text
Oldest DLQ message age > 24 hours
```

A single DLQ message may be urgent for payment or security workflows but low priority for analytics enrichment. Alerts should reflect business impact, not only queue size.

---

## 17.4 Trace retry attempts as one logical operation

All attempts should share a stable correlation or trace relationship.

```text
Logical task: order-confirmation-8451
    |
    +-- attempt 1: timeout
    +-- attempt 2: HTTP 503
    +-- attempt 3: success
```

Preserve:

- Logical task ID
- Attempt-specific span ID
- Original request trace ID
- Retry number
- Retry reason

This helps distinguish one task retried five times from five unrelated tasks.

---

# 18. Production Design Example

Consider an order-confirmation workflow.

## 18.1 Requirements

- Confirmation should normally arrive within one minute.
- Email-provider failures are retryable.
- Invalid email addresses are permanent failures.
- Duplicate emails should be avoided.
- Failures must remain recoverable for seven days.

## 18.2 Proposed design

```text
Checkout Service
      |
      | event_id + order_id
      v
Order Confirmation Queue
      |
      v
Email Worker
      |
      +--> Validate payload
      |       |
      |       +--> invalid -> DLQ/failure queue
      |
      +--> Check idempotency record
      |       |
      |       +--> already sent -> ACK
      |
      +--> Call email provider with idempotency key
              |
              +--> success -> store sent status -> ACK
              |
              +--> timeout/429/5xx
                       |
                       +--> exponential retry with jitter
                       |
                       +--> attempts exhausted -> DLQ
```

## 18.3 Suggested policy

```text
Attempt 1: immediately
Retry 1: 1–3 seconds
Retry 2: 2–6 seconds
Retry 3: 5–15 seconds
Retry 4: 15–30 seconds
Retry 5: 30–60 seconds
Then: DLQ
```

The exact values must be load-tested and matched to provider rate limits.

## 18.4 Idempotency table

```sql
CREATE TABLE email_delivery_operations (
    operation_key TEXT PRIMARY KEY,
    order_id UUID NOT NULL,
    provider_message_id TEXT,
    status TEXT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
```

Operation key:

```text
order-confirmation:{order_id}
```

## 18.5 DLQ record

```json
{
  "schema_version": 1,
  "message_id": "93a2...",
  "operation_key": "order-confirmation:8451",
  "order_id": "8451",
  "failure_category": "provider_unavailable",
  "attempt_count": 6,
  "first_attempt_at": "2026-07-30T07:00:00Z",
  "last_attempt_at": "2026-07-30T07:01:02Z",
  "last_error": "HTTP 503",
  "trace_id": "b390..."
}
```

## 18.6 Recovery

When the provider recovers:

1. Verify that no provider-side request succeeded without a local acknowledgement.
2. Query by idempotency key or provider status where possible.
3. Redrive a small batch.
4. Confirm duplicate protection works.
5. Increase redrive rate while watching provider errors and queue age.

---

# 19. Decision Tables

## 19.1 Retry or do not retry?

| Failure | Retry? | Reason |
|---|---:|---|
| Network timeout | Yes | Usually transient |
| HTTP 429 | Yes | Rate limit may clear; respect retry guidance |
| HTTP 503 | Yes | Service may recover |
| Database deadlock | Usually | Transaction can succeed on a later attempt |
| Invalid JSON | No | Same payload will fail again |
| Missing mandatory field | No | Requires data correction |
| Authentication token expired | Yes, after refresh | Recoverable if credentials can be refreshed |
| Credentials permanently revoked | No | Requires configuration or operational fix |
| Business rule declined | Usually no | Repetition does not change the decision |
| Unknown application exception | Limited | Small retry budget, then DLQ and alert |

---

## 19.2 Retry strategy selection

| Situation | Strategy |
|---|---|
| Very short concurrency conflict | Small immediate or jittered retry |
| Predictable dependency recovery | Fixed delay |
| Moderate gradual recovery | Linear backoff |
| External service outage | Exponential backoff with jitter |
| Provider gives `Retry-After` | Honor it within application limits |
| Task no longer useful after deadline | Retry time budget plus expiration |
| Large fleet fails simultaneously | Exponential backoff, jitter, rate limiting, circuit breaker |

---

## 19.3 Main queue versus retry queue versus DLQ

| Queue | Purpose | Consumer behavior |
|---|---|---|
| Main queue | Ready-to-process work | Normal workers consume it |
| Retry queue | Work waiting for a future attempt | Usually delayed or TTL-based; often no direct consumer |
| DLQ | Terminal or exhausted failures | Investigation/recovery worker or operator consumes it |

---

## 19.4 Broker comparison

| Technology | Retry mechanism | Dead-letter mechanism | Important detail |
|---|---|---|---|
| Celery | `retry()`, `autoretry_for`, countdown/backoff | Depends on result handling and underlying broker | Task retry and broker DLQ are separate layers |
| Amazon SQS | Visibility timeout/redelivery, application scheduling | DLQ redrive policy with `maxReceiveCount` | Delete only after success; plan retention and redrive |
| RabbitMQ | Requeue, retry queues, TTL/DLX, application scheduling | Dead Letter Exchange routes to DLQ | Avoid immediate requeue loops and DLX cycles |
| Google Pub/Sub | Immediate redelivery or exponential-backoff retry policy | Dead-letter topic configured per subscription | Dead-letter topic needs its own subscription |

---

## 19.5 Production checklist

### Retry policy

- [ ] Retry only known transient failures.
- [ ] Use a maximum attempt count.
- [ ] Use a total retry time budget.
- [ ] Configure per-attempt network and database timeouts.
- [ ] Use exponential backoff for external dependencies.
- [ ] Add jitter for distributed workers.
- [ ] Cap maximum delay.
- [ ] Respect valid server retry guidance.
- [ ] Prevent nested retry multiplication across layers.

### Message safety

- [ ] Make handlers idempotent.
- [ ] Use stable message and operation IDs.
- [ ] Acknowledge/delete only after successful commit.
- [ ] Make visibility timeout longer than normal processing time.
- [ ] Extend visibility for legitimately long work.
- [ ] Handle worker shutdown without silently losing messages.

### DLQ operations

- [ ] Configure a DLQ or terminal-failure store.
- [ ] Retain enough context to diagnose the failure.
- [ ] Avoid storing secrets or unnecessary sensitive data.
- [ ] Alert on DLQ ingress and oldest-message age.
- [ ] Assign a team owner and response procedure.
- [ ] Test redrive in a controlled batch.
- [ ] Rate-limit redrive.
- [ ] Preserve original identity and schema version.
- [ ] Audit transformed, discarded, and redriven messages.

---

# 20. Key Takeaways

1. **Retry only failures that have a realistic chance of recovery.** Validation and permanent business failures should not consume repeated attempts.

2. **Exponential backoff with jitter is the usual production default** for temporary downstream failures because it reduces pressure and spreads worker traffic.

3. **Every retry policy needs a stopping condition.** Use maximum attempts, a maximum elapsed time, task expiry, or a combination.

4. **A DLQ isolates unresolved messages; it does not resolve them.** Monitoring, ownership, investigation, and redrive procedures are still required.

5. **Idempotency is essential in at-least-once systems.** A message may be executed again after a worker crash, timeout, or lost acknowledgement.

6. **Application retries and broker redeliveries are different.** Count the combined behavior so that retries do not multiply unexpectedly.

7. **Acknowledge or delete only after durable success.** Even then, design for the commit-succeeded-but-ACK-failed scenario.

8. **Redrive slowly and deliberately.** Confirm the root cause is fixed, validate a small batch, and monitor the recovered dependency.

9. **Keep failure context structured.** Message IDs, attempt counts, failure categories, timestamps, trace IDs, and schema versions make recovery practical.

10. **Treat DLQ age as operational debt.** A growing or old DLQ is unfinished production work, not harmless storage.

---

# 21. Official References

The following primary documentation was used to verify current platform behavior:

1. [Celery 5.6 User Guide](https://docs.celeryq.dev/en/stable/userguide/)
2. [Celery Tasks: Retrying](https://docs.celeryq.dev/en/stable/userguide/tasks.html#retrying)
3. [Amazon SQS: Using Dead-Letter Queues](https://docs.aws.amazon.com/AWSSimpleQueueService/latest/SQSDeveloperGuide/sqs-dead-letter-queues.html)
4. [Amazon SQS: Visibility Timeout](https://docs.aws.amazon.com/AWSSimpleQueueService/latest/SQSDeveloperGuide/sqs-visibility-timeout.html)
5. [Amazon SQS: Configuring DLQ Redrive](https://docs.aws.amazon.com/AWSSimpleQueueService/latest/SQSDeveloperGuide/sqs-configure-dead-letter-queue-redrive.html)
6. [RabbitMQ 4.2 Documentation](https://www.rabbitmq.com/docs/4.2)
7. [RabbitMQ Quorum Queues: Poison Message Handling](https://www.rabbitmq.com/docs/4.2/quorum-queues#poison-message-handling)
8. [RabbitMQ Dead Letter Exchanges](https://www.rabbitmq.com/docs/dlx)
9. [RabbitMQ Reliability Guide](https://www.rabbitmq.com/docs/4.2/reliability)
10. [Google Cloud Pub/Sub: Dead-Letter Topics](https://cloud.google.com/pubsub/docs/dead-letter-topics)
11. [Google Cloud Pub/Sub: Subscription Retry Policy](https://cloud.google.com/pubsub/docs/subscription-retry-policy)

---

> **Related topics:** Idempotency in Background Tasks, Message Brokers, Celery Architecture, Event-Driven Architecture, Outbox Pattern, Consumer Acknowledgements, Visibility Timeout, Circuit Breaker Pattern, and Distributed Tracing.
