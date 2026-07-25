---
title: "Payment Webhooks"
group: "Integration"
order: 4
---

# Payment Webhooks and Reliable Delivery

> A payment webhook is the provider telling you money moved, and because delivery is at-least-once, unordered, and occasionally absent entirely, a correct receiver verifies the signature over the raw bytes, acknowledges in milliseconds, dedupes on the event id, and treats a scheduled reconciliation sweep as the real guarantee rather than the webhook itself.

## What it is
The provider POSTs a JSON event to a URL you registered. The generic mechanics - HMAC over the raw body, timestamp tolerance, fast 2xx - are covered in [webhooks](../api-design/webhooks.md). What makes the payment case different is the **cost of getting it wrong in each direction**:

| Failure | Generic API webhook | Payment webhook |
| --- | --- | --- |
| Event **missed** | Stale UI until the next event | Customer paid, order never fulfilled - a **support ticket and a refund** |
| Event **duplicated** | A row written twice | **Double credit**, double shipment, double payout |
| Event **out of order** | Fields briefly stale | Refund applied **before** the capture that it reverses |
| Event **forged** | Bad data | **Money granted** for a payment that never happened |

> [!KEY] A webhook is a **latency optimisation, not a source of truth**. Design so that if every webhook for a day were silently dropped, [reconciliation](reconciliation.md) would still make the books correct the next morning - just slower. If losing webhooks loses money, the architecture is wrong regardless of how good the handler is.

Stripe's specific contract, which sets the shape of the handler: the `Stripe-Signature` header carries `t=<unix ts>` and one or more `v1=<hex hmac>` values over `t + "." + raw_body`, libraries default to a **5-minute tolerance**, events may arrive **out of order** and **more than once**, and a failing endpoint is retried with exponential backoff for **up to three days** in live mode.

## Key points
- **Read the raw bytes before anything parses them.** The HMAC is computed over the exact bytes on the wire, so a re-serialized dict never matches. In Django this means `request.body`, and in **DRF the ordering is a trap**: touching `request.data` first consumes the stream, and the later `request.body` access raises `RawPostDataException`. Read the body first, or keep the webhook on a plain `@csrf_exempt` Django view outside DRF's parser stack entirely.
- **Return 2xx before doing any work, then process in Celery.** Validate the signature, persist the raw event, enqueue, return `200`. Everything downstream - ledger postings, emails, fulfilment - happens on a worker. A handler that posts to the ledger inline will eventually exceed the provider's timeout, earn a retry, and turn one event into a duplicate you now have to dedup anyway.
- **Dedupe on the provider's event id with a unique constraint, not a lookup.** `evt_1P...` is stable across retries. `INSERT ... ON CONFLICT DO NOTHING` and branch on the row count; a `SELECT` followed by an `INSERT` lets two concurrent redeliveries both pass the check. This is the same [atomic-claim pattern](../task-processing/idempotency-background-tasks.md) used for tasks, applied at the ingress.
- **Order is not guaranteed, so make state transitions monotonic.** `charge.refunded` can land before `payment_intent.succeeded`. Model the payment as a state machine that only moves forward, and drop any event whose `created` timestamp is older than the state you already hold. "Apply whatever arrived last" is the bug that turns a refunded order back into a paid one.
- **Never trust an amount from the payload for anything that moves money.** The signature proves the event came from the provider; it does not prove the event is **current**. A retry delivered an hour later carries the object as it looked when the event was created, before a partial refund or a dispute. For the numbers you actually post to the ledger, re-fetch the object by id over the authenticated API and use that.
- **The webhook can beat your own database transaction.** Stripe fires `payment_intent.succeeded` while your request handler is still inside `transaction.atomic()`, so the worker looks up the payment and finds nothing. Treat "row not found" as **retryable**, not fatal - retry with backoff and let the event land a few seconds later. Returning a 500 works too, but it burns the provider's retry budget for a race that resolves in milliseconds.

> [!TIP] Persist the raw signed payload, headers, and receipt time in a `webhook_event` table before you enqueue anything. When a handler has a bug two weeks later, you replay the stored events through the fixed code instead of asking the provider to redeliver events that have long since aged out.

## Example
```python
@csrf_exempt                      # the provider has no CSRF token; the HMAC is the auth
@require_POST
def stripe_webhook(request):
    payload = request.body        # MUST come first - reading request.data consumes the stream
    sig = request.META.get("HTTP_STRIPE_SIGNATURE", "")

    try:
        # Verifies the HMAC over the raw bytes AND enforces the timestamp
        # tolerance (5 min default), which is what stops a captured replay.
        event = stripe.Webhook.construct_event(payload, sig, settings.STRIPE_WEBHOOK_SECRET)
    except stripe.SignatureVerificationError:
        return HttpResponse(status=400)          # do not leak why; do not retry-loop them

    # Atomic claim on the event id. A redelivery hits the unique index and
    # created is False, so the task is never enqueued twice.
    _, created = WebhookEvent.objects.get_or_create(
        event_id=event["id"],
        defaults={
            "type": event["type"],
            "payload": payload.decode(),         # keep the raw bytes for later replay
            "created_at_provider": event["created"],
        },
    )
    if created:
        handle_stripe_event.delay(event["id"])   # all real work happens off the request path

    return HttpResponse(status=200)              # fast ack, well inside the timeout budget
```

The worker re-fetches rather than trusting the delivered amount, and refuses to move backwards:

```python
@shared_task(bind=True, max_retries=10, retry_backoff=True, retry_backoff_max=600)
def handle_stripe_event(self, event_id: str):
    event = WebhookEvent.objects.get(event_id=event_id)
    if event.processed_at:
        return "already processed"

    obj_id = json.loads(event.payload)["data"]["object"]["id"]
    # Authoritative read. The payload is a snapshot from when the event was
    # created and may predate a refund or dispute that has since landed.
    intent = stripe.PaymentIntent.retrieve(obj_id, expand=["latest_charge"])

    try:
        payment = Payment.objects.select_for_update().get(provider_ref=intent.id)
    except Payment.DoesNotExist:
        # Classic race: the webhook overtook our own committing transaction.
        # Retryable, not fatal - it will exist in a moment.
        raise self.retry(countdown=5)

    if event.created_at_provider < payment.state_changed_at.timestamp():
        return "stale event, dropped"            # out-of-order delivery, older than our state

    apply_transition(payment, intent.status, amount_minor=intent.amount_received)
    event.processed_at = timezone.now()
    event.save(update_fields=["processed_at"])
```

## Interview Q&A
- **Why verify the signature over the raw body rather than the parsed JSON?** Because the HMAC is computed over exact bytes, and any re-serialization can reorder keys or change whitespace, producing a mismatch on a perfectly genuine event. In DRF specifically, read `request.body` before `request.data`, or Django raises `RawPostDataException` when the stream has already been consumed.
- **Signature checks out. Can you trust the amount in the payload?** For display, yes. For posting to the ledger, no - the signature proves origin, not freshness. A retry delivered later carries a stale snapshot of the object. Re-fetch by id over the API for anything that moves money or grants an entitlement.
- **How do you handle duplicates and out-of-order events?** Duplicates by an atomic claim on the provider's event id with a unique constraint. Ordering by making the payment state machine monotonic and dropping events whose provider `created` timestamp is older than the state already stored, rather than assuming arrival order reflects event order.
- **Your handler needs to post to the ledger and send an email. What do you return?** `200` immediately, having done nothing but verify, persist, and enqueue. Both side effects run on a Celery worker. Doing them inline risks exceeding the provider's timeout, which becomes a retry, which becomes a duplicate.
- **What if you miss a webhook entirely?** The daily reconciliation sweep catches it by comparing your ledger against the provider's settlement report and opening a break. That backstop is why webhook loss is a latency problem rather than a correctness problem - which is the property you want when the provider has an incident.
- **How do you rotate a webhook secret without downtime?** Register the new secret while the old one is still active and verify against both during the overlap; the signature header carries multiple `v1=` values precisely so old and new validate at once. Then retire the old one. The secret belongs in a [secrets manager](../security/secrets-management.md), not in settings committed to the repo.

## Gotchas
> [!WARN] **A webhook endpoint with no signature verification is an unauthenticated "give me money" API.** Anyone who learns the URL can POST `{"type": "payment_intent.succeeded"}` and get an order fulfilled for free. URL secrecy is not authentication. Verify the HMAC, reject on failure with a `400`, and never add a code path that skips verification "for local testing" - use the provider's CLI forwarding instead.

> [!WARN] **Setting the timestamp tolerance to zero, or ignoring it, reopens replay.** A captured valid request stays valid forever without a freshness check, so an attacker who once observed a successful `payment_intent.succeeded` can resend it. Keep the default 5-minute window; zero fails constantly on ordinary clock skew, and a very large window is effectively no protection. Keep your servers on NTP.

- **Doing work in the handler and returning 200 afterwards.** Slow handlers become timeouts become retries become duplicates. Ack first.
- **Trusting arrival order.** Refund-before-capture is normal, not exotic. Any handler written as a sequence of assumed steps will corrupt state the first time the provider redelivers out of sequence.
- **One endpoint multiplexing several providers.** Different signing schemes and secrets on one URL invites verifying with the wrong key. One path per provider, one secret per path.
- **Logging the full payload without redaction.** Payment events carry cardholder detail and personal data; the raw store needs the same access control and retention limits as any other cardholder-adjacent data, per [PCI-DSS](pci-dss-basics.md).
- **No visibility into failures.** Alert on unprocessed `webhook_event` rows older than a few minutes. The provider dashboard shows *their* delivery attempts; only your table shows what you actually finished processing.

## Revise next
- **[Webhooks](../api-design/webhooks.md)**: the general mechanism, Standard Webhooks, and the signing-scheme comparison across providers.
- **[Reconciliation](reconciliation.md)**: the sweep that makes missed webhooks survivable.
- **[Retries and dead-letter queues](../task-processing/retries-dead-letter-queues.md)**: backoff for the worker side, and what to do with an event that will never process.
- **[Secrets management](../security/secrets-management.md)**: storing and rotating the webhook signing secret.

*Reviewed against Stripe's webhook and event documentation, Django 6.0 / 5.2 LTS, and Celery 5.6, July 2026.*
