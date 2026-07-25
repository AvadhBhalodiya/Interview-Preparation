---
title: "PII & KYC Data"
group: "Access & Data Protection"
order: 7
---

# Handling PII and KYC Data

> PII is a liability you hold on someone else's behalf, so the controls that actually move the needle are the ones that shrink how much you have and how far it spreads - classify it, collect less, encrypt it under a key you can destroy, and keep it out of the systems nobody thinks of as databases.

## What it is
**PII** is any data that identifies a person directly or in combination with something else. **KYC data** is the sensitive subset a regulated business is obliged to collect and, awkwardly, obliged to keep: identity numbers, document scans, selfies, bank details, date of birth.

Classification comes first because every later control is applied per class, not per field-by-vibes:

| Class | Fintech examples | Handling |
| --- | --- | --- |
| **Public** | product names, published rates | none |
| **Internal** | aggregate volumes, non-identifying telemetry | access control |
| **PII** | name, email, phone, address, IP, device id | encrypted in transit and at rest, access controlled |
| **Sensitive / KYC** | government ID numbers, ID scans, selfies, bank and card numbers, DOB | field-level encryption or tokenization, audited access, explicit retention |

What counts as "sensitive" is **jurisdictional, not universal** - GDPR treats biometrics and ID documents as special-category data while ordinary financial records are not, and India's DPDP Act frames personal data more broadly. Do not classify from memory: get the list from whoever owns compliance, then encode it in the schema so it is enforceable rather than aspirational.

> [!KEY] Every control below is a mitigation for data you **chose to keep**. Deleting a field removes an entire row from your threat model - no key management, no access review, no breach-notification exposure, no erasure request to service. Minimisation is the only control with zero ongoing cost, which is why it comes before encryption, not after.

## Key points
- **"Encrypted at rest" is three different controls with three different threat models,** and the one most teams ship stops the least likely threat.

| Layer | Protects against | Does nothing against |
| --- | --- | --- |
| **Full-disk / RDS storage encryption** | a stolen disk, a decommissioned volume, a snapshot copied elsewhere | any query through the app or `psql` - the engine decrypts transparently |
| **Column / field-level encryption** | a DB dump, a read replica, a DBA, a SQL-injection read | your app, which holds the key at runtime |
| **Tokenization** | your systems entirely - the real value is not there | the vault or provider holding the mapping |

RDS encryption is one checkbox and it is worth having. But if the threat you actually fear is "someone exfiltrates the database", it does nothing, because the attacker arrives holding a connection string.

- **Envelope encryption is how you do field-level with KMS without paying per row.** Call `GenerateDataKey` once to get a plaintext data key plus a KMS-encrypted copy, encrypt the field locally with AES-GCM, store the ciphertext next to the encrypted data key, and drop the plaintext key from memory. This exists because KMS's direct `Encrypt` caps at **4 KB** and would cost a network round trip and a request charge per field. The real payoff is the audit trail: every `Decrypt` is a CloudTrail event, so "who read this customer's ID number" becomes a query you can answer.
- **A per-subject data key buys you crypto-shredding.** Encrypt each customer's sensitive fields under their own data key, and destroying that one key renders every copy of their ciphertext unrecoverable at once - including copies in backups and snapshots you cannot rewrite. This is the only technically clean answer to erasure in a system with immutable backups.
- **Field-level encryption breaks the queries you forgot about.** An encrypted column is opaque: no `WHERE email = ...`, no index, no `LIKE`, no sort. Deterministic encryption restores equality lookups but **leaks equality** - identical plaintexts produce identical ciphertexts, so an attacker can count and correlate without decrypting anything. The usual compromise is a **blind index**: store `HMAC(key, normalize(value))` in a separate indexed column for exact-match lookup and keep the real value under randomized-IV encryption.
- **The leak is almost never the database.** It is the systems nobody classifies as data stores: application logs, the error tracker, **Celery task arguments sitting in Redis**, analytics events, CSV exports in a bucket, the support admin, the BI warehouse, and any third-party API you forward a document to. Each is a copy that outlives your retention policy and is invisible to an erasure request.
- **Access control on PII is not the same as access control on the feature.** One support agent reading one customer record is the job; the same agent reading 4,000 is exfiltration. Enforce scope at the query (per-tenant filters, row-level security), then **record the read** - an append-only audit row with actor, subject, field class, and reason - and alert on volume and pattern rather than on individual accesses.

> [!TIP] Tokenize instead of encrypting wherever a provider will hold the value for you. You almost never need a full card number: Stripe holds it and you store `pm_...` plus the last four. Data you never possessed needs no key rotation, no access review, and no breach notification.

## Example
```python
# Django: sensitive_variables / sensitive_post_parameters mask the ERROR REPORT -
# the technical 500 page and the mail_admins traceback - via SafeExceptionReporterFilter.
# They do NOT touch anything you write with logger.*, which is where PII usually escapes.
from django.views.decorators.debug import sensitive_post_parameters, sensitive_variables

@sensitive_post_parameters("pan_number", "account_number")
@sensitive_variables("pan_number", "kyc_payload")
def submit_kyc(request):
    ...

# Sentry: send_default_pii is False by default - leave it there. It is not enough on
# its own, because the Python SDK ships local variables from every stack frame, so a
# `kyc_payload` local rides along inside the traceback of an unrelated crash.
import sentry_sdk

DENY = {"pan_number", "aadhaar", "account_number", "otp", "authorization"}

def scrub(event, hint):
    for exc in event.get("exception", {}).get("values", []):
        for frame in exc.get("stacktrace", {}).get("frames", []):
            frame["vars"] = {
                k: "[Filtered]" if k.lower() in DENY else v
                for k, v in frame.get("vars", {}).items()
            }
    return event

sentry_sdk.init(
    send_default_pii=False,   # default; turning it on attaches user data and request bodies
    before_send=scrub,        # blunter alternative: include_local_variables=False
)
```

```python
# Celery: task arguments are serialized into the broker and echoed in Flower and in
# every "task received" log line. Passing PII as an argument copies it into Redis for
# the lifetime of the queue, plus the result backend if you have one.
process_kyc.delay(pan_number="ABCDE1234F")        # avoid: now it lives in Redis
process_kyc.delay(kyc_submission_id=sub.id)       # good: pass an id, read fields inside

# KYC documents: private bucket, SSE-KMS under a key you control, short-lived URL.
s3.put_object(
    Bucket="kyc-docs-prod",          # account-level Block Public Access on, always
    Key=f"{customer_id}/{doc_id}.pdf",
    Body=body,
    ServerSideEncryption="aws:kms",  # a dedicated CMK gives per-Decrypt CloudTrail events
    SSEKMSKeyId=KYC_KEY_ARN,         # and a key revocable independently of the bucket
)

# A presigned URL is a bearer credential: it works for anyone holding it, with no
# further auth. Authorize BEFORE minting it, keep the TTL in minutes, never log it.
url = s3.generate_presigned_url(
    "get_object",
    Params={"Bucket": "kyc-docs-prod", "Key": key},
    ExpiresIn=300,                   # 5 minutes, not the 3600-second default
)
```

## Interview Q&A
- **How would you store KYC documents?** A private bucket with account-level Block Public Access, SSE-KMS under a dedicated key, non-guessable keys, and access only via short-lived presigned URLs minted after an authorization check. Versioning plus a lifecycle rule that expires objects at the end of the retention window, and CloudTrail on the key so document reads are auditable.
- **Full-disk versus field-level encryption - when does each matter?** Storage encryption defends a stolen or copied volume and decrypts transparently for anyone with a valid connection, so it does nothing against a leaked credential or SQL injection. Field-level encryption keeps the value unreadable in a dump or a replica, at the cost of losing indexing and search on that column.
- **What is envelope encryption and why not just call KMS per field?** KMS issues a data key, you encrypt locally with it and store the wrapped key beside the ciphertext. Direct KMS encryption is capped at 4 KB and costs a network call and a request charge per operation, so envelope encryption is what makes per-record field encryption affordable - and every unwrap still lands in CloudTrail.
- **How do you honour a deletion request when the data is in backups?** You cannot rewrite backups, so there are two honest answers: crypto-shredding, where per-subject keys are destroyed and the ciphertext dies with them, or a documented retention window where backups age out naturally and the deletion is re-applied if one is ever restored. The second is what most companies genuinely do - say so rather than claiming instant erasure everywhere.
- **Can a customer always demand deletion?** No, and this is the fintech-specific nuance. AML and KYC rules generally require retaining identification records for a defined period after the relationship ends, and a statutory retention obligation outranks an erasure request. The correct implementation deletes what it can, moves the rest into a restricted, access-audited archive, and records the legal basis for keeping it.
- **Where does PII leak in a system that gets encryption right?** Logs, error trackers, task queues, analytics, exports, support tooling, and third parties. Encryption at rest is the part teams do well; the copies are the part they do not inventory.

## Gotchas
> [!WARN] "The database is encrypted" almost always means **RDS storage encryption**, which decrypts transparently for anyone holding credentials. It stops a stolen disk and nothing else - not a leaked password, not SQL injection, not an over-broad IAM policy, not an engineer with production read access. If exfiltration is the threat you are defending, this is not the control.

> [!WARN] **PII in a URL leaks in more places than people expect**: browser history, the `Referer` header sent to every third-party asset, CDN and load-balancer access logs, your own nginx log, and any error tracker capturing the request URL. Keep identifiers in the path and sensitive values in the request body.

- **Soft delete is not deletion.** `is_deleted = True` leaves every byte in the table, its indexes, its replicas, and every backup. Decide per field which erasure actually means "row gone" and which means "value overwritten".
- **Production dumps in staging carry the data without the controls.** The bucket policy, the IAM scoping, and the audit logging did not come along. Mask or synthesize, and treat a prod-to-staging copy as an incident-level event.
- **Retention exists only if something enforces it.** A retention policy in a Confluence page is not a control. It is a scheduled job with a test asserting that records past the window are gone.
- **Do not write your own crypto.** Use AES-GCM or Fernet from `cryptography`, or a KMS-backed library. Homegrown schemes reliably reinvent ECB mode or a fixed IV, both of which leak plaintext structure.
- **Third parties inherit your obligations.** The KYC vendor, the analytics SDK, the model API you send a document to. Anything you forward is data you must be able to account for and, when asked, get deleted - which means knowing it was sent in the first place.

## Revise next
- **[Secrets management](secrets-management.md)**: KMS, Secrets Manager, and where the keys behind field-level encryption actually live.
- **[HTTPS / TLS](https-tls-basics.md)**: the in-transit half, and why TLS terminating at the load balancer is not end-to-end.
- **[OWASP API Top 10](owasp-api-top-10.md)**: API3, where excessive field exposure turns an internal column into a public one.
- **[Monitoring and logging](../devops/monitoring-logging.md)**: log pipelines are a data store with retention, access control, and PII exposure of their own.

*Reviewed against the OWASP Cryptographic Storage and Logging cheat sheets, AWS KMS and S3 documentation, and the Django error-reporting and Sentry Python SDK docs, July 2026.*
