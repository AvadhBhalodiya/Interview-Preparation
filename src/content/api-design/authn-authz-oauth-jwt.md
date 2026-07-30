---
title: "AuthN vs AuthZ"
group: "Security & Integration"
order: 6
---

# Authentication and Authorization in REST APIs

## AuthN vs AuthZ, OAuth 2.x, JWT, and API Keys

> **Topic:** API Design & REST  
> **Level:** Intermediate developer  
> **Purpose:** Build a practical mental model for designing and securing production APIs  
> **Standards note:** OAuth 2.0 remains the published framework. OAuth 2.1 was still an IETF draft as of July 2026, so current implementations should follow OAuth 2.0 together with the latest OAuth security best practices.

---

## Table of Contents

1. [The Big Picture](#1-the-big-picture)
2. [Authentication — AuthN](#2-authentication--authn)
3. [Authorization — AuthZ](#3-authorization--authz)
4. [AuthN vs AuthZ](#4-authn-vs-authz)
5. [OAuth 2.x](#5-oauth-2x)
   - [What OAuth Solves](#51-what-oauth-solves)
   - [OAuth Roles](#52-oauth-roles)
   - [Tokens and Scopes](#53-tokens-and-scopes)
   - [Authorization Code with PKCE](#54-authorization-code-with-pkce)
   - [Client Credentials](#55-client-credentials)
   - [Refresh Tokens](#56-refresh-tokens)
   - [OAuth and OpenID Connect](#57-oauth-and-openid-connect)
6. [JSON Web Tokens — JWT](#6-json-web-tokens--jwt)
   - [JWT Structure](#61-jwt-structure)
   - [Signing vs Encryption](#62-signing-vs-encryption)
   - [JWT Validation](#63-jwt-validation)
   - [JWT Revocation and Logout](#64-jwt-revocation-and-logout)
7. [API Keys](#7-api-keys)
8. [How These Concepts Work Together](#8-how-these-concepts-work-together)
9. [Comparison Tables](#9-comparison-tables)
10. [REST API Status Codes](#10-rest-api-status-codes)
11. [Practical Authorization Models](#11-practical-authorization-models)
12. [Secure API Architecture](#12-secure-api-architecture)
13. [Choosing the Right Approach](#13-choosing-the-right-approach)
14. [Production Best Practices](#14-production-best-practices)
15. [Final Mental Model](#15-final-mental-model)
16. [Official References](#16-official-references)

---

# 1. The Big Picture

API security usually answers two different questions:

```text
1. Who or what is making the request?   → Authentication
2. Is it allowed to perform this action? → Authorization
```

A request should normally pass through both checks:

```mermaid
flowchart LR
    A[Client Request] --> B[Authentication]
    B -->|Invalid identity| C[401 Unauthorized]
    B -->|Valid identity| D[Authorization]
    D -->|Not permitted| E[403 Forbidden]
    D -->|Permitted| F[Business Logic]
    F --> G[API Response]
```

A successful login does **not** automatically mean that the user can access every resource.

For example:

```text
Alice successfully logs in.
        ↓
Alice is authenticated.
        ↓
Alice requests DELETE /users/42.
        ↓
The API checks whether Alice has permission to delete user 42.
        ↓
Alice is not an administrator.
        ↓
Request is rejected with 403 Forbidden.
```

---

# 2. Authentication — AuthN

**Authentication**, commonly shortened to **AuthN**, verifies the identity of a user, application, service, or device.

It answers:

> **Who are you?**

Common authentication credentials include:

- Email and password
- One-time password
- Passkey
- Client certificate
- Session cookie
- Access token
- API key for identifying an API client

## 2.1 User authentication example

```http
POST /auth/login HTTP/1.1
Content-Type: application/json

{
  "email": "alice@example.com",
  "password": "correct-horse-battery-staple"
}
```

The authentication service verifies the credentials and may create a session or issue tokens.

```http
HTTP/1.1 200 OK
Content-Type: application/json

{
  "access_token": "eyJ...",
  "token_type": "Bearer",
  "expires_in": 900
}
```

The API should store passwords as slow, salted password hashes using a suitable password-hashing algorithm. Passwords must never be stored in plain text or with reversible encryption.

## 2.2 Service authentication example

A background billing service may authenticate itself to a payment API using:

- OAuth client credentials
- Mutual TLS
- A signed workload identity
- A carefully managed API key

Here, the identity is a **service**, not an end user.

## 2.3 Authentication result

After successful authentication, the application usually creates an authenticated principal:

```json
{
  "subject": "user-123",
  "authentication_method": "password+mfa",
  "tenant_id": "tenant-45"
}
```

This identity becomes the input for authorization.

---

# 3. Authorization — AuthZ

**Authorization**, commonly shortened to **AuthZ**, decides what an authenticated identity is allowed to do.

It answers:

> **What are you allowed to access or modify?**

Authorization decisions may depend on:

- Role
- Permission
- Scope
- Resource ownership
- Tenant
- Subscription plan
- Department
- Time
- Device or network
- Resource state
- Business rules

## 3.1 Simple role-based authorization

```text
Role: admin
Permissions:
- user:read
- user:create
- user:update
- user:delete
```

Endpoint check:

```python
if "user:delete" not in current_user.permissions:
    raise ForbiddenError()
```

## 3.2 Resource-level authorization

Checking only the role is often insufficient.

Consider:

```http
GET /invoices/INV-500
```

A customer may have the general `invoice:read` permission but should only access invoices belonging to their own organization.

```python
invoice = invoice_repository.get("INV-500")

if invoice.tenant_id != current_user.tenant_id:
    raise ForbiddenError()
```

This is commonly called **object-level** or **resource-level authorization**.

## 3.3 Authentication before authorization

Authorization requires a known principal in most systems:

```text
Credential
    ↓
Authentication
    ↓
Identity / Principal
    ↓
Authorization policy
    ↓
Allow or deny
```

Some public endpoints intentionally allow anonymous access, but that is still an authorization decision defined by policy.

---

# 4. AuthN vs AuthZ

| Area | Authentication — AuthN | Authorization — AuthZ |
|---|---|---|
| Main question | Who are you? | What may you do? |
| Input | Credentials | Identity, permissions, resource and context |
| Output | Verified or unverified identity | Allow or deny |
| Typical examples | Password, passkey, session, access token validation | Role, permission, scope, ownership or policy check |
| Usually happens | First | After authentication |
| REST failure | Usually `401 Unauthorized` | Usually `403 Forbidden` |
| Can change during a session? | Less frequently | Frequently, as permissions and resource state change |
| Example | Alice is user `123` | Alice may update her own profile |

> Despite its name, HTTP `401 Unauthorized` normally means that valid authentication credentials are missing or invalid. `403 Forbidden` means the server understood the identity but refuses the requested operation.

---

# 5. OAuth 2.x

OAuth is an **authorization framework** for delegated access.

It allows one application to receive limited access to another system without obtaining the user's password.

## 5.1 What OAuth Solves

Suppose a reporting application needs read-only access to a user's cloud files.

### Unsafe approach

```text
User gives cloud password to reporting application.
```

Problems:

- The application receives the user's full credentials.
- Access is usually broader than required.
- The application may retain access after it is no longer trusted.
- Changing the password breaks all connected applications.

### OAuth approach

```text
User authenticates directly with the cloud provider.
        ↓
User approves limited access.
        ↓
Reporting application receives an access token.
        ↓
Token permits only the approved operations.
```

OAuth supports:

- Delegated access
- Limited scopes
- Short-lived access tokens
- Revocation
- Separate client and user identities
- Access without sharing the user's password

## 5.2 OAuth Roles

OAuth defines four important roles.

| Role | Meaning | Example |
|---|---|---|
| Resource owner | Entity that can grant access | The user |
| Client | Application requesting access | Reporting web application |
| Authorization server | Authenticates, obtains consent and issues tokens | Identity provider |
| Resource server | API that accepts the access token | Cloud files API |

```mermaid
flowchart LR
    U[Resource Owner / User]
    C[Client Application]
    AS[Authorization Server]
    RS[Resource Server / API]

    U -->|Uses| C
    C -->|Authorization request| AS
    AS -->|User login and consent| U
    AS -->|Access token| C
    C -->|Bearer access token| RS
    RS -->|Protected resource| C
```

In a small application, the authorization server and resource server may be deployed together. Conceptually, they still perform different responsibilities.

## 5.3 Tokens and Scopes

### Access token

An access token is presented to a resource server to access a protected API.

```http
GET /v1/orders HTTP/1.1
Host: api.example.com
Authorization: Bearer ACCESS_TOKEN
```

An OAuth access token may be:

- An opaque random value
- A JWT
- Another format understood by the authorization and resource servers

OAuth does **not** require every access token to be a JWT.

### Scope

A scope represents a permission category delegated to the client.

```text
orders:read
orders:write
profile:read
```

Example token request:

```text
scope=orders:read profile:read
```

A scope should represent a meaningful API capability. It should not be treated as the only authorization control.

For example, `orders:read` may allow a client to read orders, but the API must still check which tenant's orders the current user may access.

### Bearer token

Most OAuth access tokens are bearer tokens:

> Anyone who possesses the token can attempt to use it.

Therefore, bearer tokens must be protected in transit and storage. Always use HTTPS.

## 5.4 Authorization Code with PKCE

**Authorization Code with PKCE** is the recommended interactive flow for modern web, mobile, desktop, and browser-based applications.

PKCE stands for **Proof Key for Code Exchange**.

It protects an intercepted authorization code from being exchanged by an attacker.

### High-level flow

```mermaid
sequenceDiagram
    participant U as User
    participant C as Client
    participant AS as Authorization Server
    participant API as Resource API

    C->>C: Generate code_verifier
    C->>C: Create code_challenge
    C->>AS: Authorization request + code_challenge
    AS->>U: Authenticate user and request consent
    U->>AS: Approve
    AS->>C: Redirect with authorization code
    C->>AS: Code + original code_verifier
    AS->>AS: Verify PKCE challenge
    AS-->>C: Access token + optional refresh token
    C->>API: Request with access token
    API-->>C: Protected resource
```

### Step 1: Generate PKCE values

The client generates a high-entropy random value:

```text
code_verifier = random secret
```

It derives a challenge:

```text
code_challenge = BASE64URL(SHA256(code_verifier))
code_challenge_method = S256
```

### Step 2: Start authorization

```http
GET /authorize?
    response_type=code&
    client_id=web-client&
    redirect_uri=https%3A%2F%2Fapp.example.com%2Fcallback&
    scope=openid%20profile%20orders%3Aread&
    state=RANDOM_STATE&
    code_challenge=PKCE_CHALLENGE&
    code_challenge_method=S256
```

Important parameters:

| Parameter | Purpose |
|---|---|
| `response_type=code` | Requests an authorization code |
| `client_id` | Identifies the OAuth client |
| `redirect_uri` | Exact allowed callback location |
| `scope` | Requested access |
| `state` | Links request and callback; helps protect the redirect flow |
| `code_challenge` | PKCE challenge |
| `code_challenge_method=S256` | Uses SHA-256 |

### Step 3: Exchange the code

```http
POST /token HTTP/1.1
Content-Type: application/x-www-form-urlencoded

grant_type=authorization_code&
code=AUTHORIZATION_CODE&
redirect_uri=https%3A%2F%2Fapp.example.com%2Fcallback&
client_id=web-client&
code_verifier=ORIGINAL_CODE_VERIFIER
```

The authorization server issues an access token only if the verifier matches the original challenge.

### Why not implicit flow?

The implicit flow exposes tokens through browser redirects and lacks several protections available in the authorization code flow. Current OAuth security guidance recommends authorization code flow instead.

### Why not password grant?

The Resource Owner Password Credentials grant requires the client to directly collect the user's username and password. Current OAuth security guidance says it must not be used.

## 5.5 Client Credentials

The **Client Credentials** grant is used for machine-to-machine communication when no end user is involved.

Example:

```text
Invoice Worker
      ↓ authenticates as itself
Authorization Server
      ↓ issues service access token
Payments API
```

Token request:

```http
POST /oauth/token HTTP/1.1
Content-Type: application/x-www-form-urlencoded
Authorization: Basic BASE64_CLIENT_CREDENTIALS

grant_type=client_credentials&
scope=payments:write
```

Appropriate use cases:

- Internal microservice communication
- Scheduled jobs
- Backend integrations
- Server-to-server APIs

The token represents the client application or workload, not a user.

Do not use Client Credentials when an operation must be audited or authorized as a particular human user unless the architecture also carries a trusted user delegation context.

## 5.6 Refresh Tokens

Access tokens should normally be short-lived. A refresh token allows a client to request a new access token without asking the user to log in again.

```mermaid
flowchart LR
    A[Access Token Expires] --> B[Client Sends Refresh Token]
    B --> C[Authorization Server Validates It]
    C --> D[New Access Token]
    C --> E[Optional Rotated Refresh Token]
```

Request:

```http
POST /oauth/token HTTP/1.1
Content-Type: application/x-www-form-urlencoded

grant_type=refresh_token&
refresh_token=REFRESH_TOKEN&
client_id=web-client
```

Important controls:

- Store refresh tokens more securely than access tokens.
- Use refresh-token rotation where appropriate.
- Detect reuse of an already rotated refresh token.
- Revoke the token family after suspected theft.
- Bind refresh tokens to the client and authorized scope.
- Do not send refresh tokens to resource APIs.
- Give refresh tokens an absolute lifetime or inactivity timeout.

## 5.7 OAuth and OpenID Connect

OAuth primarily answers:

> May this client access this protected resource?

It does not, by itself, define a complete user-login protocol.

**OpenID Connect — OIDC** adds an identity layer on top of OAuth 2.0.

OIDC introduces an **ID token**, which tells the client about the authenticated user and authentication event.

| Token | Intended consumer | Main purpose |
|---|---|---|
| Access token | Resource server / API | Authorize API access |
| ID token | OAuth/OIDC client | Communicate authentication result and identity claims |
| Refresh token | Authorization server | Obtain new access tokens |

Important rule:

```text
ID token → consumed by the client
Access token → sent to the API
```

Do not send an ID token as a replacement for an access token unless a specific API contract explicitly defines such behavior.

A typical OIDC request includes:

```text
scope=openid profile email
```

The `openid` scope activates OpenID Connect behavior.

---

# 6. JSON Web Tokens — JWT

A JSON Web Token is a compact, URL-safe format for carrying claims between parties.

JWT is a **token format**, not an authentication or authorization protocol.

JWT can be used in:

- OAuth access tokens
- OpenID Connect ID tokens
- Service assertions
- One-time action links
- Internal identity propagation

## 6.1 JWT Structure

A commonly used signed JWT in JWS compact form contains three Base64URL-encoded parts:

```text
HEADER.PAYLOAD.SIGNATURE
```

Example:

```text
eyJhbGciOiJSUzI1NiIsImtpZCI6ImtleS0yMDI2In0
.
eyJzdWIiOiJ1c2VyLTEyMyIsImF1ZCI6Im9yZGVycy1hcGkiLCJleHAiOjE3NjAwMDAwMDB9
.
SIGNATURE
```

### Header

```json
{
  "alg": "RS256",
  "typ": "JWT",
  "kid": "key-2026-07"
}
```

| Claim | Meaning |
|---|---|
| `alg` | Signing algorithm |
| `typ` | Token type hint |
| `kid` | Identifier of the signing key |

### Payload

```json
{
  "iss": "https://identity.example.com",
  "sub": "user-123",
  "aud": "orders-api",
  "scope": "orders:read orders:write",
  "tenant_id": "tenant-45",
  "iat": 1785410000,
  "nbf": 1785410000,
  "exp": 1785410900,
  "jti": "token-7f9a"
}
```

Common registered claims:

| Claim | Meaning |
|---|---|
| `iss` | Issuer |
| `sub` | Subject |
| `aud` | Intended audience |
| `exp` | Expiration time |
| `nbf` | Not valid before |
| `iat` | Issued at |
| `jti` | Unique token identifier |

Custom claims may include tenant, roles, permissions, or session information. Keep them small and avoid sensitive personal data.

### Signature

The issuer signs:

```text
Base64URL(header) + "." + Base64URL(payload)
```

The API validates the signature using a trusted secret or public key.

## 6.2 Signing vs Encryption

A signed JWT is generally **readable but tamper-evident**.

Anyone who obtains the token can Base64URL-decode its header and payload.

```text
Signed JWT:
- Payload is readable
- Modification invalidates the signature
- Data is not confidential
```

Encryption is a separate operation, commonly represented using JWE.

Do not put the following in a normal signed JWT:

- Passwords
- API secrets
- Private keys
- Credit card data
- Unnecessary sensitive personal information

### Symmetric signing

Example: `HS256`

```text
Issuer and verifier share the same secret.
```

Benefits:

- Simple
- Fast

Trade-off:

- Every verifier that knows the secret could also create valid tokens.

### Asymmetric signing

Examples: `RS256`, `PS256`, `ES256`, `EdDSA`

```text
Issuer signs with private key.
APIs verify with public key.
```

Benefits:

- Resource servers do not receive the private signing key.
- Better separation between issuer and verifier.
- Easier distribution through a JSON Web Key Set — JWKS.
- Suitable for multiple APIs and services.

## 6.3 JWT Validation

Decoding a JWT is not validation.

A resource server should validate all relevant security properties:

```text
1. Parse the token safely.
2. Allow only expected algorithms.
3. Select a trusted verification key.
4. Verify the signature.
5. Validate issuer.
6. Validate audience.
7. Validate expiration and not-before time.
8. Validate token type or profile.
9. Apply scope, permission and resource checks.
```

Conceptual Python example:

```python
from jwt import decode
from jwt.exceptions import InvalidTokenError

EXPECTED_ISSUER = "https://identity.example.com"
EXPECTED_AUDIENCE = "orders-api"
ALLOWED_ALGORITHMS = ["RS256"]

def validate_access_token(token: str, public_key: str) -> dict:
    try:
        claims = decode(
            token,
            public_key,
            algorithms=ALLOWED_ALGORITHMS,
            issuer=EXPECTED_ISSUER,
            audience=EXPECTED_AUDIENCE,
            options={
                "require": ["exp", "iss", "sub", "aud"],
            },
        )
    except InvalidTokenError as exc:
        raise AuthenticationError("Invalid access token") from exc

    return claims
```

The exact library API varies, but the validation responsibilities remain the same.

### Algorithm allowlist

Never accept an algorithm merely because it appears in the untrusted token header.

```python
# Unsafe idea
algorithm = untrusted_header["alg"]
verify(token, algorithm=algorithm)
```

Use a server-side allowlist and a key configuration associated with the trusted issuer.

### Issuer validation

The API should accept tokens only from the expected issuer:

```text
iss = https://identity.example.com
```

Without issuer validation, a correctly signed token from another trusted-but-unrelated system might be accepted incorrectly.

### Audience validation

The audience restricts where the token is intended to be used:

```text
aud = orders-api
```

An access token created for `billing-api` should not automatically work against `orders-api`.

### Expiration validation

Reject tokens after `exp`.

Allow only a small, deliberate clock-skew tolerance.

### Key rotation

The issuer can publish public keys through JWKS.

```text
Authorization Server
    └── /.well-known/... metadata
          └── jwks_uri
                ├── current public key
                └── previous public key during rotation
```

A resource server should:

- Cache trusted keys.
- Refresh keys when an unknown `kid` is encountered.
- Enforce issuer and algorithm restrictions.
- Handle rotation without disabling signature verification.
- Avoid using arbitrary URLs supplied inside the token as key sources.

## 6.4 JWT Revocation and Logout

JWT access tokens are commonly validated locally, so an API may not contact the authorization server for every request.

Benefit:

```text
Fast, distributed validation
```

Trade-off:

```text
A token may remain usable until expiry even after logout or permission changes.
```

Common strategies:

### Short-lived access tokens

Issue access tokens for a short duration, such as several minutes, based on the system's risk profile.

### Refresh-token revocation

Revoke the refresh token so no new access token can be issued.

This does not automatically invalidate an already issued self-contained access token.

### Denylist

Store revoked token IDs or session IDs.

```text
jti → revoked until token expiration
```

This gives quicker revocation but adds shared state and a lookup.

### Token introspection

Use opaque tokens or introspection when the resource server must obtain the token's current active state from the authorization server.

### Session or authorization version

Include a version identifier and compare it with current server-side state for sensitive operations.

### Important logout expectation

Logout usually means:

- End the local application session.
- Delete or invalidate browser cookies.
- Revoke refresh tokens where supported.
- Prevent new access tokens.
- Allow existing short-lived access tokens to expire, unless immediate revocation is required.

---

# 7. API Keys

An API key is a secret value used to identify and authenticate an API client, application, project, or integration.

Example:

```http
GET /v1/weather?city=Ahmedabad HTTP/1.1
Host: api.example.com
X-API-Key: sk_live_7Sg...
```

A provider may alternatively use:

```http
Authorization: ApiKey sk_live_7Sg...
```

Use the header format defined by the API contract.

## 7.1 Typical use cases

API keys are suitable for:

- Developer-facing APIs
- Server-to-server integrations with simple trust requirements
- Usage tracking
- Quota enforcement
- Rate limiting
- Identifying the calling project
- Low-risk public-data APIs

API keys should generally identify an **API client**, not authenticate a human user.

## 7.2 Characteristics

```text
API key
├── Usually long-lived
├── Usually represents an application
├── Often has simple permissions
├── Easy to issue and use
└── Difficult to protect in untrusted clients
```

A static API key is a bearer credential. Anyone who obtains it may be able to use it.

## 7.3 Secure API-key design

### Generate strong random keys

Use a cryptographically secure random generator.

Example visible format:

```text
ak_live_<public-id>_<secret>
```

The public identifier helps the server locate the record without storing the full secret as searchable plain text.

### Store a hash

Where possible, show the secret only once and store a secure hash rather than the raw key.

```text
Client receives:
ak_live_abc123_SUPER_SECRET_VALUE

Database stores:
key_id = abc123
secret_hash = HASH(SUPER_SECRET_VALUE)
```

For high-entropy API keys, a keyed hash or suitable cryptographic hash design can support efficient verification. The exact construction should be reviewed as part of the threat model.

### Use least privilege

Attach permissions such as:

```json
{
  "name": "analytics-importer",
  "scopes": ["events:write"],
  "environment": "production"
}
```

### Support lifecycle management

Provide:

- Creation
- Naming
- Last-used timestamp
- Expiration
- Rotation
- Overlapping rotation window
- Revocation
- Audit trail

### Keep keys out of URLs

Avoid:

```http
GET /orders?api_key=SECRET
```

URLs commonly appear in:

- Browser history
- Reverse-proxy logs
- Analytics tools
- Monitoring systems
- Referrer headers

Use an HTTP header instead.

### Do not embed server secrets in public applications

Keys placed in frontend JavaScript, mobile apps, or desktop binaries should be treated as recoverable by users or attackers.

For public clients, use:

- Authorization Code with PKCE
- A backend-for-frontend
- Restricted, non-secret publishable identifiers
- Provider-supported platform restrictions as defense in depth

### Apply additional controls

API keys should be combined with:

- HTTPS
- Rate limits
- Quotas
- IP or network restrictions where appropriate
- Origin or application restrictions where supported
- Scope restrictions
- Monitoring
- Anomaly detection
- Rapid revocation

Do not rely only on an API key for sensitive, critical, or high-value user resources.

---

# 8. How These Concepts Work Together

OAuth, JWT and API keys are not interchangeable categories.

```text
OAuth 2.x
└── Authorization framework
    └── Issues access tokens
        ├── Opaque token
        └── JWT access token

OpenID Connect
└── Authentication layer on OAuth
    └── Issues ID token, normally a JWT

JWT
└── Token format
    ├── Access token
    ├── ID token
    └── Other signed assertion

API key
└── Client credential
    └── Usually identifies an application or integration
```

A production API may use several mechanisms together.

Example:

```text
Mobile user
    └── OIDC Authorization Code + PKCE
        └── JWT access token
            └── Orders API

Partner backend
    └── OAuth Client Credentials
        └── Opaque access token
            └── Partner API

Internal low-risk integration
    └── Scoped API key
        └── Reporting API
```

---

# 9. Comparison Tables

## 9.1 OAuth vs JWT vs API key

| Area | OAuth 2.x | JWT | API key |
|---|---|---|---|
| Category | Authorization framework | Token format | Client credential |
| Main purpose | Delegate limited API access | Carry signed or encrypted claims | Identify/authenticate an API client |
| Represents | Client, user delegation or workload | Whatever its claims define | Usually application/project |
| User login | Use OIDC on top | Can carry an OIDC ID token | Not suitable for user login |
| Standard flows | Yes | No | Usually provider-specific |
| Expiration | Defined by token policy | Can use `exp` | Often long-lived unless designed otherwise |
| Revocation | Refresh-token revocation, introspection and provider mechanisms | Difficult if fully stateless | Usually easy through server-side key record |
| Fine-grained access | Scopes plus API authorization | Claims plus API authorization | Provider-defined scopes/permissions |
| Best fit | Third-party access, SSO/OIDC and service access | Distributed claim verification | Simple application integrations |

## 9.2 Session cookie vs bearer token

| Area | Session cookie | Bearer access token |
|---|---|---|
| Common use | Browser application | APIs, mobile, service integrations |
| State | Usually server-side session | Often self-contained or remotely introspected |
| Browser automatically sends it | Yes | Not when kept outside cookies |
| Main browser threat | CSRF when cookie is automatically sent | Token theft and XSS exposure |
| Revocation | Usually immediate by deleting server session | Depends on token design |
| Protection | `Secure`, `HttpOnly`, `SameSite`, CSRF controls | HTTPS, short lifetime, secure storage, audience/scope validation |

Cookies and JWTs are not opposites. A cookie is a browser transport/storage mechanism, while JWT is a token format. A JWT may technically be placed in a cookie, although the resulting security model must be designed carefully.

## 9.3 Opaque token vs JWT access token

| Area | Opaque access token | JWT access token |
|---|---|---|
| Token contents visible to client | No meaningful data | Claims are usually readable |
| API validation | Introspection or shared state | Usually local signature validation |
| Immediate revocation | Easier | Requires additional strategy |
| API dependency per request | May require authorization-server call or cache | Usually no authorization-server call |
| Claim freshness | Can be current | Snapshot taken at issue time |
| Network overhead | Introspection may add latency | Larger token sent on each request |
| Good fit | Central control and rapid revocation | Distributed APIs and lower validation latency |

---

# 10. REST API Status Codes

## 10.1 `401 Unauthorized`

Use when authentication credentials are:

- Missing
- Invalid
- Expired
- Malformed
- Not acceptable for this API

Example:

```http
HTTP/1.1 401 Unauthorized
WWW-Authenticate: Bearer error="invalid_token"
Content-Type: application/problem+json

{
  "type": "https://api.example.com/problems/invalid-token",
  "title": "Authentication required",
  "status": 401,
  "detail": "The access token is missing, invalid, or expired."
}
```

## 10.2 `403 Forbidden`

Use when the identity is authenticated but lacks permission.

```http
HTTP/1.1 403 Forbidden
Content-Type: application/problem+json

{
  "type": "https://api.example.com/problems/insufficient-permission",
  "title": "Access denied",
  "status": 403,
  "detail": "The current identity cannot delete this invoice."
}
```

## 10.3 `404 Not Found`

For some sensitive resources, returning `404` instead of `403` can avoid revealing that the resource exists.

This should be a deliberate, consistent policy—not a replacement for authorization checks.

## 10.4 `429 Too Many Requests`

Use when a client exceeds rate limits.

```http
HTTP/1.1 429 Too Many Requests
Retry-After: 60
```

Authentication and rate limiting are separate controls. A valid credential does not imply unlimited usage.

---

# 11. Practical Authorization Models

## 11.1 Role-Based Access Control — RBAC

Permissions are grouped into roles.

```text
Admin
├── users:read
├── users:write
└── users:delete

Support Agent
├── users:read
└── tickets:write
```

Best for:

- Stable organizational roles
- Administration panels
- Systems with understandable job functions

Limitation:

- Roles can multiply when every exception becomes a new role.

## 11.2 Attribute-Based Access Control — ABAC

Policies use attributes of the subject, resource, action and environment.

```text
Allow invoice approval when:
- user.department == "finance"
- invoice.amount <= user.approval_limit
- invoice.tenant_id == user.tenant_id
- request.time is within business policy
```

Best for:

- Fine-grained enterprise rules
- Multi-tenant systems
- Context-aware decisions

## 11.3 Relationship-Based Access Control — ReBAC

Authorization depends on relationships.

```text
User ──member_of──> Team
Team ──owns────────> Project
Project ──contains─> Document
```

A user may read a document because they are a member of the team that owns its project.

Best for:

- Collaboration products
- Hierarchical organizations
- Sharing and ownership graphs

## 11.4 Scope is not complete authorization

OAuth scope is usually a coarse capability granted to a client.

```text
scope: invoices:read
```

The API must still evaluate:

```text
- Which user?
- Which tenant?
- Which invoice?
- Is the invoice visible to this user?
- Is the operation allowed in its current state?
```

A safe decision can be viewed as:

```text
Allow =
    valid_identity
    AND valid_token
    AND required_scope
    AND tenant_match
    AND resource_permission
    AND business_rule
```

---

# 12. Secure API Architecture

A clean architecture separates concerns.

```mermaid
flowchart LR
    C[Client] --> G[API Gateway]
    G --> A[Authentication Middleware]
    A --> P[Authorization Policy]
    P --> S[Application Service]
    S --> R[Repository]
    R --> D[(Database)]

    A --> I[Identity Provider]
    P --> E[Policy Data / Permission Store]
```

## 12.1 Authentication middleware

Responsibilities:

- Extract credential
- Validate token or session
- Build authenticated principal
- Reject invalid credentials
- Attach identity to request context

It should not contain endpoint-specific business authorization.

## 12.2 Authorization policy layer

Responsibilities:

- Evaluate scopes and permissions
- Enforce tenant boundaries
- Check resource ownership
- Apply business rules
- Produce consistent allow/deny decisions

## 12.3 Application service

The service should enforce authorization close to the operation, especially when multiple entry points can call the same business logic.

Example:

```python
def cancel_order(order_id: str, actor: Principal) -> Order:
    order = order_repository.get(order_id)

    authorization.require(
        actor=actor,
        action="order:cancel",
        resource=order,
    )

    if order.status not in {"pending", "confirmed"}:
        raise InvalidStateError("Order cannot be cancelled")

    return order.cancel()
```

Do not rely exclusively on hiding a button in the frontend. The API must enforce the rule.

## 12.4 Multi-tenant APIs

Every data-access path should preserve tenant isolation.

```python
# Better than fetching globally and hoping every caller checks later
order = order_repository.get_for_tenant(
    order_id=order_id,
    tenant_id=current_user.tenant_id,
)
```

Where practical, tenant constraints should be applied at multiple layers:

- Token or session context
- Authorization policy
- Repository queries
- Database row-level controls
- Audit logging

---

# 13. Choosing the Right Approach

## 13.1 First-party browser application

Recommended patterns:

```text
Option A: Server-managed session cookie
Option B: OIDC Authorization Code + PKCE with a backend-for-frontend
```

Prefer secure, `HttpOnly` cookies for browser sessions when the backend can manage the session. Add CSRF protections when cookies are automatically attached to requests.

Avoid exposing long-lived tokens to browser JavaScript.

## 13.2 Mobile or desktop application

Use:

```text
OIDC / OAuth Authorization Code + PKCE
```

Public clients cannot safely keep a permanent client secret inside distributed application binaries.

Use the system browser or the platform's secure authorization user-agent pattern rather than embedding a password form.

## 13.3 Third-party application accessing user data

Use:

```text
OAuth Authorization Code + PKCE
+ explicit scopes
+ consent
+ short-lived access token
+ controlled refresh-token lifecycle
```

## 13.4 Backend service to backend service

Use one of:

```text
OAuth Client Credentials
Workload identity
Mutual TLS
Signed client assertion
```

A scoped API key can be acceptable for simpler or lower-risk integrations, provided it has strong lifecycle, storage, monitoring and rotation controls.

## 13.5 Public or low-risk developer API

A restricted API key may be sufficient for:

- Project identification
- Rate limiting
- Quota tracking
- Billing attribution

Do not treat it as strong user authentication.

## 13.6 High-security operation

For financial, administrative or destructive operations, combine controls:

```text
Strong user authentication
+ MFA or step-up authentication
+ short-lived audience-restricted token
+ fine-grained authorization
+ replay protection where required
+ audit logging
+ anomaly detection
```

---

# 14. Production Best Practices

## 14.1 Credential handling

- Use HTTPS for every authenticated endpoint.
- Never log passwords, access tokens, refresh tokens or complete API keys.
- Redact credentials from application, proxy and tracing logs.
- Store server-side secrets in a dedicated secrets manager.
- Rotate signing keys and API credentials.
- Separate development, staging and production credentials.
- Give each integration its own credential.
- Support revocation without requiring a deployment.

## 14.2 Access-token design

- Keep access tokens short-lived.
- Restrict their audience.
- Grant the minimum required scope.
- Avoid large or sensitive JWT claims.
- Do not use access tokens intended for one API against another.
- Do not assume JWT claims remain current forever.
- Use proof-of-possession mechanisms for higher-risk environments when justified.

## 14.3 OAuth configuration

- Use Authorization Code with PKCE for interactive clients.
- Use the `S256` PKCE challenge method.
- Register and strictly match redirect URIs.
- Protect the authorization response using appropriate state and protocol controls.
- Do not use the implicit grant.
- Do not use the Resource Owner Password Credentials grant.
- Protect client secrets only in confidential clients.
- Rotate refresh tokens where appropriate.
- Restrict scopes and refresh-token lifetime.
- Use OIDC when the client needs user authentication.

## 14.4 JWT validation

- Pin expected algorithms.
- Verify the signature.
- Validate `iss`, `aud`, `exp` and any required token-type rules.
- Treat token headers and claims as untrusted until validation succeeds.
- Obtain keys only from trusted configuration or trusted issuer metadata.
- Cache JWKS carefully and support key rotation.
- Keep different token kinds mutually exclusive through issuer, audience, type and validation rules.
- Do not use simple Base64 decoding as authentication.

## 14.5 API-key controls

- Generate high-entropy keys.
- Show the full secret only when created.
- Store a hash where practical.
- Put keys in headers, not URLs.
- Assign scopes, environment and owner.
- Add expiration, rotation and revocation.
- Record last-used time and source.
- Apply rate limits and quotas.
- Never ship a privileged secret in frontend code.
- Do not use API keys as human-user authentication.

## 14.6 Authorization controls

- Deny by default.
- Check permissions on every protected operation.
- Check object ownership and tenant boundaries.
- Keep authorization logic centralized enough to remain consistent.
- Enforce important rules in the backend even if the UI hides actions.
- Re-evaluate authorization for sensitive operations.
- Audit security-sensitive allow and deny events.
- Test horizontal access: one user trying another user's resource.
- Test vertical access: a normal user trying an administrator operation.

## 14.7 Logging and observability

Log useful security context without logging secrets:

```json
{
  "event": "authorization_denied",
  "request_id": "req-123",
  "subject": "user-123",
  "client_id": "web-client",
  "tenant_id": "tenant-45",
  "action": "invoice:delete",
  "resource_id": "INV-500",
  "reason": "missing_permission"
}
```

Useful events include:

- Authentication success and failure
- Token validation failure reason category
- Permission denial
- API-key creation, rotation and revocation
- Refresh-token reuse detection
- Unusual geography, device or request volume
- Administrative permission changes

Do not return sensitive internal validation details to attackers. Detailed reasons belong in protected logs.

---

# 15. Final Mental Model

Remember these four lines:

```text
AuthN      = Verify identity.
AuthZ      = Decide allowed actions.
OAuth 2.x  = Framework for delegated authorization.
JWT        = Format for carrying claims.
API key    = Credential that usually identifies an API client.
OIDC       = Authentication layer built on OAuth 2.0.
```

A secure REST request typically follows this path:

```mermaid
flowchart TD
    A[Receive HTTPS Request]
    B[Extract Credential]
    C[Validate Session, Token or API Key]
    D[Build Principal]
    E[Check Scope / Permission]
    F[Check Tenant and Resource Access]
    G[Apply Business Rules]
    H[Execute Operation]
    I[Audit Result]

    A --> B --> C
    C -->|Invalid| X[401]
    C -->|Valid| D --> E
    E -->|Denied| Y[403]
    E -->|Allowed| F
    F -->|Denied| Y
    F -->|Allowed| G
    G -->|Denied| Y
    G -->|Allowed| H --> I
```

The most important design principle is:

> Authentication establishes identity, but authorization must still be enforced for every protected resource and action.

---

# 16. Official References

The following sources define or provide current guidance for the concepts covered in this guide:

1. **RFC 6749 — The OAuth 2.0 Authorization Framework**  
   https://www.rfc-editor.org/info/rfc6749/

2. **RFC 9700 — Best Current Practice for OAuth 2.0 Security**  
   https://www.rfc-editor.org/info/rfc9700/

3. **OAuth 2.1 Authorization Framework — IETF Working Draft**  
   https://datatracker.ietf.org/doc/draft-ietf-oauth-v2-1/

4. **RFC 6750 — OAuth 2.0 Bearer Token Usage**  
   https://www.rfc-editor.org/info/rfc6750/

5. **RFC 7636 — Proof Key for Code Exchange by OAuth Public Clients**  
   https://www.rfc-editor.org/info/rfc7636/

6. **RFC 7009 — OAuth 2.0 Token Revocation**  
   https://www.rfc-editor.org/info/rfc7009/

7. **RFC 7662 — OAuth 2.0 Token Introspection**  
   https://www.rfc-editor.org/info/rfc7662/

8. **OpenID Connect Core 1.0**  
   https://openid.net/specs/openid-connect-core-1_0.html

9. **RFC 7519 — JSON Web Token**  
   https://www.rfc-editor.org/info/rfc7519/

10. **RFC 8725 — JSON Web Token Best Current Practices**  
    https://www.rfc-editor.org/info/rfc8725/

11. **RFC 9068 — JWT Profile for OAuth 2.0 Access Tokens**  
    https://www.rfc-editor.org/info/rfc9068/

12. **OWASP REST Security Cheat Sheet**  
    https://cheatsheetseries.owasp.org/cheatsheets/REST_Security_Cheat_Sheet.html

13. **OWASP API Security — Broken Authentication**  
    https://owasp.org/API-Security/editions/2023/en/0xa2-broken-authentication/

---

**End of guide**
