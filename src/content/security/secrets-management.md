---
title: "Secrets Management"
group: "Access & Data Protection"
order: 6
updated: "August 2026"
---

# Secrets Management: Environment Variables and Secret Managers

> How secrets travel from a developer laptop to a running process, why environment variables alone are not enough, and what a dedicated secret manager adds.

## In short

- A **secret** is anything that grants access or proves identity — a database password, API key, private key, or signing key — while a log level, port number, or region name is configuration, not a secret, even sitting in the same `.env` file.
- A hardcoded secret isn't neutralized by deleting it later: it persists in Git history and a private repo can still be forked, mirrored, or made public — and once a secret does leak, revoke or rotate it first, since cleaning up the file or log doesn't invalidate a copy an attacker already took.
- An environment variable is a **delivery mechanism, not a management system** — by itself it gives no encrypted storage, no rotation, no access audit trail, and no expiration; something still has to protect the value before it becomes `os.environ["DATABASE_PASSWORD"]`.
- A dedicated secret manager (AWS Secrets Manager, HashiCorp Vault, Azure Key Vault, Google Cloud Secret Manager) adds what an env var alone can't: centralized encrypted storage, identity-based access, auditing, versioning, and rotation.
- Prefer workload identity — an IAM role, a managed identity, a Kubernetes service account — over an embedded cloud access key: the app authenticates as itself and receives a short-lived token, so there is no standing credential to leak.
- Dynamic, short-lived credentials beat static ones: a leaked static API key can be replayed for months, while a database credential minted per lease and auto-revoked has a bounded blast radius.
- Rotation must update both sides — the target system and every consuming application, plus any caches — not just the value in the secret manager; overlap old and new credentials instead of cutting over instantly.

```mermaid
flowchart TD
    DEV[Developer] -->|Pushes code without secrets| GIT[Git Repository]
    GIT --> CI[CI/CD Pipeline]
    CI -->|OIDC federation| IAM[Cloud IAM]
    IAM -->|Temporary deployment permission| PLATFORM[Container Platform]

    APP[Application Container] -->|Workload identity| IAM
    APP -->|Read allowed secret| SM[Secret Manager]
    SM -->|Encrypted secret value| APP
    APP --> DB[(Database)]

    SM --> AUDIT[Audit Logs]
    IAM --> AUDIT
    APP --> OBS[Redacted App Logs and Metrics]
```

**Interview answer:** In production nothing is hardcoded or committed — the CI/CD pipeline deploys using a short-lived, identity-federated credential instead of a stored cloud key, and the running application proves its own identity to the platform (an IAM role or managed identity) rather than embedding one. That identity is exchanged for a short-lived token used to read secrets from a dedicated secret manager over TLS, which enforces least-privilege access per secret and audits every read. Rotation then updates the credential everywhere it is consumed, and if a secret ever leaks, the response is to revoke or rotate it immediately, not just delete the copy that was found.

**Gotcha:** Assuming a Kubernetes `Secret` is encrypted because of its name. The value is only Base64-encoded — anyone who can `kubectl get` it, or merely `list`/`watch` Secrets in that namespace, can trivially decode it, so RBAC and encryption-at-rest in `etcd` are what actually protect it, not the resource kind.

---

# 1. What Is a Secret?

A **secret** is sensitive information that allows a person, application, or machine to prove identity or gain privileged access.

Common examples include:

| Secret type | Example |
|---|---|
| Database credential | PostgreSQL username and password |
| API key | Payment gateway or map service key |
| Application signing key | Django `SECRET_KEY` or JWT signing key |
| OAuth credential | Client secret or refresh token |
| Cloud credential | Access key and secret access key |
| Private key | SSH, TLS, or asymmetric signing key |
| Encryption key | Key used to encrypt application data |
| Webhook secret | Value used to verify webhook signatures |
| Service token | Token used for service-to-service communication |

A value is not automatically a secret just because it is stored in an environment variable.

For example:

```env
APP_ENV=production
LOG_LEVEL=INFO
API_BASE_URL=https://api.example.com
```

These values are configuration, but they are normally not confidential.

The following values are secrets:

```env
DATABASE_PASSWORD=super-sensitive-value
STRIPE_SECRET_KEY=sk_live_xxxxxxxxx
JWT_PRIVATE_KEY=...
```

---

# 2. Configuration vs Secrets

Configuration and secrets often enter an application through similar mechanisms, but they have different security requirements.

## 2.1 Configuration

Configuration changes application behavior but does not normally grant access.

Examples:

- environment name
- port number
- feature flag
- log level
- service URL
- timeout
- page size
- region name

## 2.2 Secrets

Secrets grant access, prove identity, or protect sensitive data.

Examples:

- passwords
- API keys
- private keys
- access tokens
- encryption keys
- signing keys

## 2.3 Why the Difference Matters

Configuration needs:

- easy deployment-specific changes
- validation
- sensible defaults
- versioned application behavior

Secrets additionally need:

- encryption
- strict access control
- auditing
- rotation
- revocation
- protection from logs and diagnostics

```mermaid
flowchart LR
    A[Application settings] --> B{Does exposure grant access<br/>or break security?}
    B -- No --> C[Normal configuration]
    B -- Yes --> D[Secret]
    C --> E[Config file or environment variable]
    D --> F[Secret manager or secure runtime injection]
```

---

# 3. Why Hardcoded Secrets Are Dangerous

A hardcoded secret is written directly into source code, a container image, a script, or a committed configuration file.

```python
# Never do this
DATABASE_URL = "postgresql://admin:password123@db.example.com/app"
```

## 3.1 Main Risks

### Repository history

Deleting a secret from the latest commit does not remove it from earlier Git history.

### Broad visibility

Anyone who can clone or inspect the repository may obtain the secret.

### Accidental public exposure

A private repository may later become public, be forked, mirrored, backed up, or copied into another system.

### Difficult rotation

The secret is tightly coupled to an application release. Changing it may require code changes and redeployment.

### Container image leakage

Secrets added during a Docker build may remain in image layers, build logs, or image metadata.

### Reuse across environments

Developers may accidentally use the same credentials in development, staging, and production, increasing the blast radius.

## 3.2 The Repository Safety Test

A well-designed application should be safe if its source repository becomes visible.

The code may reveal:

- secret names
- secret locations
- retrieval logic
- configuration structure

It must not reveal:

- secret values
- long-lived credentials
- private keys
- production access tokens

---

# 4. Environment Variables

Environment variables are key-value pairs provided to a process by the operating system, container runtime, deployment platform, or orchestrator.

```bash
export DATABASE_HOST=db.internal
export DATABASE_PASSWORD='sensitive-value'
python app.py
```

The application reads them at runtime:

```python
import os

database_password = os.environ["DATABASE_PASSWORD"]
```

## 4.1 Why Environment Variables Are Popular

They are:

- language-independent
- easy to use
- supported by most deployment platforms
- easy to change without modifying source code
- suitable for separating deployment configuration from code

This is why the Twelve-Factor App methodology recommends storing deployment configuration in the environment.

## 4.2 Important Limitation

An environment variable is primarily a **delivery mechanism**, not a complete secret-management system.

By itself, it does not provide:

- encrypted central storage
- automatic rotation
- access auditing
- version history
- expiration
- fine-grained authorization
- controlled revocation

Someone or something still has to store the value before it becomes an environment variable.

```mermaid
flowchart LR
    A[Plaintext file] --> D[Environment variable]
    B[CI/CD secret store] --> D
    C[Cloud secret manager] --> D
    D --> E[Application process]
```

The security of the environment variable therefore depends heavily on its source and the runtime environment.

## 4.3 Risks of Environment Variables

Environment variables may be exposed through:

- debug endpoints
- application error reports
- process inspection
- system dumps
- `/proc` on some Linux configurations
- container inspection commands
- deployment manifests
- CI/CD logs
- support bundles
- accidental logging of full configuration
- child processes that inherit the environment

Example of unsafe logging:

```python
import os

# Dangerous: may print passwords, tokens, and private keys
print(dict(os.environ))
```

## 4.4 When Environment Variables Are Reasonable

They are commonly acceptable for:

- local development with a non-committed `.env` file
- short-lived test environments
- low-risk internal applications
- values injected by a trusted orchestrator
- platforms where a managed secret is exposed to the process as an environment variable

Even in these situations:

- never commit the values
- use separate secrets per environment
- keep access narrow
- avoid printing the environment
- rotate leaked values immediately

## 4.5 Required vs Optional Values

Fail fast when a required secret is missing.

```python
import os

def required_env(name: str) -> str:
    value = os.getenv(name)
    if not value:
        raise RuntimeError(f"Required environment variable is missing: {name}")
    return value

database_password = required_env("DATABASE_PASSWORD")
```

Do not provide insecure production defaults:

```python
# Dangerous
secret_key = os.getenv("SECRET_KEY", "default-secret-key")
```

A default value may silently reach production and make every deployment share a predictable secret.

---

# 5. Dedicated Secret Managers

A secret manager is a system built specifically to store, control, retrieve, audit, version, and rotate secrets.

Common solutions include:

| Environment | Common solution |
|---|---|
| AWS | AWS Secrets Manager |
| Google Cloud | Google Cloud Secret Manager |
| Microsoft Azure | Azure Key Vault |
| Cloud, hybrid, or on-premises | HashiCorp Vault |
| Kubernetes | External Secrets Operator, Secrets Store CSI Driver, or platform integrations |
| CI/CD | Platform-provided encrypted secret store |

## 5.1 Core Capabilities

A dedicated secret manager commonly provides:

### Centralized encrypted storage

Secrets are stored in one controlled system instead of being scattered across servers and files.

### Identity-based access

Applications authenticate using workload identity, IAM roles, managed identities, service accounts, or another machine identity.

### Fine-grained authorization

A service can be permitted to read only the secrets it needs.

### Auditing

The system records who or what requested a secret and when.

### Versioning

Multiple versions can support rotation, rollback, and controlled migration.

### Rotation

The system can help create, activate, and retire credentials.

### Expiration and revocation

Access can be time-bound, and credentials can be disabled after compromise.

### High availability

Managed services generally provide regional durability and availability features.

## 5.2 Runtime Retrieval Flow

```mermaid
sequenceDiagram
    participant App as Application
    participant ID as Workload Identity
    participant SM as Secret Manager
    participant DB as Database

    App->>ID: Obtain short-lived identity token
    ID-->>App: Temporary credential
    App->>SM: Request database secret
    SM->>SM: Check IAM policy and audit request
    SM-->>App: Return secret over TLS
    App->>DB: Connect using retrieved credential
```

The application does not need a long-lived cloud access key if the platform gives it a workload identity.

---

# 6. Environment Variables vs Secret Managers

They are not always direct alternatives.

A secret manager controls the **secret lifecycle**. An environment variable may be one of several ways to deliver the secret to the application.

| Area | Environment variable alone | Dedicated secret manager |
|---|---|---|
| Primary purpose | Process configuration delivery | Secret lifecycle management |
| Central encrypted storage | No | Yes |
| Fine-grained access control | Limited or external | Yes |
| Access audit trail | Usually no | Yes |
| Automatic rotation | No | Often supported |
| Secret versions | No | Usually supported |
| Expiration | No | Often supported |
| Runtime API retrieval | Not applicable | Yes |
| Local simplicity | High | Lower |
| Production governance | Limited | Strong |
| Cost and setup | Low | Higher |
| Best fit | Local development and simple deployment | Production and sensitive systems |

## 6.1 A Practical Maturity Model

### Level 1: Hardcoded secret

```python
API_KEY = "abc123"
```

This is unacceptable.

### Level 2: Non-committed `.env` file

```env
API_KEY=abc123
```

This is useful for local development but does not solve production governance.

### Level 3: Deployment-platform secret

A CI/CD or hosting platform stores an encrypted value and injects it during deployment.

This is acceptable for many small and medium applications when access control and auditing are sufficient.

### Level 4: Dedicated secret manager

The application or runtime retrieves secrets using workload identity, with auditing and rotation.

This is the preferred production model for sensitive or regulated systems.

### Level 5: Dynamic, short-lived credentials

The secret manager generates credentials on demand with a limited lifetime and automatically revokes them.

This reduces the impact of credential leakage.

---

# 7. How Applications Receive Secrets

There are four common delivery patterns.

## 7.1 Environment Variable Injection

The deployment platform reads a protected secret and sets it as an environment variable.

```mermaid
flowchart LR
    SM[Secret Store] --> O[Deployment Platform]
    O -->|Inject env variable| P[Application Process]
```

**Advantages**

- simple application code
- supported by almost every framework
- easy to adopt

**Limitations**

- the secret remains in the process environment
- rotation may require a process restart
- accidental environment logging can expose it

## 7.2 Mounted Secret File

The platform mounts a secret as a file, often in an in-memory or restricted filesystem, typically at a path such as `/run/secrets/database_password`.

Application code:

```python
from pathlib import Path

password = Path("/run/secrets/database_password").read_text().strip()
```

**Advantages**

- not included in the process environment
- works well for certificates and private keys
- some platforms update mounted files after rotation

**Limitations**

- file permissions must be correct
- the application must reload the value
- copying the file into another location increases exposure

## 7.3 Direct API Retrieval

The application calls the secret manager when it starts or when the value is needed.

```python
def load_database_secret(secret_client) -> dict:
    response = secret_client.get_secret_value(SecretId="production/database")
    return parse_secret(response["SecretString"])
```

**Advantages**

- strong control and auditing
- can retrieve current versions
- supports runtime refresh

**Limitations**

- application depends on the secret manager
- requires retry, caching, and failure handling
- excessive calls may add latency and cost

## 7.4 Sidecar or Agent Injection

A local agent authenticates to the secret manager and writes secrets to a shared memory-backed volume.

```mermaid
flowchart LR
    SM[Secret Manager] --> A[Sidecar or Agent]
    A --> V[Restricted Shared Volume]
    V --> APP[Application]
```

**Advantages**

- application does not need vendor-specific SDK code
- the agent can renew leases and refresh secrets
- useful in Kubernetes and service platforms

**Limitations**

- more infrastructure complexity
- agent permissions and shared volume security must be managed carefully

---

# 8. Static vs Dynamic Secrets

## 8.1 Static Secret

A static secret exists until someone rotates or deletes it.

Examples:

- a fixed third-party API key
- a database password created manually
- a webhook signing secret

The flow is simple and static: `Application -> reads fixed credential -> database`. The risk is that a leaked static secret may remain usable for weeks or months.

## 8.2 Dynamic Secret

A dynamic secret is generated when requested and has a limited lifetime.

Examples:

- temporary database username and password
- short-lived cloud credential
- time-limited certificate
- temporary access token

```mermaid
sequenceDiagram
    participant App
    participant Vault
    participant DB

    App->>Vault: Request database access
    Vault->>DB: Create temporary DB user
    DB-->>Vault: Temporary credential
    Vault-->>App: Credential + lease
    Note over App: Use credential for limited time
    Vault->>DB: Revoke user when lease expires
```

## 8.3 Why Dynamic Secrets Are Stronger

Dynamic secrets provide:

- shorter exposure windows
- easier revocation
- per-application credentials
- clearer audit trails
- reduced secret sharing
- less manual rotation

They require more operational maturity, but they are valuable for high-risk production systems.

---

# 9. Secret Rotation

Rotation replaces an existing secret with a new one and safely removes the old value.

A secure rotation process must update both sides:

1. the target system that validates the credential
2. the applications that use the credential

Changing only the value in the secret manager is not enough.

## 9.1 Basic Rotation Flow

```mermaid
flowchart LR
    A[Create new secret version] --> B[Update target service]
    B --> C[Allow application to use new version]
    C --> D[Verify traffic and health]
    D --> E[Disable old version]
    E --> F[Delete old version after safety window]
```

## 9.2 Zero-Downtime Rotation

When supported, use overlapping credentials:

1. create a second valid credential
2. publish it as the new secret version
3. refresh or restart applications
4. verify successful authentication
5. revoke the old credential

This is safer than invalidating the old credential first.

## 9.3 Application Considerations

A rotating application should:

- avoid loading a secret only once for its entire lifetime
- cache values for a controlled period
- refresh on authentication failure when appropriate
- support both current and previous versions during migration
- avoid infinite retry loops
- expose health signals without exposing secret values

## 9.4 Rotation Frequency

There is no universal interval for every secret. Frequency depends on:

- secret sensitivity
- blast radius
- ability to rotate automatically
- regulatory requirements
- provider limitations
- whether the credential is short-lived
- evidence of compromise

Automatic short-lived credentials are generally safer than manually rotating long-lived passwords on a calendar.

---

# 10. Identity and Access Control

The application needs permission to read a secret. That permission should come from its identity, not from another long-lived secret whenever possible.

## 10.1 Preferred Identity Types

Use platform-native workload identity:

- AWS IAM role
- Google Cloud service account or workload identity
- Azure managed identity
- Kubernetes service account with workload identity federation
- Vault authentication using Kubernetes, cloud IAM, OIDC, or certificates

Avoid embedding cloud access keys inside the application.

## 10.2 Least Privilege

A payment service may need `read: production/payment-provider` and `read: production/payment-database` — never a broad grant such as `read: production/*` or `admin: secret-manager`.

## 10.3 Separate Environments

Development, staging, and production should use:

- different secret values
- different access policies
- preferably different accounts, projects, subscriptions, or vault boundaries
- separate encryption and audit boundaries where practical

A development workload must not be able to read production secrets.

## 10.4 Separate Secrets by Consumer

Avoid sharing one database password across many services. Prefer a credential per consumer, such as `orders-service-db-user`, `billing-service-db-user`, or `reporting-service-readonly-user`.

This improves:

- revocation
- auditing
- ownership
- least privilege
- incident containment

---

# 11. Encryption and Key Management

Secrets should be encrypted:

- **at rest** while stored
- **in transit** while being retrieved

Secret managers usually integrate with a Key Management Service (KMS) or hardware-backed key infrastructure.

## 11.1 KMS vs Secret Manager

These services solve related but different problems.

| Service | Main responsibility |
|---|---|
| KMS | Protect and perform operations with cryptographic keys |
| Secret manager | Store and manage secret values and their lifecycle |

A secret manager may use a KMS key to encrypt stored secrets.

```mermaid
flowchart TD
    K[KMS master key] -->|Protects| D[Data encryption key]
    D -->|Encrypts| S[Secret value]
    I[Application identity] --> SM[Secret Manager]
    SM -->|Authorization check| S
```

## 11.2 Envelope Encryption

A common design is:

1. encrypt the secret using a data encryption key
2. encrypt that data key using a master key in KMS
3. store the encrypted secret and encrypted data key
4. decrypt only after an authorized request

Application developers usually use the managed service rather than implementing this themselves.

## 11.3 Do Not Invent Custom Encryption

Encrypting a `.env` file with a key stored beside it does not meaningfully protect the secret — if `config.env.enc` sits next to `config-decryption-key.txt`, an attacker who gets both files gets the secret.

Key storage, identity, authorization, auditing, and rotation must be designed together.

---

# 12. Secrets in Local Development

Local development should be convenient without encouraging unsafe production practices.

## 12.1 Recommended Local Pattern

Use a non-committed `.env` file containing development-only credentials.

```env
DATABASE_URL=postgresql://app_dev:local-password@localhost:5432/app
DJANGO_SECRET_KEY=local-only-random-value
```

Add it to `.gitignore`:

```gitignore
.env
.env.*
!.env.example
```

Commit a template without values:

```env
# .env.example
DATABASE_URL=
DJANGO_SECRET_KEY=
PAYMENT_API_KEY=
```

## 12.2 Safe Rules

- never place production secrets in a developer `.env`
- use fake or sandbox third-party credentials
- use separate local database accounts
- restrict file permissions where supported
- do not share `.env` files through chat or email
- do not include them in bug reports or support bundles
- scan staged changes before commits

## 12.3 Team Distribution

For teams, distribute development secrets through:

- an approved password manager
- a development vault
- a cloud secret manager with developer access
- a secure onboarding process

Do not use a shared document or repository file as the source of truth.

---

# 13. Secrets in Docker

## 13.1 Do Not Bake Secrets into Images

Unsafe Dockerfile:

```dockerfile
FROM python:3.13

ARG DATABASE_PASSWORD
ENV DATABASE_PASSWORD=$DATABASE_PASSWORD
```

Build arguments and environment values may leak through:

- image history
- build cache
- build logs
- registry access
- exported image layers

The image should be deployable to any environment without containing environment-specific secrets.

## 13.2 Runtime Environment Injection

```yaml
services:
  api:
    image: example/api:1.0
    environment:
      DATABASE_PASSWORD: ${DATABASE_PASSWORD}
```

This is simple, but the secret may be visible through runtime inspection depending on permissions and platform behavior.

## 13.3 Docker Compose Secret File

```yaml
services:
  api:
    image: example/api:1.0
    secrets:
      - database_password

secrets:
  database_password:
    file: ./secrets/database_password.txt
```

The application reads the value from `/run/secrets/database_password`. The source file must still be protected and must not be committed.

## 13.4 `_FILE` Convention

Some container images support a `_FILE` environment variable:

```yaml
services:
  db:
    image: postgres
    environment:
      POSTGRES_PASSWORD_FILE: /run/secrets/postgres_password
    secrets:
      - postgres_password
```

This tells the application to read the value from a mounted file instead of placing the secret directly in an environment variable.

---

# 14. Secrets in Kubernetes

A Kubernetes `Secret` object is intended for sensitive data, but it is not automatically secure merely because its kind is named `Secret`.

Base64 is encoding, not encryption.

```yaml
apiVersion: v1
kind: Secret
metadata:
  name: database-secret
type: Opaque
data:
  password: cGFzc3dvcmQ=
```

Anyone who can read the value can decode it: `echo 'cGFzc3dvcmQ=' | base64 --decode`

## 14.1 Kubernetes Security Controls

Use:

- encryption at rest for Secret data in `etcd`
- strict RBAC
- namespace isolation
- restricted `list` and `watch` permissions
- workload identity
- audit logging
- secret-store integrations
- read-only mounted volumes
- network policies where relevant

Be careful: permission to list Secrets effectively permits reading their values.

## 14.2 Environment Variable Injection

```yaml
env:
  - name: DATABASE_PASSWORD
    valueFrom:
      secretKeyRef:
        name: database-secret
        key: password
```

This is simple, but the application normally needs a restart to receive an updated environment value.

## 14.3 Volume Mount

```yaml
volumes:
  - name: database-secret-volume
    secret:
      secretName: database-secret

containers:
  - name: api
    volumeMounts:
      - name: database-secret-volume
        mountPath: /var/run/app-secrets
        readOnly: true
```

A file-based approach may allow secret updates to appear in the mounted volume, but the application must reload the value safely.

## 14.4 External Secret Store Pattern

```mermaid
flowchart LR
    CSM[Cloud Secret Manager or Vault] --> CSI[CSI Driver or External Secret Controller]
    CSI --> KS[Kubernetes Secret or Mounted Volume]
    KS --> POD[Application Pod]
```

This keeps the external secret manager as the authoritative source and reduces manual copying.

---

# 15. Secrets in CI/CD Pipelines

CI/CD systems often have broad access to source code, cloud deployments, registries, and production environments. Pipeline secrets are therefore high-value targets.

## 15.1 Common Risks

- printing secrets in logs
- using untrusted third-party actions or plugins
- exposing secrets to pull requests from forks
- storing cloud access keys as long-lived repository secrets
- passing secrets as command-line arguments
- uploading secret-containing files as artifacts
- sharing one credential across every repository
- running unreviewed code with production secrets

## 15.2 Prefer Workload Identity Federation

Instead of storing a permanent cloud access key in the CI/CD platform, use identity federation: `CI job -> short-lived OIDC token -> cloud IAM -> temporary deployment access`. This removes a long-lived cloud credential from the pipeline secret store.

## 15.3 Avoid Command-Line Exposure

Potentially unsafe: `deploy-tool --password "$PRODUCTION_PASSWORD"`

Command arguments may appear in process listings or logs.

Prefer:

- standard input when supported
- a temporary restricted file
- a provider SDK
- workload identity
- platform-native secret injection

## 15.4 Logging Rules

Pipeline code should:

- mask known secret values
- disable shell tracing around sensitive commands
- avoid `env`, `printenv`, and full configuration dumps
- delete temporary secret files
- prevent secret-containing artifacts from being uploaded
- use minimal token permissions

Masking is a backup control, not a guarantee. Transformed, encoded, split, or derived values may bypass masking.

---

# 16. Application Implementation Patterns

## 16.1 Central Configuration Object

Read and validate configuration in one place.

```python
from dataclasses import dataclass
import os

def required(name: str) -> str:
    value = os.getenv(name)
    if not value:
        raise RuntimeError(f"Missing required configuration: {name}")
    return value

@dataclass(frozen=True)
class Settings:
    database_url: str
    payment_api_key: str
    environment: str

    @classmethod
    def from_environment(cls) -> "Settings":
        return cls(
            database_url=required("DATABASE_URL"),
            payment_api_key=required("PAYMENT_API_KEY"),
            environment=os.getenv("APP_ENV", "development"),
        )
```

Benefits:

- consistent validation
- easier testing
- fewer scattered environment lookups
- controlled redaction
- clear startup failure

## 16.2 Redacted Representation

Do not allow settings objects to expose secrets accidentally.

```python
from dataclasses import dataclass, field

@dataclass
class DatabaseConfig:
    host: str
    username: str
    password: str = field(repr=False)
```

Now the password is excluded from the generated representation:

```python
DatabaseConfig(host="db", username="app", password="secret")
# DatabaseConfig(host='db', username='app')
```

## 16.3 Secret Manager Client with Cache

```python
import json
import time
from threading import Lock
from typing import Any

class CachedSecretProvider:
    def __init__(self, client: Any, ttl_seconds: int = 300) -> None:
        self.client = client
        self.ttl_seconds = ttl_seconds
        self._cache: dict[str, tuple[float, dict[str, str]]] = {}
        self._lock = Lock()

    def get_json_secret(self, secret_id: str) -> dict[str, str]:
        now = time.monotonic()

        with self._lock:
            cached = self._cache.get(secret_id)
            if cached and cached[0] > now:
                return cached[1]

            response = self.client.get_secret_value(SecretId=secret_id)
            value = json.loads(response["SecretString"])
            self._cache[secret_id] = (now + self.ttl_seconds, value)
            return value
```

A real implementation should additionally handle:

- retries with exponential backoff
- provider-specific exceptions
- credential refresh
- stale-cache behavior
- secret version changes
- metrics without values
- graceful shutdown

## 16.4 Fail Open vs Fail Closed

For authentication and encryption secrets, failing closed is normally correct: `secret unavailable -> reject protected operation`.

Using an old cached database password for a short controlled period may be acceptable if the application already has a valid connection. Silently switching to a default credential is not acceptable.

The correct failure policy depends on:

- secret purpose
- security impact
- availability requirements
- cache validity
- whether the old credential has been revoked

## 16.5 Keep Secrets in Memory Briefly

Once retrieved:

- do not write the secret to logs
- do not serialize it into traces
- do not return it in API responses
- do not place it in exception messages
- avoid unnecessary copies
- clear temporary files
- restrict access to the smallest component possible

Complete memory erasure is difficult in garbage-collected languages, so the practical goal is to minimize exposure and lifetime.

---

# 17. Logging, Monitoring, and Auditing

Secret management is incomplete without visibility.

## 17.1 What to Audit

Record:

- secret creation
- secret updates
- secret reads
- access denials
- policy changes
- deletion attempts
- rotation success and failure
- unusual access locations
- access by unexpected identities
- access outside normal deployment windows

## 17.2 What Not to Log

Never log:

- the secret value
- full authorization headers
- database URLs containing passwords
- private keys
- complete tokens
- decrypted configuration objects

Unsafe: `logger.info("Connecting with URL: %s", database_url)`

Safer:

```python
logger.info("Connecting to database host=%s database=%s", host, database_name)
```

## 17.3 Redaction

Create central redaction for fields such as:

```text
password
passwd
secret
token
authorization
api_key
private_key
cookie
session
```

Redaction helps, but naming variations and nested payloads mean developers must still avoid logging sensitive objects.

## 17.4 Useful Alerts

Alert on:

- sudden increases in secret reads
- production secrets read by development identities
- secret access from a new region or network
- repeated denied access
- disabled audit logging
- secrets approaching expiration
- failed automatic rotation
- broad policy grants
- deleted or scheduled-for-deletion secrets

---

# 18. Secret Leakage Response

Treat a committed or logged secret as compromised, even if the repository or log system is private.

## 18.1 Response Sequence

```mermaid
flowchart TD
    A[Secret exposure detected] --> B[Revoke or rotate immediately]
    B --> C[Identify affected systems and permissions]
    C --> D[Review audit logs for misuse]
    D --> E[Remove secret from current files and logs]
    E --> F[Clean repository history where necessary]
    F --> G[Deploy updated secret references]
    G --> H[Add controls to prevent recurrence]
```

## 18.2 Rotation Comes Before Cleanup

Removing the secret from Git does not invalidate copies that already exist.

Correct priority:

1. revoke or rotate
2. contain access
3. inspect for misuse
4. clean the repository or logs
5. improve prevention

## 18.3 Investigation Questions

Determine:

- when the secret was exposed
- who could access the location
- what systems the secret could access
- whether it was used unexpectedly
- whether the credential was shared
- whether derived credentials or sessions remain active
- whether customer or regulated data was reachable

## 18.4 Prevention After an Incident

Add:

- pre-commit secret scanning
- server-side repository scanning
- CI scanning
- protected branches
- shorter-lived credentials
- narrower permissions
- automatic rotation
- better logging redaction
- developer security guidance

---

# 19. Practical Architecture

Consider a Django or FastAPI service running in a cloud container platform.

## 19.1 Security Properties

- no secret is committed to Git
- the CI pipeline uses temporary cloud access
- the application uses workload identity
- IAM limits the application to specific secret paths
- the secret manager records access
- secrets are encrypted at rest and retrieved over TLS
- production and staging use separate secrets
- logs exclude sensitive values
- rotation can occur without changing source code

## 19.2 Example Secret Naming

```text
/prod/orders/database
/prod/orders/payment-provider
/prod/orders/webhook-signing-key

/staging/orders/database
/staging/orders/payment-provider
```

Names should reveal enough operational context but should not contain the secret value itself.

## 19.3 Ownership Metadata

Track metadata such as:

- owner team
- application
- environment
- purpose
- rotation policy
- expiration
- incident contact
- data classification

This avoids “orphaned” secrets that nobody knows how to rotate.

---

# 20. Best-Practice Checklist

## Storage

- [ ] No secrets are hardcoded in source code.
- [ ] No production secrets are committed to Git.
- [ ] Container images do not contain secrets.
- [ ] Production secrets are stored in an approved secret manager.
- [ ] Secret values are encrypted at rest and in transit.

## Access

- [ ] Applications use workload identity where possible.
- [ ] Access follows least privilege.
- [ ] Development cannot read production secrets.
- [ ] Each service has its own credentials.
- [ ] Human access to production secrets is limited and audited.

## Delivery

- [ ] Secrets are injected only at runtime.
- [ ] Mounted files have restrictive permissions.
- [ ] Environment variables are not dumped into logs.
- [ ] Debug endpoints, error reports, and support bundles are checked for accidental secret exposure.
- [ ] Applications fail safely when required secrets are missing.
- [ ] Temporary secret files are removed.

## Rotation

- [ ] Every secret has an owner.
- [ ] High-risk secrets have an automated rotation strategy.
- [ ] Applications can reload or refresh rotated values.
- [ ] Rotation updates the target system, every consuming application, and any caches — not only the value stored in the secret manager.
- [ ] Old versions are revoked after verification.
- [ ] Emergency rotation is documented and tested.

## CI/CD

- [ ] Pipelines use short-lived identity federation where possible.
- [ ] Pull requests from untrusted sources cannot read production secrets.
- [ ] Logs and artifacts are checked for secret exposure.
- [ ] Third-party actions and plugins are pinned and reviewed.
- [ ] Pipeline tokens use minimum permissions.

## Monitoring

- [ ] Secret reads and policy changes are audited.
- [ ] Rotation failures generate alerts.
- [ ] Unusual access patterns generate alerts.
- [ ] Logs redact sensitive fields.
- [ ] Secret scanning runs before and after code reaches the repository.

---

# Official References

- OWASP Secrets Management Cheat Sheet:  
  <https://cheatsheetseries.owasp.org/cheatsheets/Secrets_Management_Cheat_Sheet.html>

- The Twelve-Factor App — Config:  
  <https://12factor.net/config>

- AWS Secrets Manager best practices:  
  <https://docs.aws.amazon.com/secretsmanager/latest/userguide/best-practices.html>

- Google Cloud Secret Manager best practices:  
  <https://cloud.google.com/secret-manager/docs/best-practices>

- Microsoft Azure Key Vault security guidance:  
  <https://learn.microsoft.com/azure/key-vault/general/secure-key-vault>

- HashiCorp Vault documentation:  
  <https://developer.hashicorp.com/vault/docs>

- Kubernetes Secret good practices:  
  <https://kubernetes.io/docs/concepts/security/secrets-good-practices/>

- Docker Compose secrets:  
  <https://docs.docker.com/compose/how-tos/use-secrets/>
