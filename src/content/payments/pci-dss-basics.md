---
title: "PCI-DSS Basics"
group: "Compliance"
order: 5
---

# PCI-DSS Basics for Backend Engineers

> PCI DSS is a contractual security standard binding anyone who stores, processes, or transmits cardholder data, and for a backend engineer almost all of the work is scope reduction - arranging the architecture so a raw card number never reaches your servers - because every system that touches or can affect cardholder data inherits the full weight of the standard.

## What it is
The Payment Card Industry Data Security Standard is published by the PCI Security Standards Council and enforced **contractually** by the card brands through your acquiring bank. It is not legislation. That distinction matters in practice: non-compliance surfaces as fines passed down from the acquirer, higher transaction fees, or losing the ability to accept cards - not as a regulator knocking on the door.

The current version is **v4.0.1**, published June 2024. It replaced v4.0, v3.2.1 was retired on 31 March 2024, and the future-dated v4.x requirements became mandatory on **31 March 2025**. Twelve requirements sit under six control objectives, but the one that decides how much of it lands on you is scope.

The distinction the whole standard turns on is **cardholder data (CHD)** against **sensitive authentication data (SAD)**:

| Data element | Category | May you store it after authorization? |
| --- | --- | --- |
| **PAN** (the 16-digit card number) | CHD | **Yes**, if rendered unreadable at rest (Req 3.5.1) and masked on display (Req 3.4.1) |
| Cardholder name, expiry, service code | CHD | **Yes**, protected whenever stored with the PAN |
| **CVV / CVC2 / CID** | **SAD** | **Never** - Req 3.3.1, not even encrypted |
| **Full track data** (magnetic stripe or chip equivalent) | **SAD** | **Never** |
| **PIN / PIN block** | **SAD** | **Never** |

> [!KEY] Scope is the entire game. PCI DSS applies to every system that stores, processes, or transmits cardholder data **and every system connected to or able to affect the security of** that environment. Keep the PAN out of your infrastructure and most of the 12 requirements stop applying to your application servers - which is worth vastly more engineering effort than making a large in-scope environment compliant.

Validation effort scales with volume through merchant levels (roughly: the highest-volume merchants need an onsite assessment by a QSA and a Report on Compliance, everyone else self-assesses), and the **SAQ** you fill in depends on how card data flows:

| SAQ | Typical setup | Practical meaning |
| --- | --- | --- |
| **A** | Fully outsourced e-commerce; card data goes **browser to PSP** | The **target** - fewest questions, smallest scope |
| **A-EP** | Your page controls the payment form but does not receive card data | Substantially more, because your page can affect the flow |
| **D** | Your servers touch the PAN | Effectively the **whole standard** |

Exact thresholds and level definitions are set by each card brand and interpreted by your acquirer, so confirm yours with them rather than assuming a universal number.

## Key points
- **Tokenization plus hosted fields is how scope reduction actually happens.** With Stripe Elements or Checkout, the card number is posted from the customer's browser straight to Stripe over TLS; your backend receives a **token** (`pm_...`) and never sees the PAN. You store the token, brand, last four, and expiry - which are not enough to make a payment anywhere else, so a breach of your database is a much smaller event.
- **"We use Stripe, so we are out of scope" is wrong, and it is the single most common misconception.** You are still a merchant with SAQ obligations. Since v4.0.1, payment-page script integrity is explicitly in play: Requirement **6.4.3** (every script on the payment page authorized, inventoried, integrity-assured) and **11.6.1** (tamper detection alerting on unauthorized changes to payment-page content and HTTP headers) became effective 31 March 2025. In January 2025 the Council removed those two from SAQ A itself, replacing them with an eligibility criterion that the merchant confirms the site is not susceptible to script-based attacks - merchants who cannot confirm that fall to SAQ A-EP or D, where the requirements still apply in full. The direction of travel is clear: an iframe is no longer a free pass.
- **The CVV must never be persisted anywhere, and "temporarily" still counts.** Not in a database column, not in a Redis key with a TTL, not in a Celery task argument serialized into the broker, not in a log line. Requirement 3.3.1 prohibits storing SAD after authorization even when encrypted. Broker payloads are the one people forget: a task called with the CVV in `kwargs` writes it to Redis and to any result backend.
- **Rendering a PAN unreadable is not the same as hashing it.** A PAN has a small, structured keyspace - a known BIN range, a fixed length, and a Luhn check digit - so a plain unsalted SHA-256 of one is brute-forced in seconds. Requirement 3.5.1 wants strong cryptography with proper key management, truncation, index tokens, or **keyed** hashes. Masking on display is a separate control: no more than the BIN and last four visible (Req 3.4.1), and only to people with a documented business need.
- **Encryption in transit means strong cryptography on open public networks (Req 4), which in practice means TLS done properly.** TLS 1.2 as a floor with 1.3 preferred, valid certificates, HSTS, and no downgrade path. Internal-only traffic is not automatically exempt: a flat network where an app server can reach the cardholder data environment drags that server into scope.
- **Access control and audit trails are where engineers get caught unprepared.** Requirement 7 is need-to-know least privilege, Requirement 8 is unique per-person IDs with MFA for access into the cardholder data environment, and Requirement 10 wants audit logs of every access to cardholder data and every administrative action, retained for **at least 12 months with at least 3 months immediately available**. Shared service accounts and a `psql` prompt on production with no logging are both findings.

> [!TIP] Write the redaction into a logging filter and a Sentry `before_send` hook on day one, then add a test that asserts a fake PAN never appears in captured log output. Retrofitting redaction after a card number is already in six months of CloudWatch logs means a log purge, an incident report, and an awkward conversation with your acquirer.

## Example
```python
# What you store after tokenization: enough to show the customer which card
# they used and to charge it again, and nothing that can be used elsewhere.
class SavedCard(models.Model):
    customer     = models.ForeignKey(Customer, on_delete=models.CASCADE)
    provider_ref = models.CharField(max_length=64, unique=True)  # "pm_1P..." - not a PAN
    brand        = models.CharField(max_length=20)               # "visa"
    last4        = models.CharField(max_length=4)                # display only (Req 3.4.1)
    exp_month    = models.PositiveSmallIntegerField()
    exp_year     = models.PositiveSmallIntegerField()
    # Deliberately absent, and a code-review blocker if anyone adds them:
    #   pan, cvv, track_data - SAD must not be stored after authorization (Req 3.3.1).
```

Defence in depth on the way out, because the accidental storage is nearly always a log:

```python
PAN_RE = re.compile(r"\b(?:\d[ -]*?){13,19}\b")
SENSITIVE_KEYS = {"cvv", "cvc", "card_number", "pan", "track_data", "pin"}

class RedactCardData(logging.Filter):
    """Last line of defence. The real fix is never putting a PAN in a log call."""

    def filter(self, record: logging.LogRecord) -> bool:
        msg = record.getMessage()
        # Luhn-check before redacting so ordinary long numbers (order ids,
        # timestamps concatenated in a trace) are not mangled into noise.
        record.msg = PAN_RE.sub(lambda m: _mask(m.group()) if _luhn(m.group()) else m.group(), msg)
        record.args = ()
        return True


def before_send(event, hint):
    """Sentry scrubs some fields by default; card fields are not among them."""
    for section in ("request", "extra", "contexts"):
        _strip_keys(event.get(section), SENSITIVE_KEYS)
    return event
```

## Interview Q&A
- **What is PCI DSS and who enforces it?** A security standard from the PCI Security Standards Council covering the storage, processing, and transmission of cardholder data. It is enforced contractually by the card brands through your acquirer, not by statute, so the consequence of failing it is commercial: fines, penalty pricing, or losing card acceptance.
- **How do you reduce scope in a Django application?** Never let the PAN reach the server. The browser sends card data directly to the PSP through hosted fields, and your backend gets a token it stores alongside brand, last four, and expiry. That removes the storage, encryption, and key-management requirements from your application tier and moves you toward SAQ A.
- **What can you never store, and what can you store with protection?** Sensitive authentication data - CVV, full track data, PIN blocks - must never be stored after authorization, encrypted or not. The PAN may be stored if rendered unreadable at rest and masked on display to BIN plus last four for everyone without a business need.
- **Is hashing a card number enough to satisfy the standard?** Not a plain hash. The PAN keyspace is small and structured enough to brute-force, so a bare SHA-256 is effectively reversible. The standard expects strong cryptography with key management, truncation, index tokens, or keyed hashes - and in practice, tokenizing with the PSP so the question does not arise.
- **Using Stripe Elements, are you out of scope entirely?** No. You are a lower-scope merchant, not an exempt one. You still validate through an SAQ, and since v4.0.1 the payment page's scripts are explicitly in play through requirements 6.4.3 and 11.6.1 - which the Council removed from SAQ A in January 2025 in favour of an eligibility criterion about script-based attacks, with merchants who cannot meet it dropping to SAQ A-EP or D.
- **Where do card numbers usually leak in practice?** Not from the database. From application logs, exception trackers capturing request bodies, APM breadcrumbs, Celery task arguments serialized into Redis, and database dumps copied to a developer laptop. Redact at the boundary and test that the redaction holds.

## Gotchas
> [!WARN] **Your logs and your error tracker are storage.** A `logger.info(f"charging {request.data}")` on a payment endpoint writes a PAN and possibly a CVV into CloudWatch, and an unfiltered Sentry event ships the whole request body to a third party. That is a reportable incident, not a code smell. Filter at the logging layer, scrub in `before_send`, and never pass card fields as Celery task arguments - the broker persists them.

> [!WARN] **Encrypting the CVV does not make storing it acceptable.** Requirement 3.3.1 prohibits retaining sensitive authentication data after authorization regardless of protection. Teams reach for it when building "one-click repeat payment"; the correct answer is a provider token from a [saved payment method or mandate](mandates-recurring.md), which is designed for exactly that flow.

- **Flat networks quietly expand scope.** Any system that can reach the cardholder data environment is in scope. Segmentation is what keeps your reporting service, your analytics box, and your admin tooling out of the assessment.
- **Compliance is a state, not a certificate.** An annual SAQ or ROC is a point-in-time attestation; the requirements apply continuously. A quarter of drift between assessments is still non-compliance.
- **Shared accounts break Requirement 8 and every audit trail built on it.** If four engineers use one `deploy` login, Requirement 10's logs cannot attribute an action to a person. Individual identities plus [role-based access](../security/rbac-vs-abac.md) are prerequisites for the logging requirements, not separate work.
- **Test data can be real data.** A production dump restored into staging carries live PANs into an environment with weaker controls, and staging is now in scope. Mask on extract, and use the brands' published test card numbers.

## Revise next
- **[Mandates and recurring payments](mandates-recurring.md)**: storing a token and a mandate instead of card details, which is what scope reduction enables.
- **[Secrets management](../security/secrets-management.md)**: key management, rotation, and keeping API keys out of the repo, which Requirement 3 and Requirement 8 both depend on.
- **[HTTPS and TLS](../security/https-tls-basics.md)**: what "strong cryptography in transit" means concretely for Requirement 4.
- **[RBAC vs ABAC](../security/rbac-vs-abac.md)**: implementing the need-to-know access model Requirement 7 asks for.

*Reviewed against PCI DSS v4.0.1 (June 2024) and the PCI SSC's January 2025 SAQ A update, July 2026.*
