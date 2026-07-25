---
title: "AuthN vs AuthZ"
group: "Security & Integration"
order: 6
---

# AuthN vs AuthZ, OAuth2, JWT, API Keys

> Authentication proves who you are (fail it and you get a 401). Authorization decides what you may do (fail it and you get a 403) - built in practice from API keys for server-to-server, OAuth 2.1 with PKCE for delegated user access, and JWTs as stateless signed tokens, always over HTTPS.

## What it is
**Authentication (AuthN)** and **authorization (AuthZ)** are two steps people say in one breath. AuthN establishes identity - you log in or present a key. AuthZ is the decision that happens *after*: given we know who you are, may you touch this resource? You always **authenticate first, then authorize**.

The whole topic hangs on that split, and half the bugs here come from swapping the two status codes:

| Aspect | **AuthN** - authentication | **AuthZ** - authorization |
| --- | --- | --- |
| Asks | **"Who are you?"** | **"What may you do?"** |
| Establishes | **Identity** (login, key, token) | **Permissions** (scopes, roles) |
| Order | Runs **first** | Runs **after** AuthN |
| Failure code | **401** + `WWW-Authenticate` | **403** Forbidden |
| Re-auth helps? | **Yes**, prove identity | **No**, already known and still barred |

Per RFC 9110 a **401** means "I can't tell who you are," and the server MUST send a `WWW-Authenticate` header telling the client how to authenticate. A **403** means "I know exactly who you are, and you still can't have this," so re-authenticating changes nothing and you must not prompt for login. 401 is misnamed: read it as "Unauthenticated." The mechanisms below all serve one or both steps: API keys and OAuth for access, OIDC for login, JWT as the token format.

> [!KEY] **AuthN is the bouncer checking your ID at the door. AuthZ is the wristband that decides which rooms you may enter.** You always clear the first before the second ever runs.

## Key points
- **API keys** are a long-lived shared secret that names a *caller* - an app or project, never a person. Best for server-to-server. Treat one like a password: send it in a header (not the query string, where it lands in logs and `Referer`), hash it at rest, give it a recognizable prefix so leak scanners catch it in a pushed repo, and rotate on a schedule. It carries no real authorization beyond "valid or not."
- **OAuth 2.1** is delegation: a client gets a scoped, short-lived access token to act on a user's behalf without ever seeing the password. Think valet key, not house key. It folds a decade of security guidance into the baseline - **PKCE (S256) is mandatory on every authorization-code flow**, the **implicit and password (ROPC) grants are gone**, redirect URIs match by **exact string**, and bearer tokens are banned from URL query strings.
- OAuth names four roles. Keep them straight or the flow reads as noise:

| Role | Who it is |
| --- | --- |
| **Resource owner** | The **user** who owns the data |
| **Client** | The **app** requesting access |
| **Authorization server** | Authenticates the user and **issues tokens** |
| **Resource server** | The **API** that holds data and **validates tokens** |

- **Authorization code + PKCE** is the one flow to know cold. The client mints a random `code_verifier` and hashes it into a `code_challenge` (`S256`). The challenge rides the redirect while the secret verifier never does, so a `code` stolen in transit is useless without it:
  1. Client to authorization server: `code_challenge` plus `code_challenge_method=S256`.
  2. User logs in and consents. The server redirects back with a one-time `code`.
  3. Client to token endpoint: the `code` plus the original `code_verifier`.
  4. Server re-hashes the verifier, compares it to the challenge, and returns the access token (plus refresh).
- **OIDC** exists because OAuth alone is authorization, not login. It adds an `id_token` (itself a JWT) that answers "who signed in." The `id_token` is for your **client**, the access token is for the **API** - crossing them is the classic "OAuth is not authentication" bug.
- **JWT** is a signed, self-contained token: `header.payload.signature`, each part base64url. The claims (`sub`, `exp`, `aud`, `iss`, `scope`) ride inside, so a resource server verifies the signature with a public key and skips the session lookup. That statelessness is the whole appeal and the whole problem - there is no server-side handle to flip, so a leaked token is good until `exp`.

> [!TIP] In a browser, keep the short-lived access token in memory and the refresh token in an httpOnly, Secure, SameSite cookie. Injected scripts cannot read either, and `SameSite` curbs CSRF.

- **Session vs token** is the choice underneath it all. Sessions are stateful and revoke instantly, tokens are stateless and scale without a shared store:

| Dimension | **Server session (cookie)** | **JWT (bearer token)** |
| --- | --- | --- |
| State | **Stateful**, server stores the session | **Stateless**, data lives in the token |
| Revocation | **Instant**, drop the record | **Hard**, valid until `exp` |
| Scaling | Needs a **shared store** (Redis) | **No lookup**, verify the signature |
| Best for | **One first-party app** | **Many services**, one issuer |

## Example
Sent as `Authorization: Bearer <token>` over HTTPS, always. The three dot-separated parts are `header.payload.signature`:
```http
GET /v1/me HTTP/1.1
Host: api.example.com
Authorization: Bearer eyJhbGciOiJSUzI1NiJ9.<payload>.<signature>
```

Decoded payload - base64url, not a secret store. `iss` is who issued it, `sub` the user, `aud` who it is *for*, `exp` the expiry in epoch seconds, `scope` the granted permissions. Anyone holding the token can read all of it:
```json
{
  "iss": "https://auth.example.com",
  "sub": "user_123",
  "aud": "https://api.example.com",
  "scope": "read:profile",
  "exp": 1784074500
}
```

Server side, pin what you accept. The token does not get to choose its own algorithm:
```python
import jwt  # PyJWT

claims = jwt.decode(
    token,
    public_key,
    algorithms=["RS256"],                    # good: one pinned alg; ignore the header's alg
    audience="https://api.example.com",      # good: reject tokens minted for another service
    issuer="https://auth.example.com",
)
# avoid: algorithms=["RS256", "HS256"]  # lets an attacker sign with your public key as an HMAC key
```

A failed auth returns the code with the header RFC 9110 requires:
```http
HTTP/1.1 401 Unauthorized
WWW-Authenticate: Bearer realm="api", error="invalid_token"
```

## Interview Q&A
- **AuthN vs AuthZ?** AuthN proves identity, and failing it returns 401. AuthZ checks permissions, and failing it returns 403. The nuance that earns points: 401 really means "unauthenticated" and must carry a `WWW-Authenticate` header, while 403 means re-auth will not help.
- **What changed in OAuth 2.1?** PKCE is mandatory on every authorization-code flow, the implicit and password (ROPC) grants are removed, redirect URIs match by exact string, and bearer tokens cannot appear in query strings.
- **Why are JWTs hard to revoke?** They are self-contained and validated offline, so they stay valid until `exp` with nothing to switch off server-side. Sessions flip instantly by contrast. Mitigate with short TTLs, refresh-token rotation, and a denylist for the gap.
- **API key vs OAuth token?** An API key names an app for server-to-server calls and carries no user context. An OAuth token is scoped, expiring, delegated access on one specific user's behalf.
- **id_token vs access token?** The `id_token` proves who logged in and is meant for your client. The access token authorizes API calls and is meant for the resource server. Do not cross the streams.

## Gotchas
> [!WARN] **Never trust the token's own `alg` header** - pin algorithms to a server-side allowlist. `alg:none` (no signature at all) and RS256-to-HS256 confusion (the attacker signs with your *public* key used as an HMAC secret) are live attacks per RFC 8725. Then check `aud` and `iss`: a valid signature proves the token is genuine, not that it was minted for *you*, so a token from a neighbouring API sails through without them.

> [!WARN] **A JWT cannot be un-issued.** It validates offline, so a leaked token is a skeleton key until `exp` with nothing to switch off server-side. Keep access-token TTLs to minutes and rotate via refresh tokens. And **never store tokens in `localStorage`** - any XSS-injected script reads them straight out.

- A JWT is **signed, not encrypted**. The payload is base64, not ciphertext, so keep secrets and PII out of it - encrypt with JWE or just do not put them there.
- **Swapping 401 and 403** misleads clients and can leak information. 401 = authenticate (and include `WWW-Authenticate`). 403 = known but not allowed, so do not re-prompt for login.
- **Reaching for JWT by default.** For a single first-party app, server-side sessions are simpler and revoke instantly. JWTs earn their keep when several services must validate a token without sharing a session store.

## Revise next
- **[DRF authentication](../drf/authentication.md) & [permissions](../drf/permissions.md)** - how `authentication_classes` (AuthN) and `permission_classes` (AuthZ) split along the same line.
- **[Webhooks](webhooks.md)** - HMAC signature verification, the same "pin the algorithm, verify before you trust" discipline.
- **[REST & status codes](rest-http-methods-status-codes.md)** - the full 401 vs 403 vs 400 family and when each applies.

*Reviewed against OAuth 2.1, RFC 9110, and RFC 8725 (JWT BCP), July 2026.*
