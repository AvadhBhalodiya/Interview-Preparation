---
title: "Design a Payment System"
group: "Classic Designs"
order: 10
---

# Design a Payment System

> A payment system is a state machine over money that the network will regularly refuse to tell you the truth about, so the design is an idempotency key on every write, an append-only double-entry ledger as the source of truth, an outbox for events, and a daily reconciliation against the provider that catches whatever the first three missed.

## What it is
Card money moves in three distinct steps, and collapsing them into "charge the card" is the fastest way to lose the interview. **Authorization** asks the issuer to reserve funds and returns an approval that holds for days. **Capture** tells the network you actually want that money. **Settlement** is the acquirer moving real funds into your bank account, in batches, on a schedule you do not control.

| Step | What happens | Who decides | Timing |
| --- | --- | --- | --- |
| **Authorize** | Issuer reserves the amount; **no money moves** | Issuer (risk, balance) | Milliseconds; the hold expires in about **7 days** |
| **Capture** | You claim the held amount, **full or partial** | **You** | Now, or any time before the hold expires |
| **Settle / payout** | Funds land in your bank | Network + acquirer | Batched, **T+1 to T+3** |
| **Refund / dispute** | Money flows back | You / the cardholder | Chargebacks arrive up to **120+ days** later |

> [!KEY] Your **ledger** is the source of truth about what your business believes; the **PSP** is a remote system that holds a different opinion. The whole architecture exists to keep those two opinions converging - idempotency stops you writing twice, the outbox stops you losing an event, and reconciliation proves the two agree at the end of the day.

The services worth drawing on the whiteboard: an **API/orchestrator** that owns the payment state machine, a **ledger** that only ever appends, **PSP adapters** (Stripe today, an NBFC or BSE rail tomorrow), a **webhook receiver**, and a **reconciliation job**. Keep the ledger free of provider vocabulary so a second provider is a new adapter, not a schema migration.

## Key points
- **Use a double-entry ledger, not a balance column.** Every movement writes two or more lines that sum to zero (debit customer receivable, credit PSP clearing). A balance is a `SUM` over lines, never a mutable field, so no update can silently lose money and every number has an audit trail explaining it. Corrections are **reversing entries**, never `UPDATE` or `DELETE`. Money is `BIGINT` minor units plus a currency code - `NUMERIC` if you genuinely need fractional units for FX, never a float.
- **One idempotency key travels the entire path.** The client sends `Idempotency-Key`, you store it under a unique constraint alongside the serialized response, and you forward a stable key to Stripe. Stripe replays the original response for a repeated key and **discards keys after 24 hours**, so your own record needs to live longer (30 days is a sane retention) because your retry may arrive after theirs expired.
- **Write the attempt row before you call the provider.** A `payment_attempt` row in status `pending` committed *before* the HTTP call is what turns "we have no idea what happened" into "we have a record to reconcile". Without it, a crash mid-call leaves a charge at Stripe that nothing in your database references.
- **Publish events through a transactional outbox.** Insert the state change and the outbox row in the **same Postgres transaction**, then let a relay poll `FOR UPDATE SKIP LOCKED` and push to SQS or SNS. Calling the broker inside the transaction gives you events for work that rolled back; calling it after commit loses events when the process dies in between.
- **Treat PSP webhooks as at-least-once, out-of-order hints.** Verify the HMAC over the **raw body** (Stripe signs `timestamp.payload` with SHA-256 and defaults to a 5-minute tolerance), dedupe on the provider's event id, answer 2xx in milliseconds, and do the work in Celery. Stripe retries a failing endpoint with exponential backoff for up to **3 days** in live mode.
- **Reduce PCI scope by never touching the PAN.** Card data goes straight from the browser to Stripe via Elements or Checkout; you store a token, brand, last4 and expiry. That moves you from SAQ D toward SAQ A - but PCI DSS v4.0.1 requirements **6.4.3 and 11.6.1** (script inventory and payment-page change detection) became mandatory on **31 March 2025**, so "we use Elements" is no longer zero work.

> [!TIP] Model the payment as an explicit state machine (`requires_action -> authorized -> captured -> settled`, plus `failed`, `canceled`, `refunded`, `disputed`) and enforce transitions with `UPDATE ... WHERE status = <expected>`. A webhook that arrives late then updates zero rows instead of dragging a settled payment back to authorized.

## Example
The ledger and the outbox, both append-only, both written in the same transaction as the state change:

```sql
-- Balanced by construction: one journal row, N lines that must sum to zero.
CREATE TABLE journal (
  id           BIGSERIAL PRIMARY KEY,
  reference    TEXT UNIQUE NOT NULL,        -- the idempotency key; a replay collides here
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE journal_line (
  journal_id   BIGINT NOT NULL REFERENCES journal(id),
  account      TEXT   NOT NULL,             -- 'customer:42', 'psp_clearing:stripe', 'fees'
  amount_minor BIGINT NOT NULL,             -- signed minor units: +debit, -credit. Never float.
  currency     CHAR(3) NOT NULL
);
-- A DEFERRABLE trigger checks SUM(amount_minor) = 0 per journal_id at COMMIT,
-- so a half-written entry can never be visible to a reader.

CREATE TABLE outbox (
  id           BIGSERIAL PRIMARY KEY,
  topic        TEXT NOT NULL,
  payload      JSONB NOT NULL,
  published_at TIMESTAMPTZ                  -- NULL until the relay has pushed it
);
CREATE INDEX outbox_unpublished ON outbox (id) WHERE published_at IS NULL;  -- partial: stays tiny
```

The capture path. Note what is inside the transaction and what is deliberately outside it:

```python
@transaction.atomic
def capture_payment(attempt_id: str, key: str) -> Payment:
    # 1. Claim the key. A concurrent duplicate loses the race on the unique index
    #    and we return the stored response instead of charging twice.
    claim, created = IdempotencyKey.objects.get_or_create(key=key, defaults={"scope": "capture"})
    if not created:
        return claim.replay()          # same answer, no second call to Stripe

    attempt = Payment.objects.select_for_update().get(id=attempt_id, status="authorized")

    # 2. The external call is NOT idempotent on its own - the key is what makes it so.
    #    On a timeout we do not know the outcome, so we never blind-retry without this.
    intent = stripe.PaymentIntent.capture(attempt.psp_intent_id, idempotency_key=key)

    # 3. Ledger + state + event all commit together, or none of them do.
    post_journal(reference=key, lines=[
        (f"customer:{attempt.user_id}", -attempt.amount_minor),
        ("psp_clearing:stripe",         +attempt.amount_minor),
    ])
    Payment.objects.filter(id=attempt.id, status="authorized").update(status="captured")
    Outbox.objects.create(topic="payment.captured", payload={"id": attempt.id, "key": key})
    return attempt
```

## Interview Q&A
- **Why a double-entry ledger instead of a `balance` column on the user?** Because a balance column has no history: when it is wrong you cannot tell which write broke it. Double-entry makes every balance a derivable `SUM` of immutable lines, so any discrepancy points at a specific entry, and the debits-equal-credits invariant is checkable at any moment.
- **You POST a charge to Stripe and the connection times out. Did the money move?** Unknown, and that is the point - the request may have succeeded with the response lost. You never blind-retry. You retry with the **same idempotency key**, which either performs the charge once or replays the original result. As a backstop, the `pending` attempt row you wrote before the call gets swept by reconciliation.
- **Where do idempotency keys live and how long do you keep them?** At three layers: the client's `Idempotency-Key` header, a unique constraint in your own table holding the stored response, and the key you forward to the PSP. Stripe drops keys after 24 hours; keep yours around 30 days, because a client retrying tomorrow must still get the original answer rather than a second charge.
- **Why the outbox pattern rather than publishing after the commit?** Because "commit, then publish" is a dual write with a crash window in the middle - the payment is captured and no downstream service ever hears about it. The outbox row commits atomically with the state change, so the event is durable the moment the payment is, and a relay delivers it at-least-once.
- **What does reconciliation actually compare?** Your ledger against the provider's settlement report, ideally three-way with the bank statement. Every line falls into one of four buckets: in your ledger but not theirs, in theirs but not yours, present in both with an amount mismatch, or a pure timing difference that clears tomorrow. Only the fourth is allowed to be silent.
- **How do you keep PCI scope small?** The PAN never reaches your servers - the browser posts it to Stripe and hands you a token. You store the token, last4 and expiry, redact card fields in logs, and still satisfy the v4.0.1 script-integrity requirements on the payment page.

## Gotchas
> [!WARN] **Floats for money are a bug, not a style choice.** `0.1 + 0.2 != 0.3` in IEEE 754, and Django's `FloatField` maps to `double precision`. Store `BIGINT` minor units or `NUMERIC(19, 4)`. The failure is silent: totals drift by fractions of a cent until a reconciliation report stops balancing months later.

> [!WARN] **The webhook can beat your own transaction.** Stripe fires `payment_intent.succeeded` while your request handler is still inside `transaction.atomic`, so the webhook worker looks up the payment and finds nothing. Do not treat a missing row as a fatal error - retry the webhook with backoff, and make the receiver tolerant of arriving first.

- **Partial captures and refunds break naive amount checks.** A single authorization can produce several captures and a refund per capture, so `refunded_total <= captured_total` must be enforced per payment in SQL, not assumed from a single-row comparison.
- **A failed capture is not a rollback.** The authorization still holds the customer's funds until it expires, which the customer sees on their statement. Explicitly cancel the intent on an abandoned flow instead of letting the hold linger for a week.
- **Retry storms hit the provider's rate limit exactly when you are already degraded.** Exponential backoff with jitter and a circuit breaker in the PSP adapter, otherwise every stuck job retries in lockstep and turns a blip into an outage.
- **Currency is part of the identity of an amount.** `1000` means very different things in INR and USD minor units; carry the ISO code on every ledger line and refuse to sum across currencies.

## Revise next
- [Idempotency in background tasks](../task-processing/idempotency-background-tasks.md) and [idempotent HTTP methods](../api-design/idempotency-http-methods.md)
- [Webhooks](../api-design/webhooks.md): signature verification, replay, and ordering
- [Transaction isolation levels](../databases/transaction-isolation-levels.md) - what `SELECT ... FOR UPDATE` actually buys you here
- [Design a job scheduler](job-scheduler.md) for the outbox relay and the reconciliation run

*Reviewed against the Stripe API docs (idempotent requests, webhook signatures) and PCI DSS v4.0.1, July 2026.*
