---
title: "Reconciliation"
group: "Money Movement"
order: 3
---

# Reconciliation

> Reconciliation is the scheduled proof that three independent records of the same money agree - your ledger, the PSP's settlement report, and the bank statement - and it exists because most payment failures produce no exception anywhere in your logs, only a quiet disagreement between systems that nobody notices until a customer or an auditor asks.

## What it is
Three parties each keep their own book, and none of them is complete on its own:

| Record | Authoritative for | Where it goes wrong |
| --- | --- | --- |
| **Your ledger** | What you believe you owe the customer | **Missing entries** - a lost webhook, a worker that died mid-task, a charge whose response timed out |
| **PSP settlement report** | What was actually captured, refunded, and charged in fees | **Timing cutoffs**, partial captures, disputes appearing days later |
| **Bank statement** | Cash that genuinely landed in the account | **Batched payouts**, FX, bank holidays, a settlement split across two days |

Matching only your ledger against the PSP catches missing entries but not money that never arrived. Matching only the PSP against the bank catches payout problems but tells you nothing about a customer whose order says "unpaid" while their card was charged. **Three-way reconciliation** does both legs, which is why it is the standard.

```text
  your ledger  <--- leg 1 --->  PSP settlement report  <--- leg 2 --->  bank statement
   "we captured                  "we captured 1,431 charges,             "INR 68,42,150
    1,432 charges"                fees 2.1L, net payout 68.4L"            credited, ref PYT9X"

  leg 1 break: 1 charge we recorded that the PSP never saw (or vice versa)
  leg 2 break: net payout does not equal the credit that landed
```

> [!KEY] Reconciliation is not a report you read, it is a **control you operate**. Its output is not a number, it is a **queue of breaks** - each with an owner, an age, and a resolution - and the health metric is how fast that queue drains, not how big the match rate looks.

## Key points
- **Match on settlement batches, not individual transactions.** A PSP does not wire you money per charge; it nets a day's activity into one payout. The identity you are proving is `sum(captures) - sum(refunds) - sum(fees) - sum(disputes) = payout amount`. Reconcile the batch first, then drill into the line items only for batches that fail, which keeps the daily job cheap.
- **Reconcile against an immutable report, never a live API read.** A charge fetched from the API today reflects today's state, including a refund that happened after the period you are closing. Settlement reports and balance-transaction exports are snapshots of a fixed window, which is what makes yesterday's reconciliation reproducible when you re-run it next month.
- **Most breaks come from a short, boring list.** Recognising them by shape is what turns a four-hour investigation into a lookup:

| Break cause | What you see | Usual resolution |
| --- | --- | --- |
| **Timeout / unknown state** | PSP has a charge, your ledger has nothing | Post the missing entry from the PSP record |
| **Partial capture** | Authorized 5,000, captured 3,000 | Ledger recorded the authorization as revenue |
| **Refund across a cutoff** | Capture in day N, refund in day N+1 | Not a break - **period timing**, clears next run |
| **Fees** | Ledger total exceeds payout by a small percentage | Fees were **netted into revenue** instead of their own line |
| **FX** | Amounts match, currency totals do not | Rate applied at a different timestamp than the PSP used |
| **Chargeback / dispute** | Payout is short by an exact charge amount plus a flat fee | Post the dispute and its fee as separate entries |
| **Timezone cutoff** | Counts off by a handful at midnight | Report is **UTC**, your books close **IST** |

- **Automate the match in tiers, and let the last tier be a human.** Tier one is an exact join on the provider reference you stored at charge time. Tier two is a fuzzy match on amount plus date plus last four digits, for records where the reference was never captured. Anything left is a **break**, and it goes to a queue that a finance or ops user works through. A system with no manual queue is not fully automated, it is silently writing off differences.
- **Run it daily, on a schedule, and make it re-runnable for any date.** Celery Beat firing a task that takes a date parameter, is idempotent per `(date, provider)`, and can be replayed for last Tuesday without producing duplicate breaks. Reconciliation that only ever runs on "today" cannot be backfilled after an outage, which is exactly when you need it.
- **The job never edits the ledger directly.** It opens a break and, once resolved, posts an **adjusting entry** through the normal posting path so the correction is itself double-entry and auditable. A reconciliation script with `UPDATE ledger_line` in it has destroyed the property that made the ledger worth having.

> [!TIP] Track **unmatched value and break age**, not just match rate. A 99.8 percent match rate sounds excellent and can still hide one 4-lakh break that has been open for three weeks. Alert on the oldest open break, and bucket breaks by age the way you would age receivables.

## Example
The daily job, scheduled and parameterised so any past date can be replayed:

```python
app.conf.beat_schedule = {
    "reconcile-stripe-daily": {
        "task": "payments.tasks.reconcile_day",
        # 03:30 IST, comfortably after the provider's report for the prior UTC
        # day is final. Reconciling too early just manufactures timing breaks.
        "schedule": crontab(hour=3, minute=30),
        "kwargs": {"provider": "stripe"},
    },
}

@shared_task(bind=True, max_retries=3)
def reconcile_day(self, provider: str, day: str | None = None) -> dict:
    # Default to yesterday, but accept an explicit date so an operator can
    # backfill after an outage. Same input -> same output, always.
    day = day or (timezone.localdate() - timedelta(days=1)).isoformat()

    run, _ = ReconRun.objects.get_or_create(       # unique on (provider, day)
        provider=provider, day=day, defaults={"status": "running"},
    )
    report = fetch_settlement_report(provider, day)   # immutable snapshot, not a live read
    load_settlement_lines(run, report)                # staged into settlement_line

    breaks = find_breaks(run)                         # the SQL below
    Break.objects.bulk_create(
        [b for b in breaks if not Break.objects.filter(fingerprint=b.fingerprint).exists()]
    )
    run.status = "clean" if not breaks else "breaks"
    run.save(update_fields=["status"])
    return {"day": day, "breaks": len(breaks)}
```

The match itself is a `FULL OUTER JOIN`, because you need the rows each side is missing, not just the ones that differ:

```sql
-- Leg 1: our ledger against the PSP's settlement lines for one day.
SELECT
    COALESCE(l.provider_ref, s.charge_id)                   AS ref,
    l.amount_minor                                          AS ours,
    s.amount_minor                                          AS theirs,
    CASE
        WHEN l.provider_ref IS NULL THEN 'missing_in_ledger'   -- they charged, we did not record
        WHEN s.charge_id    IS NULL THEN 'missing_at_psp'      -- we recorded, they never saw it
        ELSE 'amount_mismatch'
    END                                                     AS break_type
FROM ledger_capture_v l
FULL OUTER JOIN settlement_line s ON s.charge_id = l.provider_ref
WHERE l.provider_ref IS NULL
   OR s.charge_id    IS NULL
   OR l.amount_minor <> s.amount_minor;

-- Leg 2: does the netted batch equal the cash the bank actually credited?
SELECT s.payout_id,
       SUM(s.amount_minor) FILTER (WHERE s.kind = 'capture')
     - SUM(s.amount_minor) FILTER (WHERE s.kind IN ('refund', 'fee', 'dispute')) AS expected_minor,
       b.credited_minor,
       SUM(s.amount_minor) FILTER (WHERE s.kind = 'capture')
     - SUM(s.amount_minor) FILTER (WHERE s.kind IN ('refund', 'fee', 'dispute'))
     - b.credited_minor                                                          AS delta_minor
FROM settlement_line s
JOIN bank_credit b ON b.payout_ref = s.payout_id
GROUP BY s.payout_id, b.credited_minor
HAVING SUM(s.amount_minor) FILTER (WHERE s.kind = 'capture')
     - SUM(s.amount_minor) FILTER (WHERE s.kind IN ('refund', 'fee', 'dispute'))
     <> b.credited_minor;
```

## Interview Q&A
- **What is three-way reconciliation and why not just two?** Ledger against PSP against bank. The ledger-to-PSP leg finds transactions you mis-recorded; the PSP-to-bank leg finds money that was promised but never landed. Drop either leg and you have a class of failure with no detector - most commonly a charge the customer paid that your system never recorded.
- **Where do breaks usually come from?** Timeouts leaving unknown-state charges, partial captures, refunds and disputes landing in a different period than the original charge, fees netted into revenue instead of posted separately, FX rate timing, and midnight cutoff differences between the provider's UTC reporting day and your local accounting day.
- **Why does this need to be a scheduled job rather than event-driven?** Because its whole job is catching the events that never arrived. A webhook-driven system cannot notice a webhook it never received; only an independent sweep against the provider's own record of truth can. That is why it runs on a timer and reads a report rather than listening for events.
- **A break appears. What does the system do?** Nothing automatic to the ledger. It creates a break record with a stable fingerprint so re-runs do not duplicate it, assigns it to a queue, and waits for a resolution. When resolved, the fix is an adjusting double-entry posting through the normal path, so the correction is auditable and the ledger stays append-only.
- **How do you keep the job idempotent when it runs twice?** Key the run on `(provider, date)` with a unique constraint, stage settlement lines keyed by the provider's line id, and fingerprint breaks on their content. Re-running a day then converges to the same state instead of piling up duplicate breaks - which matters because you will re-run days, often under pressure.
- **What would make you distrust a 99.9 percent match rate?** Auto-tolerances. If the matcher writes off any difference under some threshold, the rate measures the tolerance, not the books. Tolerances should be tiny, currency-aware, individually logged, and reported as their own number.

## Gotchas
> [!WARN] **Timezone cutoffs manufacture breaks that look like real ones.** Providers commonly report in **UTC** while Indian books close in **IST**, a 5:30 offset - so every charge between 00:00 and 05:30 IST belongs to the provider's previous day. Pin the reconciliation window to the provider's own day boundary and convert once, explicitly, rather than filtering with `created_at::date` in local time and spending a morning chasing a phantom.

> [!WARN] **Never let the reconciler auto-correct the ledger.** A script that "fixes" a mismatch by writing the PSP's number over yours will happily paper over a genuine bug - including a bug that is losing money - and it destroys the audit trail that reconciliation exists to produce. Detect, record, escalate, and post an adjusting entry through the same code path as every other posting.

- **Reconciling against live API state instead of a settlement snapshot.** Re-run last month's reconciliation and the numbers will have moved, because refunds and disputes mutate the objects. Store the report you reconciled against.
- **Assuming the payout equals the day's captures.** It is captures minus refunds minus fees minus disputes, plus or minus reserve adjustments, over the provider's own settlement window. In India there is also the aggregator's escrow leg between capture and your bank credit, so "money captured" and "money available" are separated by a mandated settlement cycle.
- **Ignoring rows that match on amount but not on reference.** Two customers paying the same amount on the same day is common. Amount-plus-date matching without a reference or last-four tiebreak will confidently pair the wrong two records and hide two real breaks.
- **Treating a `unknown` payment attempt as failed at month end.** Those rows are the exact population reconciliation exists to resolve. Close the period with them explicitly listed, not swept into failures.

## Revise next
- **[Double-entry ledger](double-entry-ledger.md)**: the internal record this compares against, and why adjusting entries beat corrections.
- **[Idempotency keys](idempotency-keys.md)**: where `unknown`-state charges come from in the first place.
- **[Payment webhooks](webhooks-reliability.md)**: the real-time path that reconciliation exists to backstop.
- **[Celery Beat](../task-processing/celery-beat-periodic-tasks.md)**: scheduling the daily run, and why a missed tick must be replayable rather than skipped.

*Reviewed against Stripe's payout reconciliation and balance-transaction reporting docs, PostgreSQL 18, and Celery 5.6, July 2026.*
