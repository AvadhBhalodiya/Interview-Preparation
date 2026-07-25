---
title: "Secrets Management"
group: "Access & Data Protection"
order: 6
---

# Secrets Management (Env Vars, Secret Managers)

> Secrets - DB passwords, API keys, signing keys - never belong in code or git. Keep them behind a secret manager that encrypts, IAM-scopes, rotates, and audits, and treat plain env vars as the fallback baseline, not the destination.

## What it is
- Secrets management is the whole lifecycle of a credential: generating it, storing it, handing it to exactly the service that needs it, rotating it, and auditing every access. Get any one of those wrong and the rest barely matters.
- A **secret** is anything that grants access: DB passwords, API keys, OAuth client secrets, TLS private keys, JWT signing keys. Non-sensitive config (log levels, feature flags, timeouts) is **not** a secret - don't bury the real ones in that noise, and don't over-protect the boring ones.

> [!KEY] A secret in git is already **burned** - rotate it, don't just delete it. And a secret you never **rotate** is just a long-lived liability. Treat storage, least-privilege scope, and rotation as one system, not three separate checkboxes.

Where a secret can live, worst to best:

| Placement | Verdict | Why |
| --- | --- | --- |
| Hardcoded in code, committed to git | **Never** | Leaked the instant it lands in history - on every clone, fork, and CI cache. Rotate now, it is burned |
| Plain env vars | **Baseline only** | 12-factor config, fine for local dev, but **any process can read them** and they surface in logs, `/proc`, and crash dumps |
| Secret manager (Vault / AWS SM) | **Production default** | **Encrypted, IAM-scoped, rotated, audited**, and injected at runtime |

## Key points
- **Nothing sensitive in git, ever.** Add `.env` to `.gitignore` before the first commit, then run a scanner (gitleaks, trufflehog, or Yelp's detect-secrets) as **both** a pre-commit hook and a CI gate. Pre-commit catches honest mistakes. CI catches the ones that slipped through with `git commit --no-verify`. A hardcoded key maps to CWE-321 under **A04:2025 Cryptographic Failures**.
- **A committed secret is a burned secret.** Git keeps it in history and on every clone, fork, and CI cache, so deleting the line changes nothing. Rotate the credential first - that is the actual fix - and clean the history afterward.
- **Env vars are the baseline, not the goal.** 12-factor says put config in the environment, and for local dev that is fine. But OWASP is blunt: don't use env vars for secrets "unless the other methods are not possible," because every process can read them and they surface in logs, crash dumps, and `/proc/<pid>/environ`. In production, reach for a secret manager.
- **What a secret manager buys you:** encryption at rest, per-service IAM access, automated rotation, and an audit log of who read which secret and when. The options below trade cost for how much of that they automate.
- **Least privilege, one set of values per environment.** A service reads only the secrets it owns, and dev/staging/prod use different credentials so a leaked staging password is worthless against prod.
- **Short-lived beats static.** A dynamic Vault-issued database credential or an assumed IAM role that expires in minutes shrinks the blast radius far more than a static key you rotate once a quarter and forget about. OWASP's line is "use dynamic secrets where possible."
- **Don't log them, don't send them in the clear.** TLS is the floor for anything crossing a wire (TLS 1.3 per RFC 8446, TLS 1.2 as the minimum). Mask secret values in CI output and keep them out of error trackers and stack traces.

> [!TIP] One JSON blob per service (`prod/app/db`) beats scattering 20 individual keys: one IAM policy, one rotation job, one audit line, and the app parses it once at boot.

The options trade cost and convenience for control and rotation:

| Option | Encryption | Rotation | Best for |
| --- | --- | --- | --- |
| **Env vars** | **None** - plaintext in the process | Manual redeploy | Local dev, non-secret config |
| **AWS Parameter Store** (`SecureString`) | KMS at rest | Manual or a custom Lambda | **Cheap** config plus light secrets |
| **AWS Secrets Manager** | KMS at rest | **Built-in automatic** | Real production secrets, RDS credentials |
| **HashiCorp Vault** | Per-engine, at rest | Built-in plus **dynamic short-lived** | Multi-cloud, dynamic DB credentials |
| **AWS KMS** | It is the key layer others use | Automatic (yearly) | **Encrypting** data / other secrets, not storing them |

## Example
```bash
# local dev only - .env must be gitignored BEFORE the first commit
echo ".env" >> .gitignore
echo "DATABASE_URL=postgres://app:localpass@localhost:5432/app" >> .env
```
```python
import os

# avoid: hardcoded value - the moment this lands in git, the secret is burned
# DATABASE_URL = "postgres://app:prodpass@db.internal:5432/app"

# baseline: read from the environment; KeyError if missing, which is what you want
DATABASE_URL = os.environ["DATABASE_URL"]   # no default - fail loud, don't ship a fallback secret
```
In production that same variable is filled from the manager, not the shell - IAM decides whether the fetch is allowed, not a password sitting in the environment:
```python
# prod: fetch from the secret manager at startup; IAM decides if this call is allowed
import boto3, json

def load_db_url(secret_id: str) -> str:
    client = boto3.client("secretsmanager")
    secret = json.loads(client.get_secret_value(SecretId=secret_id)["SecretString"])
    return secret["url"]

DATABASE_URL = load_db_url("prod/app/db")
```

## Interview Q&A
- **"Where should secrets live?"** Not in code and not in git. Env vars are an acceptable baseline for local dev and simple deploys. For production, a secret manager that encrypts, scopes access with IAM, rotates, and audits. Worth saying out loud: OWASP actively discourages env vars for secrets when a manager is available.
- **"I committed an API key - can't I just delete it and force-push?"** No. Git history lives on every clone, fork, and CI cache, and `git rm` only removes the file going forward. Anyone who already pulled has it, and bots scrape public pushes within minutes. Rotate the key immediately. Scrubbing history is cleanup, not the fix.
- **"What does a secret manager give me that env vars don't?"** Encryption at rest, per-service IAM access, automatic rotation, and an audit trail. It also keeps the secret out of the process environment, where a sidecar or a crash dump can pick it up.
- **"How do you prevent leaks in the first place?"** Three layers: scanners at pre-commit and in CI so secrets never land, least-privilege scoping so any leak is low-value, and short-lived credentials so a leak expires on its own.

## Gotchas
> [!WARN] Force-pushing does not un-leak anything. Assume a pushed secret was scraped within minutes and **rotate first, clean history second**. Under pressure people burn an hour rewriting history while the live key is still valid.

> [!WARN] Never dump `os.environ` into a log line "just for debugging." Env vars leak in unobvious places: stack traces, `docker inspect`, `/proc/<pid>/environ`, and every child process that inherits them.

- SSM Parameter Store's `String` type isn't encrypted - use `SecureString`, and if you need real automatic rotation, that's Secrets Manager's job, not Parameter Store's.
- A secret manager you never rotate is just an expensive env var. Turn on automatic rotation or it quietly decays back to long-lived static keys.
- KMS stores keys, not arbitrary secrets. It encrypts and manages the keys that Secrets Manager and `SecureString` use under the hood - don't reach for it as a place to park a raw DB password.

## Revise next
- [HTTPS / TLS](https-tls-basics.md) (TLS 1.3, RFC 8446)
- [AWS core services](../devops/aws-core-services.md) (Secrets Manager, IAM roles)
- [OWASP Top 10:2025](owasp-top-10.md) - A04 Cryptographic Failures, A02 Security Misconfiguration, A03 Software Supply Chain Failures

*Reviewed against the OWASP Secrets Management Cheat Sheet, OWASP Top 10:2025 (A04 Cryptographic Failures), and RFC 8446 (TLS 1.3), July 2026.*
