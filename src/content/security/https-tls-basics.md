---
title: "HTTPS / TLS"
group: "Access & Data Protection"
order: 8
---

# HTTPS / TLS Basics

> HTTPS is just HTTP running inside a TLS tunnel: TLS buys you confidentiality, tamper detection, and proof you're talking to the real server, and in 2026 that means TLS 1.3, with 1.2 kept around only for stragglers.

## What it is
HTTPS is HTTP carried inside a **TLS tunnel** (TLS = Transport Layer Security, the thing everyone still calls "SSL" out of habit, though SSL itself has been dead for years). Everything above the transport - request line, headers, cookies, body - rides encrypted.

TLS delivers three guarantees, and only while the bytes are on the wire:

| Property | What it means | What it stops |
| --- | --- | --- |
| **Confidentiality** | nobody on the wire can **read** the bytes | eavesdropping, credential sniffing |
| **Integrity** | nobody can **tamper** undetected, enforced by AEAD | injected content, request rewriting |
| **Authentication** | a certificate proves the **server's identity** | impersonation, MITM |

> [!KEY] TLS spends **asymmetric** crypto once - the certificate plus an ECDHE exchange - to authenticate the server and agree a shared secret, then runs every byte after under fast **symmetric** AEAD. Slow math to bootstrap trust, cheap math to move data.

> [!TIP] Authentication is **one-directional** by default: the server proves itself to you, not the reverse. Making the client present a cert too is **mutual TLS (mTLS)**, standard for service-to-service traffic.

## Key points
The TLS 1.3 handshake is **one round trip (1-RTT)** - application data flows right after it (RFC 8446):

| Step | Direction | Message | What happens |
| --- | --- | --- | --- |
| 1 | **client → server** | `ClientHello` | offers versions + cipher suites, sends an **ECDHE key share** speculatively |
| 2 | **server → client** | `ServerHello` | picks version + cipher, returns its **ECDHE key share** - both sides now derive the same **session key** |
| 3 | **server → client** | `{Certificate, CertificateVerify, Finished}` | server proves identity, already encrypted under handshake keys |
| 4 | **client → server** | `{Finished}` + data | client verifies the **cert chain + hostname**, then symmetric **AEAD** traffic flows |

- **Resumption can go faster still.** With a prior session's ticket (PSK) the client may send **0-RTT early data** in its first flight, skipping the round trip - powerful but replay-prone, so read the Gotchas before enabling it.
- **Forward secrecy** is why the exchange is ephemeral, and TLS 1.3 makes it mandatory. Because the session key comes from throwaway ECDHE values, stealing the server's long-term private key next year still cannot decrypt traffic captured today. That is why 1.3 deleted the old **static-RSA** key exchange, under which one leaked key retroactively unlocked every past session.
- **The certificate authenticates, it does not encrypt.** It binds a public key to a domain, signed by a **CA** whose chain runs up to a root already in your OS or browser trust store. The client checks three things together: the **signature chain** to a trusted root, an **unexpired validity window**, and a **hostname** that matches the cert's `subjectAltName`. A perfectly valid cert for the wrong domain is still a rejection. Let's Encrypt made these free and scriptable, so plaintext has no excuse.
- **Revocation is the weak link.** A stolen-but-unexpired cert stays trusted until revoked, so clients check status via OCSP. **OCSP stapling** lets the server attach a fresh signed "still valid" proof, so the client skips a slow, privacy-leaking round trip to the CA.
- Version policy, straight from the OWASP TLS cheat sheet:

| Version | Policy | Why |
| --- | --- | --- |
| **TLS 1.3** | **default** | 1-RTT, mandatory forward secrecy, legacy footguns removed |
| **TLS 1.2** | allow only for **compatibility** | fine with forward-secrecy AEAD suites (AES-GCM, ChaCha20-Poly1305), drop CBC / RC4 / 3DES |
| **TLS 1.0 / 1.1** | **hard-disable** | formally deprecated by RFC 8996 |
| **SSL 2.0 / 3.0** | **hard-disable** | broken for years |

- **Harden the edge, not just the protocol.** Send an **HSTS** header (`Strict-Transport-Security`) so browsers refuse plaintext, 301 all HTTP to HTTPS, and mark session cookies `Secure` and `HttpOnly`. HSTS closes the classic downgrade: a MITM strips you back to HTTP and lifts the session cookie, the exact scenario OWASP files under **A04:2025 Cryptographic Failures**.
- **In transit is not at rest.** TLS protects bytes on the wire and nothing else. The moment traffic terminates at your load balancer, or data lands on disk, TLS is done. Encrypt at rest separately, and remember hops behind the LB may be plaintext unless you run mTLS internally.

## Example
```bash
# what version + cipher did we actually negotiate?
openssl s_client -connect example.com:443 -tls1_3 </dev/null 2>/dev/null \
  | grep -E "Protocol|Cipher"

# is HTTP redirected, and is HSTS set on the HTTPS response?
curl -sSI http://example.com  | grep -i location
curl -sSI https://example.com | grep -i strict-transport-security

# when does the cert expire? (monitor this - expiry is a top self-inflicted outage)
echo | openssl s_client -connect example.com:443 2>/dev/null \
  | openssl x509 -noout -subject -dates
```

## Interview Q&A
- **What does TLS give you, and what does it not?** Confidentiality, integrity, and server authentication, all on the wire. It does nothing for data at rest, data after TLS termination, or your app logic. "We use HTTPS" is not a synonym for "we're secure."
- **Why is TLS 1.3 better than 1.2, concretely?** It is faster (1-RTT handshake, optional 0-RTT resumption) and it removed the footguns: static-RSA key exchange, CBC and RC4 and 3DES, MD5 and SHA-1 signatures, renegotiation, and compression. Forward secrecy went from optional to required.
- **What is forward secrecy and why does it matter?** Each session's key is derived from ephemeral ECDHE values that both sides discard. Compromising the server's private key later cannot decrypt earlier captured sessions. Under old static-RSA it could, so one key leak broke everything retroactively.
- **Symmetric vs asymmetric, where does each live?** Asymmetric crypto (the certificate plus ECDHE) authenticates the server and establishes the shared secret. Symmetric crypto (the derived session key) encrypts the bulk traffic because it is far cheaper per byte. TLS uses asymmetric to bootstrap, symmetric to run.
- **What actually makes a certificate valid?** Three things together: a signature chain up to a trusted root CA, an unexpired validity window, and a hostname matching the cert's `subjectAltName`. Miss any one and the client should refuse the connection.

## Gotchas
> [!WARN] **0-RTT early data is neither replay-safe nor forward-secret** (RFC 8446 Section 8). An attacker who captures the early-data packet can replay it against the server. Only allow it on **idempotent** requests like GETs - put 0-RTT in front of anything that mutates state and the replay changes state twice.

> [!WARN] A **green padlock proves the pipe, not the peer's honesty or your data at rest**, and it says nothing about the cipher underneath. Leaving TLS 1.0/1.1 or CBC/RC4/3DES enabled invites silent **downgrade** attacks. Scan with SSL Labs or `testssl.sh` and disable them explicitly.

- **Certificates expire, and expiry is a top self-inflicted outage.** Automate renewal (Let's Encrypt plus something that actually alerts) and monitor days-to-expiry rather than trusting someone to notice.
- **SNI still leaks the target hostname in cleartext** during the handshake, even on TLS 1.3. Only **Encrypted Client Hello (ECH)** fixes that. TLS hides your traffic, not necessarily which site you're visiting.
- **HSTS `preload` is effectively permanent.** It bakes your domain into the browsers themselves, so if you later need plaintext on a subdomain you are stuck. Roll out with a short `max-age` first, confirm nothing breaks, then raise it toward two years.

## Revise next
- **[Secrets management](secrets-management.md)** - where TLS private keys and app secrets actually live (Vault, KMS, sealed secrets).
- **[Django security settings](../django/security-csrf-xss-sql-injection.md)** - `SECURE_SSL_REDIRECT`, `SECURE_HSTS_SECONDS`, `SESSION_COOKIE_SECURE`.
- **[AuthN vs AuthZ](../api-design/authn-authz-oauth-jwt.md)** - OAuth / OIDC riding on top of the HTTPS channel.
- **mTLS** - service-to-service TLS where both peers present certificates.

*Reviewed against RFC 8446 (TLS 1.3), OWASP Top 10:2025 (A04 Cryptographic Failures), and the OWASP TLS + HSTS cheat sheets, July 2026.*
