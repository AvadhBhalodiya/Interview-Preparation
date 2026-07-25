# Interview Guide — what to study, and what they'll ask

A map from your résumé to the questions interviewers actually ask, and to the
notes in this site that answer them. Read this first, then use the site.

**Your profile:** Python backend engineer, 3+ years, fintech/SaaS.
**Core stack:** Django/DRF, FastAPI, PostgreSQL, AWS, Celery/Taskiq, Redis, WebSockets, Docker.
**Differentiators:** payment gateways (Stripe), KYC/compliance, RBAC/ABAC, VAPT
remediation, BSE/NBFC integrations, high-volume transaction processing, microservices.

Your differentiator is not "knows Django". Plenty of candidates know Django. It
is that you have **moved real money and handled regulated data in production**.
Steer answers there whenever the question gives you room.

---

## 1. The coverage map

| Area | What they probe | Where it lives |
|---|---|---|
| **Python core** | GIL and the free-threaded build, threads vs processes vs asyncio, decorators, generators, context managers, GC, dataclasses, typing | `python/` (17) |
| **Django/DRF** | ORM laziness, `select_related`/`prefetch_related`, N+1, `transaction.atomic`, migrations, signals, custom user model, serializers, permissions, throttling | `django/` (12), `drf/` (5) |
| **FastAPI** | async/await, `Depends`, Pydantic v2, background tasks, ASGI, when to pick it over Django | `fastapi/` (8) |
| **PostgreSQL** | index types and when each is used, `EXPLAIN ANALYZE`, isolation levels, locking, MVCC/VACUUM, pooling, partitioning | `databases/` (12) |
| **Async & queues** | Celery vs Taskiq, beat, brokers, idempotent tasks, retries/backoff, DLQ, at-least-once semantics | `task-processing/` (6) |
| **Caching** | cache-aside vs write-through, invalidation, TTL, stampede, distributed locks, rate limiting | `caching/` (5) |
| **AWS & DevOps** | EC2/RDS/S3/SQS/ECS/CloudWatch, Docker, CI/CD, deployment strategies, observability | `devops/` (6) |
| **API design** | REST semantics, versioning, idempotency, pagination, rate limiting, webhooks, OAuth/JWT | `api-design/` (8) |
| **Security** | OWASP Top 10 and API Top 10, injection/XSS/CSRF, authn vs authz, RBAC vs ABAC, JWT pitfalls, TLS, PII/KYC handling | `security/` (8) |
| **Testing** | pytest fixtures/parametrize, mocking, TDD, unit vs integration vs E2E, coverage | `testing/` (4) |
| **Payments & fintech** | idempotency keys, double-entry ledger, reconciliation, webhook reliability, PCI scope, mandates and recurring billing | `payments/` (6) |
| **System design** | payment system, rate limiter, job scheduler, WebSocket scaling, KYC pipeline, notifications, DB scaling, caching, CAP | `system-design/` (10) |
| **Behavioral** | STAR, leadership, conflict, failure, prioritisation, stakeholder management | `behavioral/` (6) |

---

## 2. Questions you should expect, by round

### Screening / fundamentals
- Explain the GIL. Does it make threads useless in Python? *(No — I/O releases it.)*
- `select_related` vs `prefetch_related`, and how you'd spot an N+1 in production.
- When is a Django QuerySet actually evaluated?
- Generators vs lists — when does the memory difference matter?
- How do you decide between Django and FastAPI for a new service?

### Database round
- Walk me through `EXPLAIN ANALYZE` output. What tells you the index isn't used?
- Which isolation level does Postgres default to, and what anomaly does it still allow?
- Optimistic vs pessimistic locking — which did you use, and why?
- How would you scale reads? At what point do you shard, and what breaks when you do?
- Why is a connection pool necessary in front of Postgres?

### Async / reliability round — *your strong ground*
- Your task ran twice. Why, and how do you make that safe?
- At-least-once vs exactly-once. Does exactly-once delivery exist? *(No.)*
- How do retries, backoff and a DLQ fit together?
- Celery Beat is running on three instances. What goes wrong?
- How do you keep 10k jobs/day flowing without a backlog?

### Payments / domain round — *where you win*
- A charge request times out. Did the customer get charged? What do you do?
- Design an idempotency scheme for a payment endpoint.
- Why a double-entry ledger instead of a balance column?
- Your webhook handler missed an event. How do you find out and recover?
- How do you keep PCI scope small?

### Security round
- Walk through the OWASP Top 10 you've personally fixed. *(You have VAPT experience — use it.)*
- RBAC vs ABAC: when is RBAC not enough?
- How do you revoke a JWT? *(Trick question — you can't, stateless. Talk TTL, refresh rotation, denylist.)*
- Where do secrets live in your deployment?
- How do you keep PII out of logs and Sentry?

### System design
- Design a payment system. *(Lead with idempotency + ledger + reconciliation.)*
- Design a rate limiter. *(Token bucket, Redis, atomicity.)*
- Scale a WebSocket chat to 100k connections.
- Design a job scheduler.

### Behavioral
- Tell me about a time you led something.
- A disagreement with a senior engineer or stakeholder.
- Something you shipped that failed.
- How you prioritise when everything is urgent.

---

## 3. How to answer well

> Structure every technical answer as: **direct answer → mechanism → trade-off → what you did in production.** The last clause is what separates you.

- **Answer the question in the first sentence.** Then justify. Interviewers cut you off mid-preamble.
- **Name real defaults and numbers.** "Celery's Redis visibility timeout defaults to an hour" beats "there's a timeout setting".
- **Volunteer the trade-off.** Every design answer should include what you gave up.
- **Say "I don't know, here's how I'd find out"** rather than guessing. Guessing wrong on something adjacent to your résumé is far more damaging than admitting a gap.
- **Quantify your stories.** 40% CRM time cut, ~50% latency reduction, 3× throughput,
  60% faster deploys, ~70% fewer support tickets, 4 weeks → 1 week integration,
  99.9% uptime. Have the context and your specific contribution ready for each.
- **Use "I", not "we"**, when describing what you did. Use "we" for context only.

> The STAR answers in `behavioral/` are **drafts built around your real accomplishments**,
> with the surrounding narrative reconstructed. Correct the specifics against your own
> memory before rehearsing them — follow-up questions go one level deeper than the story
> you told. The failure story in `behavioral/failure-and-learning.md` is illustrative only
> and must be replaced with a real mistake of yours.

---

## 4. Worth reading for the 2026 landscape

- **Python 3.13/3.14** — the free-threaded (no-GIL) build became officially
  supported in 3.14, plus the JIT. Expect "is the GIL gone?" as a current-events
  question. Know that free-threaded is a build option, not the default.
- **Pydantic v2** — Rust core, big validation speedup, and the v1→v2 migration
  gotchas (`model_validate`, `model_dump`, validator decorators).
- **Async SQLAlchemy 2.0** and async Django ORM — where async actually helps and
  where it does not.
- **Django 5.x/6.0** — async views and ORM, and the built-in Tasks framework
  (`@task`, `.enqueue()`) and how it differs from Celery.
- **PostgreSQL 17/18** — recent planner and index improvements.
- **OpenTelemetry / Sentry** — distributed tracing is increasingly assumed rather
  than a bonus.
- **AI-assisted development** — you list Claude Code CLI on your résumé. Expect a
  question about it. The strong answer is about judgment: what you delegate, how
  you verify output, and where you would not trust it (security-sensitive code,
  anything you can't review).

---

## 5. A two-week plan

| Days | Focus |
|---|---|
| 1–2 | `python/` — GIL, async, generators, decorators, context managers |
| 3–4 | `django/` + `drf/` — ORM, N+1, transactions, serializers, permissions |
| 5 | `databases/` — indexing, `EXPLAIN`, isolation, locking |
| 6 | `task-processing/` + `caching/` — idempotency, retries, DLQ, stampede |
| 7 | `payments/` — your differentiator, know these cold |
| 8 | `security/` — OWASP, API Top 10, JWT, PII |
| 9 | `api-design/` + `fastapi/` |
| 10 | `devops/` + `testing/` |
| 11–12 | `system-design/` — do the payment system and rate limiter out loud, on a whiteboard |
| 13 | `behavioral/` — rehearse each STAR story once, out loud, timed |
| 14 | Re-read every `## Gotchas` section. That's where interviews are lost. |

Use the **Mark done** button as you go — the home page tracks section progress.
