---
title: "Design a Notification System"
group: "Classic Designs"
order: 15
---

# Design a Multi-Channel Notification System

> A notification system is a pipeline from domain event to delivered message, and every hard part is a filter in the middle: preferences and quiet hours decide whether to send at all, deduplication decides whether this is a repeat, per-user rate limits decide whether the user is being spammed, and only then does a channel adapter hand it to a provider that will fail some of the time.

## What it is
One event, many possible messages. The pipeline is worth drawing as stages, because each stage is where a different class of bug lives:

| Stage | Decides | Owns |
| --- | --- | --- |
| **Ingest** | That something happened | Reads the **outbox**, so no event is lost or duplicated by a dual write |
| **Resolve** | Who is notified, on which channels | Preference matrix, quiet hours, locale |
| **Suppress** | Whether to send *this* one | Dedupe key, cooldown, per-user rate limit, suppression list |
| **Render** | What it says | Versioned templates per channel and locale, escaped |
| **Dispatch** | How it goes out | Per-channel queue, provider adapter, retries |
| **Track** | What actually happened | Delivered, bounced, complained, opened; feeds suppression |

> [!KEY] Split **transactional** from **marketing** at the top of the pipeline and never merge them again. An OTP or a failed-payment alert must ignore quiet hours, jump the queue, and cannot be unsubscribed from; a campaign must respect every preference and carry an unsubscribe path. Same infrastructure, different lane - a 500,000-message blast must never sit in front of a login code.

For in-app notifications there is a second decision, the classic fan-out question:

| Strategy | Write cost | Read cost | Use when |
| --- | --- | --- | --- |
| **Fan-out on write** | One row **per recipient** | Cheap: read your own list | Normal case: recipients are few and reads are frequent |
| **Fan-out on read** | One row per **event** | Expensive: merge at query time | Broadcasts to huge audiences, rarely read |
| **Hybrid** | Per-recipient for normal, per-event for broadcasts | Merge two sources | Both patterns coexist - the usual production answer |

## Key points
- **Trigger from the outbox, not from a signal or the request handler.** The event that says "payment failed" must be written in the same transaction as the payment state change, then read by the notification service. A `post_save` signal that emails inline fires on a transaction that may still roll back, and it puts an SMTP round trip in the user's request.
- **Preferences are a matrix, with a default and a category.** The key is `(user, category, channel)` - "payment alerts by email and push, marketing by nothing" - and the row you store is the *deviation* from the default so adding a category does not require backfilling every user. Store the user's IANA timezone (`Asia/Kolkata`, never a UTC offset, because offsets change with DST) and defer non-urgent sends to the next allowed window by scheduling them with a `run_at`, rather than dropping them.
- **Deduplicate on a key you derive, not on a timestamp heuristic.** A unique constraint on `(event_id, user_id, channel)` makes the whole pipeline replay-safe: an at-least-once queue redelivery collides on insert and sends nothing. Layer a **cooldown** above it - at most one "low balance" notice per user per hour - and a **digest** for anything chatty, which turns 50 events into one email and is usually what the user wanted.
- **Rate limit per user and per provider, for different reasons.** Per user it is product quality: a token bucket in Redis keyed `notif:{user}:{channel}` stops a retry loop from sending 200 push notifications. Per provider it is survival: SES starts every account in a **sandbox at 200 messages per 24 hours and 1 per second**, and a production quota is still finite, so a shaper in front of the adapter smooths a burst instead of collecting 429s.
- **Track delivery, and feed it back into suppression.** The states are `queued -> sent -> delivered`, with `bounced`, `complained` and `opened` branching off. A **hard bounce means never send to that address again** - SES keeps an account-level suppression list, and you should keep your own too. This is not hygiene, it is uptime: AWS reviews an account whose bounce rate passes **5%** or complaint rate passes **0.1%**, and can pause sending entirely.
- **Failover between providers is for outages, not for routine load balancing.** Wrap each provider behind one adapter interface, add a circuit breaker, and keep your own message id mapped to theirs. But email reputation is per sending domain and IP, so an unplanned switch can land you in spam folders - which means the failover path needs warmed credentials and periodic testing, or it will fail exactly when you finally use it.

> [!TIP] Store the **rendered** message body, not just the template id and variables. When a customer asks what your system told them on 3 March, re-rendering today's template with today's data is a guess. A snapshot is the answer, and for payment and KYC notices it is the compliance answer.

## Example
The schema carries the guarantees. The unique index is the deduplication:

```sql
CREATE TABLE notification (
  id           BIGSERIAL PRIMARY KEY,
  user_id      BIGINT NOT NULL,
  category     TEXT   NOT NULL,           -- 'payment.failed', 'kyc.approved', 'marketing.weekly'
  channel      TEXT   NOT NULL,           -- 'email' | 'sms' | 'push' | 'in_app'
  event_id     TEXT   NOT NULL,           -- from the producer's outbox row
  status       TEXT   NOT NULL DEFAULT 'queued',
  rendered     JSONB  NOT NULL,           -- what we actually sent, kept for disputes
  provider_id  TEXT,                      -- their message id, for matching delivery events
  send_after   TIMESTAMPTZ NOT NULL DEFAULT now()   -- quiet hours push this forward
);
-- One notification per event, per user, per channel. A redelivered task collides here
-- and sends nothing, which is cheaper and safer than checking first.
CREATE UNIQUE INDEX notification_dedupe ON notification (event_id, user_id, channel);
CREATE INDEX notification_unread ON notification (user_id, id DESC) WHERE status <> 'read';
```

The dispatcher, with the filters in the order that costs least first:

```python
@app.task(bind=True, autoretry_for=(ProviderTransient,),
          retry_backoff=True, retry_backoff_max=900, max_retries=6)
def dispatch(self, event_id: str, user_id: int, category: str) -> str:
    prefs = Preferences.for_user(user_id)
    for channel in prefs.channels_for(category):          # cheapest checks first
        if Suppression.blocks(user_id, channel):          # hard bounce or unsubscribe: terminal
            continue
        if not token_bucket_allow(f"notif:{user_id}:{channel}", limit=20, per=3600):
            continue

        send_after = prefs.next_allowed_time(channel, category)   # quiet hours, in the user's tz
        try:
            note = Notification.objects.create(
                user_id=user_id, category=category, channel=channel, event_id=event_id,
                rendered=render(category, channel, user_id, prefs.locale), send_after=send_after,
            )
        except IntegrityError:
            continue                                      # dedupe index fired: already handled

        if send_after > timezone.now():
            return "deferred"                             # a poller picks it up when due
        # Per-channel queue: a slow SMS provider must not delay password resets.
        send_via_provider.apply_async(args=[note.id], queue=f"notify.{channel}")
    return "dispatched"
```

## Interview Q&A
- **Fan-out on write or on read?** On write for the normal case - one row per recipient makes the read a single indexed query, which matters because notification lists are read constantly. Switch to on-read for broadcasts, where writing a million rows for a message most people will never open is pure waste. Production systems usually run both and merge.
- **The same event gets published twice. How does the user not see two emails?** A unique index on `(event_id, user_id, channel)`. The duplicate raises `IntegrityError` on insert and is swallowed, so deduplication is enforced by the database rather than by a check-then-act that races under concurrent workers.
- **How do quiet hours work across time zones?** Store the user's IANA timezone name and evaluate the window in local time at send time - an offset stored at signup is wrong twice a year. Non-urgent messages get their `send_after` pushed to the next allowed window instead of being dropped, and urgent transactional messages bypass the window entirely.
- **A provider goes down mid-blast. What happens?** Transient failures retry with exponential backoff and jitter on a per-channel queue, so one channel's outage cannot block the others. If the breaker opens, the adapter fails over to the standby provider. Anything that exhausts its retries lands in a DLQ with the rendered payload, so it can be replayed once the provider is back rather than lost.
- **What do you do with a bounce?** Classify it. A hard bounce (address does not exist) goes to a permanent suppression list immediately and is never retried. A soft bounce (mailbox full, greylisted) is retried with backoff and a cap. A complaint - the user pressed "spam" - is treated as harder than a hard bounce, because your sending reputation depends on the complaint rate staying under a fraction of a percent.
- **How do you keep an OTP from queueing behind a marketing campaign?** Separate queues with separate workers, and often separate provider credentials or sending identities. Priority within a single queue is not enough: a 500,000-message batch already sitting in the queue is throughput the OTP has to wait for regardless of its priority flag.

## Gotchas
> [!WARN] **One-click unsubscribe is now a deliverability requirement, not a courtesy.** Bulk senders must include `List-Unsubscribe` and `List-Unsubscribe-Post` (RFC 8058) and honour the request quickly - Gmail and Yahoo have enforced this for high-volume senders since February 2024, and CAN-SPAM gives you 10 business days. The unsubscribe link must work without login, which means a signed, non-enumerable token: a raw `?user_id=41` lets anyone unsubscribe anyone.

> [!WARN] **Retrying a "send" without a dedupe key sends the message again.** A provider timeout is ambiguous - the email may well have gone out. Only the idempotency key or the unique row makes the retry safe, and unlike a double charge, a double SMS produces no error anywhere. You find out from the customer.

- **Templates are code paths that only run in production.** An unescaped merchant name in an HTML email is stored XSS in someone's mail client, and a missing variable throws at 3 a.m. inside a worker. Render in CI against fixtures for every locale and channel.
- **Push tokens rot constantly.** FCM and APNs return an explicit "unregistered" response when the app is uninstalled; delete the token on that response, or your invalid-token rate climbs until the provider starts throttling you.
- **SMS is the expensive, most regulated channel.** In India, template and header registration on the DLT platform is mandatory and unregistered traffic is simply dropped; TCPA in the US carries per-message damages. Never treat SMS as "email with fewer characters".
- **Digest jobs re-send on replay if the window is not part of the key.** Include the period (`digest:2026-07-21:user:41`) in the dedupe key, or a retried beat tick mails the same summary twice.

## Revise next
- [Design a job scheduler](job-scheduler.md): the queues, retries and DLQ this pipeline rides on
- [Scaling WebSockets](websocket-scaling.md) for the in-app real-time delivery path
- [Retries and dead-letter queues](../task-processing/retries-dead-letter-queues.md), and [idempotency in tasks](../task-processing/idempotency-background-tasks.md)
- [Rate limiting](../api-design/rate-limiting.md) - the same token bucket, applied per user and per provider

*Reviewed against the Amazon SES developer guide, RFC 8058, and the Gmail bulk sender guidelines, July 2026.*
