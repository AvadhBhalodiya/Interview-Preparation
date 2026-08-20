---
title: "Secrets Management"
group: "Access & Data Protection"
order: 6
updated: "August 2026"
---

# Secrets Management: Environment Variables and Secret Managers

> How applications store, receive, rotate, and protect passwords, API keys, tokens, private keys, and other sensitive credentials.

## In Short

- A **secret** is a value whose exposure can grant access or weaken security, such as a database password, API key, access token, private key, or signing key.
- **Configuration is not automatically a secret.** A port, region, log level, or service URL may be stored in the same environment file but usually does not require the same protection.
- Never hardcode production secrets in source code, Docker images, scripts, or committed configuration files.
- Environment variables are mainly a **delivery mechanism**. They do not provide encryption, rotation, versioning, auditing, or lifecycle management by themselves.
- Production systems normally use a **secret manager** such as AWS Secrets Manager, Azure Key Vault, Google Cloud Secret Manager, or HashiCorp Vault.
- Prefer **workload identity** such as an IAM role, managed identity, or Kubernetes workload identity instead of storing long-lived cloud access keys.
- Prefer **short-lived or dynamic credentials** when supported because leaked credentials expire automatically and have a smaller blast radius.
- Rotation must update the secret in the **target system and the consuming application**, not only the value stored in the secret manager.
- If a secret leaks, **revoke or rotate it first**. Removing it from Git or logs does not invalidate copies that may already exist.

```mermaid
flowchart LR
    DEV[Developer] -->|Code without secrets| GIT[Git Repository]
    GIT --> CI[CI/CD]
    CI -->|OIDC / temporary identity| IAM[Cloud IAM]
    IAM --> PLATFORM[Runtime Platform]
    APP[Application] -->|Workload identity| IAM
    APP -->|Authorized read| SM[Secret Manager]
    SM --> APP
    APP --> DB[(Database / External API)]
    SM --> AUDIT[Audit Logs]
```

---

# 1. Secrets vs Configuration

A useful rule is:

> **If exposing a value can grant access, impersonate a system, decrypt protected data, or forge trusted data, treat it as a secret.**

| Value | Secret? | Example |
|---|---:|---|
| Application environment | No | `APP_ENV=production` |
| Log level | No | `LOG_LEVEL=INFO` |
| Service URL | Usually no | `API_BASE_URL=https://api.example.com` |
| Database password | Yes | `DATABASE_PASSWORD=...` |
| API key | Yes | Payment or map provider key |
| Signing key | Yes | Django `SECRET_KEY`, JWT private key |
| OAuth client secret | Yes | OAuth confidential client credential |
| Access / refresh token | Yes | Service or user token |
| Private key | Yes | TLS, SSH, asymmetric signing |
| Encryption key | Yes | Key protecting application data |

Configuration mainly needs validation and environment-specific values.

Secrets additionally need:

- encryption
- strict authorization
- auditing
- rotation
- revocation
- careful handling in logs, traces, crash reports, and support bundles

---

# 2. Why Hardcoded Secrets Are Dangerous

Hardcoding means placing the secret directly in code, a committed file, a Docker image, or a build script.

```python
# Never do this
DATABASE_URL = "postgresql://admin:password123@db.example.com/app"
```

The main problem is not only that someone can read the current file.

A committed secret may remain in:

- Git history
- forks and mirrors
- developer clones
- CI/CD logs
- backups
- container layers
- build caches
- copied configuration files

Deleting the latest line does **not** make the old credential safe.

A good repository should remain safe even if somebody can inspect the complete source code. The code may reveal **where a secret is loaded**, but never the production secret value itself.

---

# 3. Environment Variables

Environment variables are widely used because they are simple and supported by almost every framework and deployment platform.

```bash
export DATABASE_PASSWORD="sensitive-value"
python app.py
```

```python
import os

database_password = os.environ["DATABASE_PASSWORD"]
```

## 3.1 What Environment Variables Solve

They help separate deployment-specific values from application code.

They are useful for:

- local development
- container configuration
- runtime injection by deployment platforms
- simple application configuration

## 3.2 What They Do Not Solve

An environment variable does not automatically provide:

- encrypted central storage
- access-control policies
- rotation
- audit history
- secret versions
- expiration
- revocation

Something must still protect the value **before** it becomes an environment variable.

```mermaid
flowchart LR
    A[.env file] --> ENV[Environment Variable]
    B[CI/CD Secret Store] --> ENV
    C[Secret Manager] --> ENV
    ENV --> APP[Application Process]
```

## 3.3 Environment Variable Risks

Secrets can accidentally appear through:

- application logs
- `printenv` or full configuration dumps
- debug endpoints
- crash reports
- process inspection
- container inspection
- deployment manifests
- child processes that inherit the environment

Avoid code such as:

```python
print(dict(os.environ))
```

For required production secrets, fail at startup instead of using insecure defaults.

```python
import os

def required_env(name: str) -> str:
    value = os.getenv(name)
    if not value:
        raise RuntimeError(f"Missing required environment variable: {name}")
    return value
```

---

# 4. What a Secret Manager Adds

A dedicated secret manager manages the **secret lifecycle**, not only delivery.

Common examples:

- AWS Secrets Manager
- Azure Key Vault
- Google Cloud Secret Manager
- HashiCorp Vault

Typical capabilities include:

| Capability | Environment variable alone | Secret manager |
|---|---:|---:|
| Central encrypted storage | No | Yes |
| Fine-grained authorization | External | Yes |
| Audit trail | Usually no | Yes |
| Versioning | No | Usually |
| Rotation support | No | Yes / provider-dependent |
| Expiration or leases | No | Supported by some systems |
| Runtime retrieval API | No | Yes |
| Central governance | Limited | Strong |

The most important production pattern is:

```text
Application identity
      ↓
Authorization policy
      ↓
Secret manager
      ↓
Only the required secret
```

The application should not need a second long-lived secret merely to authenticate to the secret manager.

---

# 5. Workload Identity and Least Privilege

A running application needs an identity before a secret manager can decide whether it may read a secret.

Prefer platform-provided identities such as:

- AWS IAM role
- Azure managed identity
- Google Cloud service account / workload identity
- Kubernetes service account with workload identity federation
- Vault authentication using Kubernetes, cloud IAM, OIDC, or certificates

Avoid storing permanent cloud access keys inside the application.

## 5.1 Least Privilege

An orders service should read only its own secrets.

```text
Allowed:
  /prod/orders/database
  /prod/orders/payment-provider

Avoid:
  /prod/*
  secret-manager-admin
```

Also keep development, staging, and production isolated. A development workload should not be able to read production secrets.

## 5.2 CI/CD Identity

Modern CI/CD systems can use OIDC federation:

```mermaid
sequenceDiagram
    participant CI as CI/CD Job
    participant OIDC as OIDC Provider
    participant IAM as Cloud IAM
    participant DEP as Deployment Platform

    CI->>OIDC: Request signed identity token
    OIDC-->>CI: Short-lived OIDC token
    CI->>IAM: Exchange token
    IAM-->>CI: Temporary cloud credentials
    CI->>DEP: Deploy application
```

This removes the need to keep a permanent cloud access key in the CI/CD secret store.

---

# 6. How Applications Receive Secrets

A secret manager and an environment variable are not always alternatives. The manager may store the value while another mechanism delivers it.

## 6.1 Environment Variable Injection

```text
Secret Manager → Platform → Environment Variable → Application
```

**Good:** simple application code.

**Trade-off:** rotation often requires restarting the process because environment variables normally do not change inside an already running process.

## 6.2 Mounted Secret File

```text
Secret Manager → Mounted File → Application
```

Common for:

- TLS certificates
- private keys
- database passwords

Advantages:

- secret is not placed in the process environment
- file permissions can restrict access
- some platforms can refresh mounted content

The application still needs logic to reload an updated file.

## 6.3 Direct API Retrieval

```text
Application → Secret Manager API → Secret Value
```

Advantages:

- strong auditing
- current secret versions can be retrieved
- runtime refresh is possible

Trade-offs:

- the application depends on the secret-manager API
- use retries and controlled caching
- avoid requesting the secret on every business request

## 6.4 Sidecar or Agent

```text
Secret Manager → Agent / Sidecar → Restricted Local File or Endpoint → Application
```

This is useful when infrastructure should handle authentication, caching, or renewal without putting vendor-specific secret logic directly in the application.

---

# 7. Static Secrets, Dynamic Secrets, and Rotation

## 7.1 Static Secret

A static secret remains valid until somebody changes or revokes it.

Examples:

- third-party API key
- manually created database password
- webhook signing secret

If leaked, it may remain usable for a long time.

## 7.2 Dynamic Secret

A dynamic credential is created when needed and has a limited lifetime.

Examples:

- temporary database username/password
- short-lived cloud credentials
- time-limited certificate
- temporary access token

HashiCorp Vault, for example, can issue database credentials with a lease and revoke them when the lease expires.

```mermaid
sequenceDiagram
    participant APP as Application
    participant VAULT as Vault
    participant DB as Database

    APP->>VAULT: Request database access
    VAULT->>DB: Create temporary DB user
    DB-->>VAULT: Credential
    VAULT-->>APP: Credential + lease
    APP->>DB: Use temporary credential
    VAULT->>DB: Revoke when lease expires
```

Dynamic credentials reduce the exposure window and make per-service auditing easier.

## 7.3 Rotation

Rotation changes an existing credential safely.

The important point is:

> Updating the value in the secret manager alone is not enough.

The target service must recognize the new credential, and the application must start using it.

A safe rotation normally looks like:

```text
1. Create new credential
2. Make target service accept it
3. Publish new secret version
4. Refresh/restart consumers
5. Verify authentication
6. Revoke old credential
```

When possible, temporarily overlap old and new credentials to avoid downtime.

---

# 8. Docker, Kubernetes, and CI/CD

## 8.1 Docker

Do not bake secrets into an image.

```dockerfile
# Avoid
ARG DATABASE_PASSWORD
ENV DATABASE_PASSWORD=$DATABASE_PASSWORD
```

Build-time values may leak through image history, caches, build logs, or registry access.

Prefer runtime injection or mounted secrets.

A container image should be reusable across development, staging, and production without containing environment-specific credentials.

## 8.2 Kubernetes

A Kubernetes `Secret` is a resource type for sensitive data, but **Base64 is encoding, not encryption**.

```yaml
apiVersion: v1
kind: Secret
metadata:
  name: database-secret
type: Opaque
data:
  password: cGFzc3dvcmQ=
```

That value can be decoded easily.

Protect Kubernetes Secrets with:

- least-privilege RBAC
- encryption at rest for Secret data in `etcd`
- restricted `get`, `list`, and `watch` permissions
- workload identity
- audit logging
- namespace isolation
- external secret-store integrations when appropriate

Kubernetes documentation explicitly warns that granting `list` access to Secrets lets the subject retrieve Secret contents.

### Current Kubernetes Note — August 2026

Kubernetes **v1.36** is the current documentation version. For KMS-backed API-data encryption, **KMS v2** is the preferred implementation; KMS v1 is deprecated and has been disabled by default since Kubernetes v1.29.

## 8.3 CI/CD

CI/CD pipelines are high-value targets because they may reach source code, registries, cloud accounts, and production environments.

Prefer:

- OIDC federation instead of permanent cloud keys
- minimum token permissions
- secret masking as a backup control
- no `env` / `printenv` dumps
- no secret-containing artifacts
- restricted access for untrusted pull requests
- reviewed and pinned third-party actions/plugins

---

# 9. Practical Example: FastAPI on AWS

Consider a FastAPI service running on ECS.

Architecture:

```mermaid
flowchart LR
    GH[GitHub Actions] -->|OIDC| IAM1[Deployment IAM Role]
    IAM1 --> ECS[ECS Service]

    APP[FastAPI Task] -->|ECS Task Role| IAM2[AWS IAM]
    APP -->|GetSecretValue| SM[AWS Secrets Manager]
    SM -->|DB credentials| APP
    APP --> DB[(PostgreSQL)]
    SM --> LOG[Cloud Audit Logs]
```

The important security property is that neither GitHub Actions nor the application needs a permanent AWS access key.

A small application-side retrieval function can look like:

```python
import json
import boto3

secrets = boto3.client("secretsmanager")

def load_database_secret(secret_id: str) -> dict[str, str]:
    response = secrets.get_secret_value(SecretId=secret_id)
    return json.loads(response["SecretString"])
```

In ECS, the AWS SDK can obtain credentials from the **task IAM role** automatically.

In a real application:

- retrieve the secret during startup or through a controlled provider
- cache it for a sensible period
- handle transient secret-manager failures
- refresh when rotation requires it
- never log the returned value
- give the task role access only to the required secret

AWS Secrets Manager supports rotation workflows that update both the stored secret and the database or service the credential belongs to.

---

# 10. Secret Leakage Response

Treat a secret found in Git, logs, chat, an image, or a support bundle as compromised.

Correct order:

```mermaid
flowchart LR
    A[Leak detected] --> B[Revoke or rotate]
    B --> C[Contain access]
    C --> D[Review audit logs]
    D --> E[Remove exposed copies]
    E --> F[Clean Git/log history if required]
    F --> G[Add prevention controls]
```

Why rotation comes first:

Removing the secret from the repository only removes one copy. Anybody who already copied the credential can continue using it until the credential is revoked or expires.

After containment, investigate:

- when it was exposed
- who could access it
- what permissions it had
- whether it was used unexpectedly
- whether active sessions or derived tokens must also be revoked

---

# 11. Interview-Focused Mental Model

For interviews, think about secret management as a lifecycle:

```text
STORE
  ↓
AUTHENTICATE THE WORKLOAD
  ↓
AUTHORIZE WITH LEAST PRIVILEGE
  ↓
DELIVER AT RUNTIME
  ↓
USE WITHOUT LOGGING
  ↓
ROTATE / EXPIRE
  ↓
AUDIT
  ↓
REVOKE WHEN NEEDED
```

A strong production design therefore has these properties:

- secrets are never hardcoded or committed
- secret values are stored in an approved encrypted system
- applications authenticate with workload identity
- each service reads only the secrets it needs
- secrets are delivered only at runtime
- logs and traces redact sensitive values
- short-lived credentials are preferred when practical
- rotation is tested and does not require source-code changes
- secret reads and policy changes are auditable
- leaked credentials are revoked immediately

The key distinction to remember is:

> **Environment variables deliver values. Secret managers manage the lifecycle of sensitive values.**
