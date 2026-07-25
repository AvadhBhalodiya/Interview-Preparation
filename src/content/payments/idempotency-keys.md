---
title: "Idempotency Keys"
group: "Money Movement"
order: 1
---

# Idempotency Keys in Payments

> A charge is the canonical non-idempotent operation, because the side effect is money leaving a real account and no repeat of the call can take it back, so a retry-safe integration pushes dedup to the provider with a stable `Idempotency-Key` and backs it with an atomic claim row in your own database.

## What it is
`POST /v1/payment_intents` creates a new charge every time it runs. Nothing in HTTP saves you: RFC 9110 lists POST as **not idempotent**, so a client, a proxy, or a Celery retry that resends it moves money twice. The provider therefore offers an **out-of-band dedup token**. You send `Idempotency-Key: <your key>`, the provider stores the outcome of the first request under that key, and any later request carrying the same key **replays the stored response** instead of charging again.

> [!KEY] The failure you are defending against is not "the charge failed". It is **"you do not know whether the charge happened"** - the request left your process and the response never came back. A timeout is a **third state**, not a synonym for failure, and every design decision below follows from that.

Each layer buys you exactly one guarantee, which is why real systems run all four:

| Layer | Guards against | Cannot help with |
| --- | --- | --- |
| **HTTP method semantics** | Nothing - POST is non-idempotent per RFC 9110 | Any money movement |
| **Provider `Idempotency-Key`** | A **second charge** on the same key | Drift in **your** database |
| **Your DB claim row** | A second **local** attempt, double-booking an order | Anything already sent to the provider |
| **Reconciliation sweep** | Charges the provider has that **you never recorded** | Real time - it runs on a schedule |

## Key points
- **You cannot make a charge naturally idempotent, so the guarantee moves to the boundary.** `UPDATE orders SET status='paid'` is safe on repeat because it sets an absolute state. `stripe.PaymentIntent.create(...)` is not, and no amount of local cleverness fixes that - only the party holding the money can dedup it.
- **Derive the key from stable domain data, never `uuid4()` at call time.** `f"order-capture-{order_id}"` is identical on attempt 1 and attempt 5. A UUID minted inside the task body is fresh on every retry, so the header is present, the code looks correct, and the dedup silently does nothing. This is the single most common way the mechanism gets defeated.
- **Know the provider's exact contract, because the edge cases are where money is lost.** Stripe's, precisely:

| Situation | Stripe's response |
| --- | --- |
| Same key, same params, original finished | **Replays the stored response** - no second charge |
| Same key, same params, original **still in flight** | **409** - "another in-progress request using this Idempotent Key" |
| Same key, **different** params | **Errors** (`idempotency_error`) - it compares incoming parameters to the original |
| Same key **after pruning** (keys live at least **24 hours**) | Treated as a **brand-new request** - it charges again |
| `GET` / `DELETE` | Header **ignored** - those are idempotent by definition |

- **Your retry window must fit inside the provider's retention window.** Stripe prunes keys once they are at least 24 hours old and a reused key past that point creates a fresh charge. A Celery task with exponential backoff is fine; a message sitting in a [dead-letter queue](../task-processing/retries-dead-letter-queues.md) that someone replays on Monday morning is a double charge waiting to happen. Re-drive stale payment messages through a fresh idempotency check, never a blind replay.
- **The provider key protects the money; your claim row protects your state.** Stripe replaying a 200 tells you nothing if your own transaction rolled back after the call. Write a row keyed by the same idempotency key, with a `UNIQUE` constraint doing the enforcement, before you make the call.

> [!TIP] Put your internal identifier in the provider's `metadata` (`{"order_id": 8412}`) on every create. When [reconciliation](reconciliation.md) later finds a charge you have no record of, that field is what turns a manual investigation into an automatic match.

## Example
```python
@shared_task(bind=True, acks_late=True, max_retries=5, default_retry_delay=30)
def capture_payment(self, order_id: int) -> str:
    # Derived from the order, so retry #1 and retry #5 send the SAME key.
    # A uuid4() here would be new on every attempt - dedup would never fire.
    key = f"order-capture-{order_id}"

    # get_or_create catches the IntegrityError from the UNIQUE constraint, so
    # two concurrent workers cannot both claim - no check-then-act race.
    attempt, created = PaymentAttempt.objects.get_or_create(
        idempotency_key=key,
        defaults={"order_id": order_id, "status": "in_flight"},
    )
    if not created and attempt.status == "succeeded":
        return "already captured"          # cheap short-circuit, not the safety net

    try:
        intent = stripe.PaymentIntent.create(
            amount=attempt.amount_minor,   # minor units (4999 paise), never a float
            currency="inr",
            customer=attempt.customer_ref,
            confirm=True,
            idempotency_key=key,           # the actual guarantee
            metadata={"order_id": order_id},   # lets reconciliation match this later
        )
    except stripe.APIConnectionError as exc:
        # The response is lost. The charge may or may not exist upstream.
        # Recording "failed" here is a lie that costs a real customer real money.
        PaymentAttempt.objects.filter(pk=attempt.pk).update(status="unknown")
        raise self.retry(exc=exc)          # same key -> replay, not a second charge

    PaymentAttempt.objects.filter(pk=attempt.pk).update(
        status="succeeded", provider_ref=intent.id,
    )
    return intent.id
```

The constraint, not the Python, is what makes the claim atomic:

```sql
CREATE TABLE payment_attempt (
    id              bigserial PRIMARY KEY,
    order_id        bigint      NOT NULL REFERENCES "order" (id),
    idempotency_key text        NOT NULL,
    amount_minor    bigint      NOT NULL CHECK (amount_minor > 0),
    status          text        NOT NULL DEFAULT 'in_flight',
    provider_ref    text,
    created_at      timestamptz NOT NULL DEFAULT now(),
    -- The whole local guarantee in one line: a second INSERT with this key
    -- raises instead of quietly creating a second attempt.
    CONSTRAINT payment_attempt_key_uniq UNIQUE (idempotency_key)
);

-- A partial unique index says "at most one live attempt per order" while still
-- allowing a genuinely failed attempt to be retried with a new key.
CREATE UNIQUE INDEX payment_attempt_one_live
    ON payment_attempt (order_id)
    WHERE status IN ('in_flight', 'unknown', 'succeeded');
```

## Interview Q&A
- **Why is a charge the hard case for retries?** Because it is not idempotent and cannot be made so locally - the state that changed lives at the bank, not in your database. Every other write you can express as "set this absolute value"; a charge you can only express as "do this again".
- **Where does the idempotency key come from?** Stable domain data the caller already has, such as the order id, so every retry of the same logical operation produces the same string. Generating it inside the retried code is the classic bug: the header is there, the protection is not.
- **What happens if the same key arrives with a different amount?** Stripe compares the incoming parameters against the stored ones and returns an error rather than charging or replaying. That is a feature - it catches you reusing a key for a different operation instead of silently picking one of the two amounts.
- **Your charge request times out. What do you do?** Nothing that assumes failure. Record the attempt as `unknown`, retry with the same key so the provider replays rather than re-charges, and let the reconciliation job resolve it if retries run out. Marking it failed and letting the customer re-pay is how you produce a double charge and a chargeback.
- **The provider dedups already - why keep your own table?** Because the provider's guarantee ends at their API boundary. If your transaction rolls back after a successful call, the money moved and your database says it did not. The local claim row plus `metadata` is what lets you detect and repair that.
- **How long does an idempotency key protect you?** Only for the provider's retention window - Stripe keeps keys at least 24 hours, then prunes them, after which the same key starts a brand-new charge. Any retry path that can outlive that window needs a fresh eligibility check, not a replay.

## Gotchas
> [!WARN] **A key generated inside the retried function is not an idempotency key.** `idempotency_key=str(uuid4())` inside a Celery task passes review, passes tests that never retry, and double-charges in production the first time the broker redelivers. Derive it from the payload and assert that in a test that retries the task twice.

> [!WARN] **Never write "failed" on a timeout.** The three possible states after a lost response are: never arrived, arrived and succeeded, arrived and failed. Two of the three mean the customer's money moved. Model an explicit `unknown` state, keep it out of your revenue numbers, and let reconciliation collapse it.

- **One key, one operation.** Reusing `order-8412` for both the authorization and the later capture makes the second call collide with the first one's stored response. Namespace the intent into the key: `order-8412-capture`, `order-8412-refund`.
- **Keys do not span environments or accounts.** Treat the namespace as per-account and per-mode; a key that replayed in test tells you nothing about live.
- **Amounts belong in minor units as integers.** `amount=1999` (paise or cents), never `19.99` as a float. Floating-point rounding in a parameter that the idempotency layer also compares gives you mismatch errors on retry as well as wrong money.
- **The key covers one API call, not your workflow.** Charge, then write the ledger entry, then send the receipt - only the first is protected. The rest need their own [replay-safe design](../task-processing/idempotency-background-tasks.md).

## Revise next
- **[Reconciliation](reconciliation.md)**: the backstop that finds the charges your `unknown` rows are hiding.
- **[Double-entry ledger](double-entry-ledger.md)**: where a confirmed charge gets recorded so the state is auditable rather than a single mutable column.
- **[Idempotency in background tasks](../task-processing/idempotency-background-tasks.md)**: the same problem one layer down, at the broker.
- **[Idempotency (HTTP)](../api-design/idempotency-http-methods.md)**: which methods carry the guarantee for free, and the IETF `Idempotency-Key` draft this pattern comes from.

*Reviewed against Stripe's idempotent-requests documentation and HTTP RFC 9110, July 2026.*
