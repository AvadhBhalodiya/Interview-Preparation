---
title: "JWT Pitfalls"
group: "Access & Data Protection"
order: 5
---

# JWT Pitfalls (Algorithms, Claims, Revocation, Storage)

> Almost every real JWT bug comes from one of three places: letting the token choose its own verification algorithm, skipping claims you assumed the library checked, or discovering that a stateless token cannot be taken back once you have issued it.

## What it is
A JWT is three base64url segments - `header.payload.signature` - carrying **signed** claims. Signed, not encrypted: anyone holding the token reads the payload, and the signature only proves that whoever holds the signing key produced it. That is JWS, which is what people mean 99% of the time. **JWE** is the encrypted variant, and it is rare enough that reaching for it usually means you should have kept the data server-side instead.

The appeal is statelessness - any service with the verification key can authenticate a request with no session lookup - and every pitfall below is the bill for that property.

| The failure | Mechanism | The fix in one line |
| --- | --- | --- |
| **`alg: none`** | Token declares it is unsigned; a naive verifier agrees | Pin the expected algorithm server-side |
| **Algorithm confusion** | RS256 token replayed as HS256 using the **public** key as the HMAC secret | Same fix: never read `alg` from the token |
| **Unchecked claims** | `iss`, `aud`, `nbf` are only verified if you ask | Require and verify them explicitly |
| **No revocation** | Stateless means the server has nothing to delete | Short TTL + refresh rotation, or add state |
| **Bad storage** | `localStorage` is readable by any injected script | `httpOnly` cookie, plus CSRF defence |

> [!KEY] The algorithm is **your** decision, not the token's. Every classic JWT forgery works by getting the verifier to trust the `alg` header on an attacker-supplied token, so a fixed allow-list passed at the call site closes the whole family at once.

## Key points
- **Algorithm confusion is the elegant one.** You verify with RS256, so your public key is, by design, public. The attacker rewrites the header to `HS256`, signs the tampered payload with **your public key as the HMAC secret**, and a verifier that picks its algorithm from the header happily recomputes the same HMAC and accepts it. Nothing was cracked - the verifier was tricked into treating a verification key as a signing key. PyJWT has made `algorithms` a **required** argument to `decode()` since 2.0, and raises `InvalidKeyError` if you pass a PEM public key as an HMAC secret, so the attack is largely closed in current PyJWT. It survives in hand-rolled verification, in older pinned versions, and anywhere the allow-list mixes symmetric and asymmetric algorithms in one list.
- **Libraries verify fewer claims than people assume.** PyJWT checks `exp` and `nbf` by default, but it only compares `iss` and `aud` against values **you pass in** as `issuer=` and `audience=`. Omit them and a token minted by a different tenant, a different environment, or a different service of yours verifies perfectly - the signature is valid, it just was not meant for you. Use `options={"require": [...]}` so a token *missing* a claim is rejected rather than silently passing. The exact default behaviour when a token carries `aud` and you supply none has shifted across releases, so pin your version and write a test for it rather than trusting a blog post.
- **You cannot revoke a stateless token, and the workarounds all reintroduce state.** Short access-token TTLs are the honest baseline: the exposure window is the TTL. Beyond that you are choosing how much state to add back.

| Approach | Revocation latency | What it costs |
| --- | --- | --- |
| **Short access TTL** (5-15 min) | up to one TTL | nothing - this is the baseline |
| **Refresh rotation + reuse detection** | immediate for a stolen **refresh** token | a table of issued refresh tokens |
| **`jti` denylist in Redis** (TTL = remaining `exp`) | immediate | a Redis read on every request |
| **Server-side sessions** | immediate | state, which was always the honest answer |

- **Storage is a trade, not a right answer.** `localStorage` is one line of injected JavaScript away from total token theft. An `httpOnly` cookie cannot be read by script, but the browser attaches it automatically, so you owe CSRF defence - `SameSite=Lax` or `Strict` plus a token on state-changing requests. The honest caveat: `httpOnly` does not stop XSS from *using* the session, since injected script can still fire requests from the page. What it stops is **exfiltration** - the attacker cannot lift a long-lived credential and keep using it from elsewhere after you have patched.

| Where | Readable by XSS? | Sent automatically? | You must add |
| --- | --- | --- | --- |
| **`localStorage`** | **Yes** - trivially | No | nothing, which is the problem |
| **`httpOnly` cookie** | **No** | **Yes** | `Secure`, `SameSite`, CSRF token |
| **In-memory JS variable** | only while the tab lives | No | a silent-refresh flow; lost on reload |

- **The payload is public, so keep PII and secrets out of it.** `jwt.io` decodes any token you paste. A JWT carrying a customer's phone number or government ID number puts that value into every access log, every browser history entry if it ever reaches a URL, and every proxy on the path.
- **Claims go stale, and that is an authorization bug.** Roles baked into a 15-minute token stay authoritative for 15 minutes. Demote a user at 10:00 and their token still says `admin` until 10:15. For destructive or money-moving actions, re-check permission against the database rather than trusting the claim.

> [!TIP] Ask early whether you needed statelessness at all. It pays off across many services with no shared session store. A single Django app behind one load balancer gets sessions in Redis with instant revocation for free - a JWT there is complexity you will pay for at logout time.

## Example
```python
# FastAPI + PyJWT: pin the algorithm, pin the issuer and audience, require claims.
import jwt
from jwt import PyJWKClient

JWKS = PyJWKClient("https://auth.example.com/.well-known/jwks.json", cache_keys=True)

def verify(token: str) -> dict:
    # `kid` selects WHICH key. It never selects the algorithm - that stays ours,
    # hard-coded, because deriving it from the header is the RS256->HS256 attack.
    key = JWKS.get_signing_key_from_jwt(token).key
    return jwt.decode(
        token,
        key,
        algorithms=["RS256"],              # fixed list, never token-derived
        issuer="https://auth.example.com", # PyJWT only checks iss/aud if you pass them
        audience="loans-api",
        leeway=30,                         # seconds of clock drift; keep it small
        # Reject a token that OMITS a claim, not just one whose claim is wrong.
        options={"require": ["exp", "iat", "iss", "aud", "sub"]},
    )
```

```python
# Django settings.py - SimpleJWT's defaults are sensible for a demo, not for prod.
from datetime import timedelta

SIMPLE_JWT = {
    "ACCESS_TOKEN_LIFETIME": timedelta(minutes=5),   # default, and a good one - resist raising it
    "REFRESH_TOKEN_LIFETIME": timedelta(days=1),     # default
    "ROTATE_REFRESH_TOKENS": True,                   # default False
    "BLACKLIST_AFTER_ROTATION": True,                # default False; without it the OLD refresh
                                                     # token stays valid after rotation
    "ALGORITHM": "RS256",
    "SIGNING_KEY": PRIVATE_KEY,   # default is settings.SECRET_KEY. One leaked settings file
    "VERIFYING_KEY": PUBLIC_KEY,  # then mints admin tokens - and rotating SECRET_KEY to fix it
                                  # invalidates every session and password-reset link at once.
    "ISSUER": "https://auth.example.com",
    "AUDIENCE": "loans-api",      # default None means the aud claim is not checked
    "LEEWAY": 30,                 # default 0
}
# 'rest_framework_simplejwt.token_blacklist' must be in INSTALLED_APPS and migrated,
# or BLACKLIST_AFTER_ROTATION has nothing to write to and quietly does nothing.
```

## Interview Q&A
- **What is the algorithm confusion attack?** The attacker changes `alg` from RS256 to HS256 and signs the tampered token with your public key used as an HMAC secret. A verifier that reads the algorithm from the token accepts it. The fix is to pass a fixed `algorithms` allow-list at the verification call and never derive it from the header.
- **How do you revoke a JWT?** Strictly, you cannot - that is what stateless means. In practice: keep access tokens short (5-15 minutes), put revocation on the refresh token with rotation and reuse detection, and add a `jti` denylist in Redis if you need immediate kill. Once you have a denylist you have rebuilt a session store, so it is worth asking whether sessions were the simpler answer.
- **localStorage or an httpOnly cookie?** Cookie, with `Secure`, `SameSite`, and CSRF protection. `localStorage` hands the token to any XSS. The nuance worth saying out loud: `httpOnly` does not stop XSS acting as the user, it stops the attacker stealing a credential to reuse later.
- **Which claims do you verify, and why each?** `exp` and `nbf` for the validity window, `iss` so a token from another issuer is not accepted, `aud` so a token minted for a different service of yours is not replayed against this one, and `sub` for identity. Require them explicitly - a missing claim should be a rejection, not a default-pass.
- **Is a JWT encrypted?** No. A standard JWT is signed (JWS), and the payload is base64url - readable by anyone holding the token. Encryption is JWE, and needing it usually means the data belonged server-side.
- **When would you not use JWTs?** A single monolith with one session store, or anywhere "log out everywhere" and instant permission changes are requirements. JWTs earn their keep across independently deployed services that should not share a session database.

## Gotchas
> [!WARN] `jwt.decode(token, options={"verify_signature": False})` shows up in code that "just needs the user id" or in a downstream service that assumes the gateway already checked. It parses **attacker-controlled JSON**. Anyone can mint that payload in a browser console.

> [!WARN] **Client-side logout is not logout.** Deleting the token from storage leaves any copy taken beforehand valid until `exp`. If "sign out all devices" is a product requirement, you need server-side state - decide that at design time, not after the pen test.

- **Long-lived access tokens are the most common real-world JWT mistake**, usually added because users complained about being logged out. Fix the refresh flow instead; a 30-day access token is a 30-day breach window with no off switch.
- **Clock skew is a real outage.** With `LEEWAY` at 0, a server drifting 40 seconds ahead rejects tokens the instant they are issued on `nbf`. Fix the clocks with NTP first and use a small leeway (30-60s) second - leeway also widens the window in which an expired token still works.
- **`kid` is attacker-controlled input.** Using it as a filesystem path or an unparameterized SQL lookup turns key selection into path traversal or injection. Treat it as an opaque lookup key against a known set.
- **Fat tokens hit header limits.** Stuffing every role and permission into the payload puts a multi-kilobyte header on every request; 8 KB is a common proxy default, and the failure is a confusing 431 or 400 rather than an auth error.
- **A JWT proves authentication, not current authorization.** It says who the user was when the token was minted. Anything irreversible deserves a fresh check.

## Revise next
- **[AuthN vs AuthZ, OAuth and JWT](../api-design/authn-authz-oauth-jwt.md)**: where JWTs sit inside OAuth2 and OIDC, and the access/refresh token split.
- **[DRF authentication](../drf/authentication.md)**: SimpleJWT wiring, `TokenObtainPairView`, and session auth as the alternative.
- **[RBAC vs ABAC](rbac-vs-abac.md)**: why baking roles into a token makes authorization decisions stale.
- **[OWASP API Top 10](owasp-api-top-10.md)**: API2 Broken Authentication, and why a valid token is not an authorization decision.

*Reviewed against PyJWT 2.x, djangorestframework-simplejwt 5.x, RFC 7519, and the OWASP JWT and Session Management cheat sheets, July 2026.*
