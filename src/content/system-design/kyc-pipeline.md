---
title: "Design a KYC Pipeline"
group: "Classic Designs"
order: 14
---

# Design a KYC Verification Pipeline

> KYC is a long-running, multi-step workflow over flaky third-party vendors and irreducibly manual decisions, so the design is an explicit state machine in Postgres with compare-and-set transitions, one idempotent task per step rather than one long chain, a poller behind every vendor webhook, and PII that is encrypted, access-logged and deleted on a schedule.

## What it is
An application moves through a fixed sequence of checks, each of which can fail, time out, or need a human. Nothing about it is synchronous - a vendor may answer in 200 ms or in six hours - so the HTTP request that starts it only creates a row and returns.

```text
upload (presigned S3 PUT)
  -> scan + quality check      -> reject: unreadable, resubmit
  -> OCR / extraction          -> low confidence: manual review
  -> identity vendor (PAN, Aadhaar/DigiLocker, bank penny-drop)
  -> sanctions / PEP screening -> hit: manual review
  -> risk scoring              -> auto-approve | auto-reject | manual review
  -> decision recorded         -> periodic re-KYC scheduled
```

The core object is a **state machine**, not a checklist. Each status has a defined set of legal successors, and every transition is a compare-and-set - `UPDATE ... WHERE status = <expected>` - so a duplicate task, a replayed webhook and a late vendor callback all update zero rows instead of dragging a rejected application back to `pending`.

| Status | Set by | Legal next |
| --- | --- | --- |
| `submitted` | The API request | `extracting`, `rejected` |
| `extracting` | OCR task | `verifying`, `manual_review` |
| `verifying` | Vendor task or its webhook | `screening`, `manual_review`, `vendor_failed` |
| `screening` | Sanctions/PEP task | `approved`, `manual_review` |
| `manual_review` | Any step, or risk score | `approved`, `rejected` (**by a human, with a reason code**) |
| `approved` / `rejected` | Reviewer or auto-decision | Terminal until **re-KYC** reopens a new application |

> [!KEY] Do not model this as a Celery `chain`. A chain fails as a unit, so a vendor timeout at step four either loses everything or replays the OCR and the vendor calls you already paid for. Persist each step's result in its own row, keyed `(application_id, step)`, and let a dispatcher pick the next task from the **current state**. Resuming then costs one task, and the state machine is the only thing that decides what happens next.

## Key points
- **Documents go straight to S3, never through your app.** Issue a presigned `POST` scoped to one key with a `content-length-range` condition and a short expiry (900 seconds), so a 10 MB passport scan never occupies a Gunicorn worker. Enforce **SSE-KMS** with a bucket policy that denies unencrypted `PutObject`, block public access, keep versioning on, and give reviewers 5-minute presigned `GET`s rather than a public URL. Object Lock in governance mode makes the evidence tamper-evident for the auditors who will eventually ask.
- **Every vendor call gets a timeout, a stored reference, and a circuit breaker.** Set connect and read timeouts explicitly (3 s and 10 s are reasonable) - the default in `requests` is *no timeout*, which turns a hung vendor into exhausted workers. Write your `vendor_request` row with your own reference id **before** the call, so a timeout leaves something to reconcile: you then **query** the vendor by that reference instead of resubmitting and paying twice.
- **A webhook is an optimisation; the poller is the guarantee.** Vendors miss callbacks, retry them out of order, and send them twice. Verify the HMAC over the raw body, dedupe on the vendor's event id, apply the result through the same compare-and-set transition, and run a sweeper over anything stuck in `verifying` for more than N minutes. Systems that trust webhooks alone develop a silent tail of applications that never finish.
- **The manual review queue is a claimed work queue, not an inbox.** Reviewers pull with `SELECT ... FOR UPDATE SKIP LOCKED LIMIT 1`, hold a claim with a TTL so an abandoned review returns to the pool, and sort by risk and age so the SLA clock is visible. High-risk approvals need **four-eyes**: a second reviewer, and a constraint that the approver is not the submitter.
- **Auditability means append-only, not "we log a lot".** One `kyc_event` row per transition - actor (user or system), from-state, to-state, reason code, request id, timestamp - and never a mutating `UPDATE` on it. A regulator's question is always "who decided this, when, and on what evidence", and the answer has to be one query rather than an archaeology project across application logs.
- **Encrypt PII at the field level and make lookups blind.** Envelope-encrypt document numbers with a KMS data key rather than relying on disk encryption, which protects you against a stolen disk and nothing else. To find duplicate applicants without storing plaintext, index an **HMAC of the number with a pepper** held in Secrets Manager: equality lookups still work, a database dump does not yield PANs, and rotating the pepper is a planned re-index rather than a breach.

> [!TIP] Give retention the same status as verification. Under PMLA and the RBI KYC directions, records are kept **five years after the relationship ends** - which is a floor *and* a ceiling: keeping raw selfies forever is a liability, not caution. Set an S3 lifecycle rule per document class, keep the decision and the audit trail longer than the raw documents, and test the deletion path.

## Example
The transition helper every step calls. The `WHERE` clause is the concurrency control - there is no separate lock:

```python
def transition(app_id: str, expected: str, new: str, actor: str, reason: str = "") -> bool:
    with transaction.atomic():
        changed = KycApplication.objects.filter(id=app_id, status=expected).update(
            status=new, updated_at=timezone.now()
        )
        if not changed:
            # Not an error: a duplicate task, a replayed webhook, or a callback that lost
            # a race. Zero rows updated is exactly the outcome we want from a replay.
            logger.info("kyc_transition_skipped", extra={"app": app_id, "want": expected})
            return False
        KycEvent.objects.create(                       # append-only audit trail
            application_id=app_id, from_status=expected, to_status=new,
            actor=actor, reason=reason, request_id=get_request_id(),
        )
    return True
```

A vendor step: idempotent on the result row, resumable after any failure, and never re-submitting blind after a timeout.

```python
@app.task(bind=True, autoretry_for=(Timeout, ConnectionError),
          retry_backoff=True, retry_backoff_max=600, max_retries=5)
def verify_identity(self, app_id: str) -> str:
    step, created = KycStepResult.objects.get_or_create(   # unique on (application_id, step)
        application_id=app_id, step="identity",
        defaults={"reference": f"kyc-{app_id}-identity"},
    )
    if step.status == "done":
        return "already verified"                          # replay-safe short circuit

    if step.status == "in_flight":
        # We called before and never learned the outcome. Ask, do not resubmit:
        # a second submission is a second charge and possibly a second vendor case.
        result = vendor.get_by_reference(step.reference, timeout=(3, 10))
    else:
        KycStepResult.objects.filter(pk=step.pk).update(status="in_flight")
        result = vendor.submit(app_id, reference=step.reference, timeout=(3, 10))

    if result.pending:                                     # vendor will call our webhook
        return "awaiting vendor"
    KycStepResult.objects.filter(pk=step.pk).update(status="done", payload=result.redacted())
    transition(app_id, expected="verifying",
               new="screening" if result.passed else "manual_review", actor="system")
    return result.outcome
```

## Interview Q&A
- **Why a state machine rather than a chain of tasks?** Because failures are the normal case here, and a chain has no memory: it retries or abandons the whole sequence. An explicit state plus per-step result rows means a resume costs exactly one task, the current status is queryable at any moment, and every transition is guarded so replays are harmless.
- **A vendor call times out. Do you retry it?** Not with a fresh submission - you do not know whether they received it, and a duplicate submission can mean a duplicate charge and a duplicate case on their side. You store your own reference id before the call, then poll the vendor by that reference to learn the outcome. Only genuinely safe calls get automatic retries.
- **How do you handle a vendor webhook that arrives twice, out of order, or not at all?** Dedupe on the vendor's event id, apply the result through a compare-and-set transition so a stale callback updates nothing, and run a reconciliation sweeper over applications stuck in flight. The webhook makes the common case fast; the poller makes the system correct.
- **How do you store an Aadhaar or PAN number and still search by it?** Encrypt the value with a KMS-derived data key and store an HMAC of the normalised number, peppered with a secret outside the database, as the lookup index. Exact-match search and duplicate detection keep working, and a leaked database dump yields neither the numbers nor an offline brute-force target.
- **Where does the human fit, and how do you keep them honest?** A claimed queue ordered by risk and age, with per-item SLA timers, mandatory reason codes on every decision, and four-eyes on high-risk approvals. Every action lands in the append-only event log, because "a reviewer approved it" is only an answer if you can say which reviewer and on what evidence.
- **How do you keep the pipeline auditable end to end?** Immutable event rows per transition, the exact vendor request and response stored with PII redacted, the document version in S3 that was actually reviewed, and a request id threaded from the API through every task. The test is whether you can reconstruct a decision from eighteen months ago without reading application logs.

## Gotchas
> [!WARN] **PII leaks through the boring paths.** Vendor request/response payloads stored verbatim, a DRF serializer that returns the full document number, a Sentry breadcrumb carrying the request body, an exception message with the PAN in it. Redact at the boundary where the object is created, not at the point of display - by the time it is in an error tracker or a log aggregator, it is out of your control and inside someone else's retention policy.

> [!WARN] **A step with no timeout hangs forever.** `requests` has no default timeout, and one unresponsive vendor will occupy every worker in the pool until the queue backs up and unrelated work stops. Set connect and read timeouts on every outbound call, and put a circuit breaker in front of the adapter so a vendor outage fails fast instead of consuming your capacity.

- **Presigned URLs are bearer tokens.** Anyone holding the link can use it until it expires, so keep expiries in minutes, scope them to a single key, and never write them into logs or email.
- **OCR confidence is not a boolean.** Route low-confidence extractions to manual review rather than accepting them; a silently mis-read date of birth is worse than a slow review.
- **Re-KYC is part of the design, not a follow-up ticket.** Periodic refresh (risk-based, typically 2-10 year cycles) means an application is a versioned record, so never overwrite the last approved snapshot.
- **Deleting for GDPR or DPDP has to reach the backups and the derived copies too** - the S3 versions, the analytics warehouse, the search index. A `DELETE` against one table is not compliance.

## Revise next
- [Design a job scheduler](job-scheduler.md): the dispatcher, retry policy and sweeper this runs on
- [Webhooks](../api-design/webhooks.md) - signature verification, dedupe and ordering
- [RBAC vs ABAC](../security/rbac-vs-abac.md) for reviewer permissions, and [secrets management](../security/secrets-management.md) for the pepper and vendor keys
- [Design a payment system](payment-system.md): the same idempotency and reconciliation patterns over money

*Reviewed against the AWS S3 presigned-URL and KMS docs, the RBI Master Direction on KYC, and the DPDP Act 2023, July 2026.*
