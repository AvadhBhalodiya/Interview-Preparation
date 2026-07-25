---
title: "OWASP API Top 10"
group: "Web Vulnerabilities"
order: 3
---

# OWASP API Security Top 10

> The API Security Top 10 is a separate OWASP list because APIs fail differently from web apps: three of its top five entries are authorization failures - per object, per property, per endpoint - and no framework default fixes any of them for you.

## What it is
A separate OWASP project with its own numbering (`API1:2023`), first published in 2019 and last revised in **2023**. It is not a subset of the main Top 10 and not on the same release cycle - the main list moved to its 2025 edition while the API list's current stable edition is still 2023.

The split exists because the attack surface is genuinely different. A server-rendered app hands the client finished HTML; an API hands the client **raw objects with raw identifiers**. The client sees every field you serialize, every endpoint in your OpenAPI schema, and every primary key in a URL. Template auto-escaping and CSRF middleware - the framework defaults that carry a Django app a long way - protect nothing here. What is left is **authorization**, which is application-specific by definition and therefore impossible to ship as a default.

| Rank | 2023 category | The one-line version |
| --- | --- | --- |
| API1 | **Broken Object Level Authorization (BOLA)** | Can I read **your** record by changing the id? |
| API2 | **Broken Authentication** | Weak login, token, or reset flow |
| API3 | **Broken Object Property Level Authorization** | Merges 2019's **Excessive Data Exposure** + **Mass Assignment** |
| API4 | **Unrestricted Resource Consumption** | No rate limit, no page cap, no upload cap - your bill and your uptime |
| API5 | **Broken Function Level Authorization (BFLA)** | Can a normal user call the **admin endpoint**? |
| API6 | **Unrestricted Access to Sensitive Business Flows** | The flow is legitimate; **automating** it is the abuse |
| API7 | **Server Side Request Forgery** | Your server fetches a URL the caller chose |
| API8 | **Security Misconfiguration** | Debug on, CORS wide open, verbose errors |
| API9 | **Improper Inventory Management** | **Shadow** and **zombie** endpoints nobody retired |
| API10 | **Unsafe Consumption of APIs** | You validate user input, then trust a vendor's response completely |

> [!KEY] A01:2025 Broken Access Control and API1/API3/API5 are the **same root cause at three resolutions**: which **object** you may touch, which **fields** of it you may read or write, and which **endpoints** you may call at all. Naming which of the three you mean is the signal an interviewer is listening for.

## Key points
- **BOLA is #1 because scanners cannot find it.** The endpoint takes an object id, looks it up, and never asks whether this caller owns that object. A scanner sees a 200 and moves on - it has no idea `/api/loans/8814/` belongs to a different customer. Finding it needs two accounts and a swapped id, which is exactly why it dominates manual VAPT reports and not automated ones. The fix is to make ownership part of the **query**, not a comparison after the fetch.
- **API3 merged two 2019 entries because they are one bug.** Excessive Data Exposure (reading too many fields) and Mass Assignment (writing too many) are both "the property list I exposed is not the property list this caller may touch". In DRF, `fields = "__all__"` commits both halves at once, and does so **retroactively** - the migration that adds `internal_risk_score` ships it in the API the same deploy.
- **BFLA is per-endpoint, not per-object.** A regular user calling `DELETE /api/users/{id}/` or anything under `/api/admin/`. It appears wherever authorization is attached to a route by convention instead of enforced by a **default-deny** base class. Enumeration is trivial: REST naming is predictable and your published schema often lists the admin routes outright.
- **API4 and API6 are about cost, not access.** API4 is unbounded consumption - a `page_size` the caller picks, an unpaginated list, a 2 GB upload, a filter on an unindexed column, an SMS endpoint that costs real money per call. API6 is subtler: the flow is one a human is *allowed* to perform, and the abuse is **automating** it - farming signup bonuses, buying out limited inventory, scraping every profile one legitimate GET at a time. Rate limiting alone does not close API6; you have to detect automation.
- **API9 is why old endpoints kill you.** **Shadow** endpoints (undocumented, never reviewed) and **zombie** endpoints (deprecated, still routed) run old code with old authorization. A `/api/v1/` left up beside `/api/v2/`, a staging host pointed at production data, a debug route from a hotfix. You cannot secure an endpoint you have forgotten exists, which is why the control is an inventory, not a scan.
- **API10 flips the trust direction.** You validate everything a user sends, then paste a KYC vendor's or a broker's JSON straight into your database. Same discipline applies outbound: validate the response shape, cap its size, do not follow redirects blindly, and set a timeout - `requests` has **no default timeout**, so a hung third party pins a worker indefinitely.

> [!TIP] For revision, collapse the list to one question asked three times: **which object**, **which field**, **which endpoint**. That plus "who pays for this call" (API4/API6) covers six of the ten.

## Example
```python
# DRF: BOLA (API1) and mass assignment (API3) in six lines

# avoid
class LoanViewSet(ModelViewSet):
    queryset = Loan.objects.all()            # any id in the URL resolves - this is BOLA
    serializer_class = LoanSerializer        # with fields = "__all__" - this is API3
    permission_classes = [IsAuthenticated]   # authenticated is not authorized

# good: ownership lives in the queryset, so it cannot be forgotten later
class LoanViewSet(ModelViewSet):
    permission_classes = [IsAuthenticated]

    def get_queryset(self):
        # This filter IS the object-level check. get_object() runs against it, so
        # a foreign id raises Http404 before any permission class is consulted.
        return Loan.objects.filter(borrower=self.request.user)

    def get_serializer_class(self):
        # Separate read and write shapes. The write serializer simply has no
        # `status` or `borrower` field, so a payload cannot assign them.
        write = self.action in ("create", "update", "partial_update")
        return LoanWriteSerializer if write else LoanReadSerializer

    def perform_create(self, serializer):
        serializer.save(borrower=self.request.user)   # server sets the owner, never the payload
```

```python
# FastAPI: the response model is the field allow-list; extra="forbid" is the write side.
class LoanOut(BaseModel):
    id: int
    amount: Decimal
    status: str                      # internal_risk_score is absent, so it cannot leak

class LoanIn(BaseModel):
    model_config = ConfigDict(extra="forbid")   # unknown keys are a 422, not silent extras
    amount: Decimal

@app.get("/loans/{loan_id}", response_model=LoanOut)
async def get_loan(loan_id: int, user=Depends(current_user), db=Depends(get_db)):
    # Ownership in the WHERE clause. Fetching first and comparing in Python is the
    # same check, but it is one forgotten `if` away from BOLA.
    loan = await db.scalar(
        select(Loan).where(Loan.id == loan_id, Loan.borrower_id == user.id)
    )
    if loan is None:
        raise HTTPException(404)     # 404, not 403 - a 403 confirms the row exists
    return loan
```

## Interview Q&A
- **Why is there a separate API Top 10?** Because APIs expose object identifiers and raw fields directly to an untrusted client, so the dominant failures are authorization ones the framework cannot default for you, rather than the injection and rendering bugs that drive the main list.
- **What is BOLA, and how is it different from BFLA?** BOLA is per-object: you are allowed to call `GET /loans/{id}/`, but not for *that* id. BFLA is per-endpoint: you were never allowed to call `/api/admin/users/` at all. Same category in the main Top 10, different fix - BOLA is a queryset filter, BFLA is a permission on the route.
- **How would you find BOLA in a code review?** Look for a queryset or a `select()` that is not scoped to the caller, then check whether anything downstream re-adds the constraint. In DRF the tell is `queryset = Model.objects.all()` with no `get_queryset` override. In testing it is two accounts and a swapped id.
- **What is mass assignment in DRF terms?** `serializer.save()` writing fields the client should not control, because the serializer declared `fields = "__all__"` or forgot `read_only_fields`. Posting `{"status": "approved"}` to your own loan is the canonical example. Fix with an explicit write serializer and by passing server-owned values into `save()`.
- **Does rate limiting solve API4 and API6?** It solves most of API4. API6 needs more, because each individual request is legitimate and within limits - the abuse is the aggregate pattern, so you need per-flow quotas, device or identity signals, and anomaly detection rather than a requests-per-minute cap.
- **Which edition is current?** The main OWASP Top 10 is on its 2025 edition; the API Security Top 10 is still on 2023. Mixing the two numbering schemes is a common slip.

## Gotchas
> [!WARN] In DRF, `has_object_permission` **never runs on list endpoints**, and only runs at all when the view goes through `get_object()`. A custom `@action` that queries the model directly silently skips every object-level permission you wrote. Scoping `get_queryset()` survives that mistake; an object permission class does not.

> [!WARN] `fields = "__all__"` is a **standing commitment to expose every column you ever add**. It is the single most common source of API3 in Django codebases, and it fails open - the day someone adds a `kyc_status` or `internal_notes` column, it ships.

- **Authenticated is not authorized.** `IsAuthenticated` is the most-deployed permission class in production DRF and it stops nothing at object level.
- **Return 404, not 403, on a failed ownership check.** A 403 confirms the record exists, which turns any list endpoint into an enumeration oracle.
- **DRF ignores `?page_size=` unless you set `page_size_query_param`** - but the moment you set it, `max_page_size` is mandatory, or the caller chooses their own limit and API4 is yours.
- **SSRF sits in different places on the two lists.** The main Top 10:2025 folded SSRF into A01; the API list keeps it as its own entry, API7. On EC2 the payoff for an attacker is the instance metadata endpoint, so enforce IMDSv2 and allow-list outbound hosts rather than blocklisting `169.254.169.254`.
- **Your OpenAPI schema is reconnaissance.** It is genuinely useful in production, but it enumerates every route and field for an attacker too. Gate the schema and the browsable API behind auth, and treat any route you would not want listed as a reason to fix the route, not to hide it.

## Revise next
- **[OWASP Top 10:2025](owasp-top-10.md)**: A01 Broken Access Control, the parent category for API1/API3/API5.
- **[RBAC vs ABAC](rbac-vs-abac.md)**: the models behind object-level enforcement, and why ownership is an attribute check rather than a role check.
- **[DRF permissions](../drf/permissions.md)** and **[serializers](../drf/serializers.md)**: `get_queryset` scoping, `read_only_fields`, and object-level permission hooks.
- **[Rate limiting](../api-design/rate-limiting.md)** and **[JWT pitfalls](jwt-pitfalls.md)**: the controls behind API4 and API2.

*Reviewed against the OWASP API Security Top 10:2023 and OWASP Top 10:2025, July 2026.*
