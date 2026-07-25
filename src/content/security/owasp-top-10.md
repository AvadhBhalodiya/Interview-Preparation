---
title: "OWASP Top 10"
group: "Web Vulnerabilities"
order: 1
---

# OWASP Top 10

> The OWASP Top 10 is the industry's baseline awareness list of the most critical web-app security risks. The 2025 edition (final, released Jan 2026) keeps Broken Access Control at #1 and adds two new categories, Software Supply Chain Failures and Mishandling of Exceptional Conditions.

## What it is
An awareness document from the **Open Worldwide Application Security Project** that ranks the web-app risk categories most likely to bite. It is the shared vocabulary the industry uses to talk about web risk, **not a formal standard and not a checklist you "pass"**. Rebuilt every three to four years, the 2025 edition draws eight categories from tested data (roughly 2.8 million applications) and promotes two more by community survey, so genuinely new risks are not missed while the data catches up.

> [!KEY] It's a **ranked awareness list, not a checklist you pass**: each entry is a broad **risk category** covering dozens of CWEs, ordered by how often real-world testing finds it.

The full 2025 list, finalized January 2026:

| Rank | 2025 category | Change from 2021 |
| --- | --- | --- |
| A01 | Broken Access Control | **Still #1**, and now absorbs SSRF (which had its own slot in 2021) |
| A02 | Security Misconfiguration | **Up from #5** - cloud and framework defaults bite harder |
| A03 | Software Supply Chain Failures | **New**, expanding 2021's Vulnerable and Outdated Components to the whole pipeline |
| A04 | Cryptographic Failures | **Down from #2** |
| A05 | Injection | **Down from #3** - SQLi and XSS live here |
| A06 | Insecure Design | **Down from #4** |
| A07 | Authentication Failures | **Renamed** from Identification and Authentication Failures |
| A08 | Software and Data Integrity Failures | **Unchanged** at #8 |
| A09 | Security Logging and Alerting Failures | Monitoring renamed **Alerting** |
| A10 | Mishandling of Exceptional Conditions | **New** - bad error handling, failing open, leaked stack traces |

## Key points
- **Broken Access Control is #1 and it isn't close** - testers find it in more apps than any other flaw, and 2025 folds SSRF in here, since at heart it is the server fetching a resource it shouldn't.
- **A03 and A10 are the 2025 debutants.** A03 has the highest incidence rate in the data yet almost no CVE signatures, so a clean dependency scan gives false comfort. A10 is bad error handling: failing open, swallowed errors, and stack traces leaked to users.
- **The big climber is A02** (#5 to #2) as cloud and framework defaults grow riskier every year. Cryptographic Failures, Injection, and Insecure Design all slid down largely because threat modeling improved industry-wide, not because they got safe.
- **Eight categories come from data, two (A09, A10) from a community survey.** The authors call it "data-informed, not blindly data-driven", so new risks land before scanners have signatures.
- **A09 got a pointed rename**, Monitoring to Alerting. Logs nobody reads are not a control. The failure that hurts is the event you never noticed.
- **It is a floor, not full coverage.** Pair it with OWASP **ASVS** (the actual requirements standard), threat modeling, and hands-on testing.

The injection-family attacks every interview probes, and the fix that actually stops each:

| Attack | Canonical defense |
| --- | --- |
| **SQL injection** | **Parameterized queries** / prepared statements - bind values, never concatenate them into SQL |
| **XSS** (cross-site scripting) | **Context-aware output encoding** (modern frameworks auto-escape), hardened by a **`Content-Security-Policy`** that blocks inline script |
| **CSRF** (cross-site request forgery) | **`SameSite=Lax` or `Strict` cookies** plus anti-CSRF tokens on state-changing requests |

> [!TIP] In an interview, anchor to **A01**: name it #1, mention SSRF folding in, and give the deny-by-default fix. It is the most likely follow-up, so lead with it.

## Example
```python
# A01 Broken Access Control - the classic IDOR, still the most common serious flaw

# avoid: trusts the id in the URL, never checks who is asking
@app.get("/api/invoices/{invoice_id}")
def get_invoice(invoice_id):
    return db.invoices.find(invoice_id)      # any logged-in user reads any invoice

# good: deny by default, enforce ownership on the server, on every request
@app.get("/api/invoices/{invoice_id}")
def get_invoice(invoice_id, user=Depends(current_user)):
    inv = db.invoices.find(invoice_id)
    if inv is None or inv.owner_id != user.id:
        raise HTTPException(404)             # note: 404, not 403 - don't confirm it exists
    return inv
```

## Interview Q&A
- **What is the OWASP Top 10?** A community-built awareness list of the top web-app risk categories, rebuilt every few years from real-world data. A starting point, not a complete standard.
- **What's #1 in 2025, and why care?** Broken Access Control. It's the most widespread serious flaw, and SSRF now folds into it.
- **What's new versus 2021?** A03 Software Supply Chain Failures and A10 Mishandling of Exceptional Conditions.
- **Where did "Vulnerable and Outdated Components" go?** It grew into A03. Same core idea, bigger blast radius: not just an outdated library version but the build, registry, and distribution around it.
- **How would you fix the #1 risk?** Deny by default, enforce authorization on the server for every request, check ownership per object rather than per type, and grant least privilege. Client-side checks are UX, never security.
- **Is passing the Top 10 enough?** No, it's a floor. Real coverage needs ASVS plus threat modeling plus testing.

## Gotchas
> [!WARN] Quoting the **2021 order in 2026 dates you instantly**. The nastiest trap: A06 is now **Insecure Design**, while 2021's Vulnerable and Outdated Components grew into A03 Software Supply Chain Failures.

> [!WARN] A03 shows a **high incidence in the data but almost no CVE signatures**. A green dependency scan is false comfort, because supply-chain attacks land faster than scanners get signatures.

- Categories are **broad risk groups, not single findings**. Fixing one injection bug does not clear A05.
- On a failed access check, return **404, not 403**. A 403 quietly confirms the resource exists, which is itself an access-control leak.
- Don't confuse it with the **OWASP API Security Top 10** or the **Top 10 for LLM Applications**. Different surfaces, separate lists.

## Revise next
- **[Injection internals (A05)](sql-injection-xss-csrf.md)**: how parameterized queries defeat SQLi at the driver level, context-aware encoding plus CSP for XSS, and the raw-SQL escape hatches ORMs still expose.
- **[Access control (A01)](rbac-vs-abac.md)**: RBAC vs ABAC, spotting IDOR, and returning 404 over 403 to avoid resource enumeration.
- **[Crypto in transit (A04)](https-tls-basics.md)**: TLS 1.3 (RFC 8446) with its 1-RTT handshake, 0-RTT resumption and replay caveat, forward secrecy by default (static RSA removed) and AEAD-only ciphers. Add HSTS to force HTTPS on every visit.
- **Supply-chain hygiene (A03)**: SBOMs, pinned and signed dependencies, and provenance attestation (SLSA).
- **[OWASP API Top 10](owasp-api-top-10.md)**: the separate 2023 list for APIs, where A01 splits into BOLA, BOPLA, and BFLA - authorization per object, per property, and per endpoint.

*Reviewed against OWASP Top 10:2025 and RFC 8446 (TLS 1.3), July 2026.*
