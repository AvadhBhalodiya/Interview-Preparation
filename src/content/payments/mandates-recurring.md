---
title: "Mandates & Recurring Payments"
group: "Compliance"
order: 6
---

# Mandates and Recurring Payments

> A recurring payment is only as strong as the mandate behind it - the stored authorization recording who may debit, up to how much, and how often - so the engineering splits cleanly into authenticating hard once at setup, then charging off-session against that mandate, where the failure handling will occupy far more of your time than the happy path ever does.

## What it is
A **mandate** is the customer's standing permission to be debited without being present. Every recurring rail is some version of it, and which one you are on decides your authentication model, your failure modes, and how long you stay exposed to a reversal:

| | **Card on file** | **Direct debit mandate** (e-NACH, SEPA DD) | **UPI AutoPay** |
| --- | --- | --- | --- |
| Setup | 3-D Secure at first payment or via a `SetupIntent` | Mandate registered with the bank through NPCI or the scheme | Approved in the payer's UPI app with the UPI PIN |
| Per-debit auth | None - it is a **merchant-initiated transaction** | None | **AFA above the threshold** |
| Money speed | Fast authorization, settles in days | **Slow**, and a return can arrive days later | Fast |
| Typical failure | Decline code, card expiry, closed account | Insufficient funds, **mandate revoked at the bank** | Mandate paused or revoked in the app |
| Reversal window | Chargeback, months | Return window per scheme | Dispute |

> [!KEY] Authenticate **once, strongly, at mandate setup**; charge **many times, silently, afterwards**. Every regulation in this space is built around that shape, and every painful integration is one that tried to authenticate at debit time instead - because there is nobody in front of the screen to authenticate.

Under **PSD2** in the EEA (and the UK's own onshored equivalent), strong customer authentication is required for customer-initiated remote payments, carried in practice by **3-D Secure 2**. Subsequent merchant-initiated transactions fall outside SCA because the payer is not initiating them, which is exactly why the mandate setup has to carry the authentication. Regional practice varies sharply - the US has no SCA equivalent, India runs its own additional-factor regime - so treat authentication rules as per-market configuration rather than a global constant.

The exemptions worth knowing when you are being asked why a payment was challenged:

| Exemption | Condition |
| --- | --- |
| **Low value** | Under **EUR 30**, capped at a **EUR 100** cumulative total or **5** consecutive transactions since the last SCA |
| **Recurring fixed amount** | The **first** payment carries SCA; identical later ones are exempt |
| **Merchant-initiated** | Out of scope entirely - the payer is not initiating |
| **Trusted beneficiary** | Customer allowlisted the merchant with their bank |
| **Transaction risk analysis** | The acquirer's fraud rate is under the scheme threshold for the amount band |

## Key points
- **The mandate is the asset you store, not the card.** Persist the provider's mandate or payment-method id together with its **terms**: maximum amount per debit, frequency, start and end dates, and the timestamp and evidence of the customer's consent. When a customer disputes a debit two years later, that record is your defence, and it is also what keeps card data out of your systems entirely ([PCI scope reduction](pci-dss-basics.md)).
- **Off-session means you must have a way to get back on-session.** With Stripe you create the mandate with a `SetupIntent` carrying `usage="off_session"`, which authenticates the card up front, then charge later with `off_session=True, confirm=True`. When the issuer still demands authentication, the intent fails with `authentication_required` and there is no off-session fix - you email the customer a link and reconfirm with `off_session=False`. Build that recovery flow at the same time as the happy path, not after the first failed renewal batch.
- **India's rules are numeric and enforceable, so they belong in code rather than in a policy document.** The RBI's consolidated e-mandate framework (issued April 2026, folding in the earlier circulars) allows recurring debits without additional-factor authentication up to **INR 15,000** per transaction, raised to **INR 1,00,000** for insurance premiums, **mutual fund subscriptions**, and credit card bill payments, across cards, PPIs, and UPI alike. A **pre-debit notification at least 24 hours before** each debit is mandatory and must carry the merchant name, amount, debit date, mandate reference, and reason. These thresholds have been revised repeatedly - check the current circular before implementing, and keep them in configuration.
- **Retry strategy must read the decline code, not the failure flag.** A **soft** decline (`insufficient_funds`, `processing_error`, `issuer_not_available`) is worth retrying on a schedule, because the same card may work on payday. A **hard** decline (`lost_card`, `stolen_card`, `pickup_card`, `invalid_account`) will never succeed and retrying it invites scheme penalties for excessive retries. Stripe's Smart Retries defaults to roughly **8 attempts across 2 weeks** at model-chosen times; a hand-rolled schedule should be similar in shape - spread across days, aligned to likely salary dates, never a tight loop.
- **Involuntary churn is a payments problem, not a marketing one.** Most subscription cancellations you see are not customers leaving; they are expired cards, changed accounts, and revoked mandates. The countermeasures are dunning with escalating customer contact, network tokens or an account updater so a reissued card keeps working, and a `past_due` grace state that keeps access on while you retry rather than cutting off at the first failure.
- **Proration and cancellation are ledger events before they are API calls.** An upgrade mid-cycle credits the unused portion of the old plan and charges the new one pro rata; a cancellation either ends at period end (no refund, access continues) or immediately (refund the unused remainder). Whichever you choose, it lands as postings in the [ledger](double-entry-ledger.md) - and the refund leg is a real money movement that has to be idempotent and reconciled like any other.

> [!TIP] Build the idempotency key for a renewal from the **subscription and the billing period**: `f"sub-{sub.id}-{period_start:%Y%m}"`. Retries inside the period collapse into one charge, while the next period is naturally a different key. A key built from the subscription alone silently blocks next month's legitimate renewal.

## Example
```python
# 1. Setup, on-session, once. usage="off_session" triggers the SCA challenge NOW
#    so later merchant-initiated debits are not challenged with nobody watching.
setup = stripe.SetupIntent.create(
    customer=customer.provider_ref,
    payment_method_types=["card"],
    usage="off_session",
)

# 2. Renewal, off-session, every period.
SOFT_DECLINES = {"insufficient_funds", "processing_error", "issuer_not_available",
                 "try_again_later", "generic_decline"}

@shared_task(bind=True)
def charge_renewal(self, subscription_id: int, period_start: date):
    sub = Subscription.objects.get(pk=subscription_id)
    try:
        stripe.PaymentIntent.create(
            amount=sub.amount_minor,
            currency=sub.currency,
            customer=sub.customer.provider_ref,
            payment_method=sub.mandate_ref,
            off_session=True,
            confirm=True,
            # Period is IN the key: retries dedupe, next month does not.
            idempotency_key=f"sub-{sub.id}-{period_start:%Y%m}",
        )
    except stripe.CardError as exc:
        code = exc.error.code
        decline = getattr(exc.error, "decline_code", None)

        if code == "authentication_required":
            # No off-session fix exists. The customer must reconfirm in a browser.
            sub.mark_past_due(reason="sca_required")
            send_recovery_link.delay(sub.id)        # reconfirm with off_session=False
        elif decline in SOFT_DECLINES:
            sub.mark_past_due(reason=decline)
            schedule_dunning(sub)                   # spread over days, not a tight loop
        else:
            # Hard decline: the card is gone. Retrying earns scheme penalties.
            sub.mark_requires_new_mandate(reason=decline)
            request_new_payment_method.delay(sub.id)
```

The pre-debit notice is a regulatory deadline, so it runs on its own schedule rather than inline with the charge:

```python
@shared_task
def send_pre_debit_notices():
    """India e-mandate rule: notify at least 24h before each recurring debit.

    Runs daily and looks one full day ahead, so a debit is never scheduled
    inside its own notice window. Sending the notice at charge time is a
    compliance failure even when the charge itself succeeds.
    """
    due = Subscription.objects.filter(
        status="active",
        next_debit_on=timezone.localdate() + timedelta(days=1),
        pre_debit_notice_sent_for__lt=F("next_debit_on"),   # idempotent per period
    )
    for sub in due.iterator():
        notify(
            sub.customer,
            template="pre_debit",
            merchant=settings.MERCHANT_LEGAL_NAME,   # every field below is mandated
            amount=sub.amount_minor,
            debit_on=sub.next_debit_on,
            mandate_ref=sub.mandate_ref,
            reason=sub.plan.name,
        )
        Subscription.objects.filter(pk=sub.pk).update(
            pre_debit_notice_sent_for=sub.next_debit_on,
        )
```

## Interview Q&A
- **How do recurring card payments work without asking the customer every month?** The customer authenticates once when the mandate is set up, and the stored credential is then charged as a merchant-initiated transaction. Under PSD2 those later charges are outside SCA precisely because the payer is not initiating them - which is why skimping on authentication at setup produces challenges you cannot answer later.
- **An off-session charge fails with `authentication_required`. Now what?** You cannot resolve it off-session. Move the subscription to `past_due`, email the customer a link, and reconfirm the payment on-session where a 3-D Secure challenge can actually be shown. Preventing it is better: create the mandate with `usage="off_session"` so the card is authenticated for future use from the start.
- **How would you design retries for failed renewals?** Branch on the decline code. Soft declines like insufficient funds get a spread schedule over one to two weeks, roughly eight attempts, ideally near likely salary dates. Hard declines like a lost or stolen card get zero retries and an immediate request for a new payment method, because retrying a hard decline cannot succeed and the schemes penalise it.
- **What is different about recurring payments in India?** An additional-factor regime rather than SCA. Recurring debits run without AFA up to INR 15,000, or INR 1,00,000 for insurance, mutual fund subscriptions, and credit card bills, across cards, PPIs, and UPI. A pre-debit notification at least 24 hours ahead is mandatory with specified fields, which makes it a scheduled job in your architecture, not a line in the charge handler.
- **Card on file versus a direct-debit mandate - how do you choose?** Cards authorize instantly and fail loudly, which suits short cycles and immediate access, but they expire and get reissued. Direct debit rails such as e-NACH cost less and do not expire, but settlement is slower and a return can arrive days after you already granted the service. High-value or long-cycle billing tends toward direct debit; consumer subscriptions toward cards.
- **How do you handle a mid-cycle plan change?** Credit the unused portion of the old plan and charge the new one pro rata, then decide whether to bill the difference immediately or roll it into the next invoice. Both legs are ledger postings, and the refund side is real money movement, so it needs an idempotency key and shows up in reconciliation like any other charge.

## Gotchas
> [!WARN] **An idempotency key built from the subscription alone blocks every future renewal.** `f"sub-{sub.id}"` dedupes correctly within one cycle and then silently refuses to charge next month, because the provider replays the stored response from the first period. Every recurring key needs the **period** in it. This one is quiet for exactly one billing cycle, which is long enough to reach production.

> [!WARN] **A mandate can be revoked without telling you.** A customer cancelling an e-NACH or UPI AutoPay mandate does it at their bank or in their payments app, and your system finds out when a debit fails - or from a webhook you have to be subscribed to. Continuing to attempt debits against a revoked mandate is a regulatory and reputational problem, so treat mandate-revoked failures as terminal, stop the schedule immediately, and reflect it in the customer's account rather than retrying.

- **Sending the pre-debit notice at charge time.** Twenty-four hours before means twenty-four hours before. It is a separate scheduled job, and the debit must not be scheduled inside its own notice window.
- **Treating `past_due` as cancelled.** Cutting access on the first failure converts a temporary card problem into a lost customer. Grace periods exist because most soft declines recover within days.
- **Ignoring card expiry until it bites.** Expiry dates are known in advance. Prompt before the renewal that will fail, and use network tokens or an account updater so reissued cards keep working without customer action.
- **Storing the CVV to "make renewals smoother".** Never permitted after authorization, and unnecessary - the mandate exists for exactly this. See [PCI-DSS basics](pci-dss-basics.md).
- **Assuming one regional rulebook.** SCA thresholds, exemptions, AFA limits, and notice requirements differ by market and change over time. Keep them in configuration with the effective date recorded, so a threshold change is a config edit rather than a release.

## Revise next
- **[Idempotency keys](idempotency-keys.md)**: constructing a per-period key so retries dedupe and renewals do not.
- **[PCI-DSS basics](pci-dss-basics.md)**: why a mandate token, not card data, is what you are allowed to keep.
- **[Payment webhooks](webhooks-reliability.md)**: how mandate revocations, failed renewals, and disputes actually reach you.
- **[Retries and dead-letter queues](../task-processing/retries-dead-letter-queues.md)**: backoff shapes, and why a hard decline must never enter a retry loop.

*Reviewed against Stripe's SetupIntent and off-session payment documentation, the PSD2 RTS on SCA, and the RBI e-mandate framework (April 2026), July 2026.*
