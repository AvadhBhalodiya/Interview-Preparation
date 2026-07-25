---
title: "Injection, XSS, CSRF"
group: "Web Vulnerabilities"
order: 2
---

# SQL Injection, XSS, CSRF (What They Are + How to Prevent)

> Three classic web attacks: SQL injection puts attacker SQL into your query, XSS puts attacker JavaScript into your page, and CSRF rides a logged-in user's cookies to forge a request - closed off by parameterized queries, context-aware output encoding, and anti-CSRF tokens with SameSite cookies, respectively.

## What it is
Three attacks, two root causes. **SQL injection and XSS are one bug in different clothes**: untrusted input gets interpreted as **code instead of data**. **CSRF is a different animal**: it abuses the browser's habit of auto-attaching cookies, so a forged cross-site request arrives already authenticated.

> [!KEY] Injection bugs (SQLi, XSS) are a **data-vs-code confusion**, so keep untrusted input on the data side. CSRF is an **ambient-authority** problem, where the browser spends a cookie the user never meant to send.

| Attack | What goes wrong | Primary defense | OWASP 2025 |
| --- | --- | --- | --- |
| **SQL injection** (CWE-89) | Input is parsed as **SQL** against your DB | **Parameterized queries / ORM**, allow-list identifiers | A05 Injection |
| **XSS** (CWE-79) | Input runs as **JavaScript** in a victim's browser | **Context-aware output encoding**, CSP as backstop | A05 Injection |
| **CSRF** (CWE-352) | Browser **auto-sends cookies** on a forged request | **Anti-CSRF token** + SameSite cookies, no GET writes | A01 Broken Access Control |

- Keep the ranking in perspective: Injection slid from **A03 (2021) to A05 (2025)** because misconfiguration and supply-chain risks climbed past it, not because injection got safe. CSRF still maps under **A01 Broken Access Control** (CWE-352).

> [!TIP] In an interview the fix is table stakes. The real signal is whether you can explain **why the naive version fails** and exactly where each defense stops.

## Key points
- **SQL injection:** input is concatenated into a query, so the DB parses attacker text as SQL and `' OR '1'='1` logs them in as the first user. The fix is **parameterized queries** (prepared statements): query text and data travel on separate channels, so data is never parsed as code. Binds only cover **values, not identifiers** - table names, column names, and `ORDER BY col ASC` can't be parameterized, so allow-list those against known-good names. Run on a **least-privilege DB account** so an injection can't `DROP` anything, and skip manual escaping, which OWASP lists dead last and calls strongly discouraged.
- **XSS (cross-site scripting):** the attacker gets JavaScript to run in another user's browser, where it inherits their session and can act as them or exfiltrate data. The primary defense is **context-aware output encoding**: safe escaping differs for an HTML body versus an attribute versus inside `<script>` versus a URL, which is exactly why you stay on the framework's **auto-escaping** path instead of hand-rolling it.

Three XSS flavors, told apart by where the payload lives:

| XSS type | Where the payload lives | How it reaches the victim |
| --- | --- | --- |
| **Stored** | Persisted in your **DB / backend** | Served to **every** user who views it |
| **Reflected** | In a **crafted URL or param** | Bounced back to **whoever** opens the link |
| **DOM-based** | Never leaves the **client**, via a sink like `innerHTML` | Server **never sees** the payload |

- **CSRF (cross-site request forgery):** a victim is logged into your site, an attacker page fires a request, and the browser helpfully attaches their cookies, so the forged POST looks legitimate. Defend with a per-request **anti-CSRF token** the attacker can't read or predict, plus **SameSite** cookies, and never change state on a GET. Most browsers now default to `SameSite=Lax`, which already blocks cross-site POSTs from carrying your session and quietly killed a lot of textbook CSRF.

Two token patterns, picked by whether you keep server-side state:

| Pattern | Server keeps state? | How it validates |
| --- | --- | --- |
| **Synchronizer token** | **Yes**, token held in the session | Compare the submitted token to the **stored** one |
| **Double-submit cookie** | **No**, fully stateless | Token sits in **both a cookie and a header/field**, and the two must match (sign or HMAC it) |

- **Frameworks get this right by default:** Django parameterizes the ORM, auto-escapes templates, and ships CSRF middleware. React escapes values in JSX. Nearly every real bug is someone stepping off the paved path with `|safe`, `mark_safe`, `dangerouslySetInnerHTML`, an f-string in `execute()`, or `@csrf_exempt`.
- **Defense in depth, not replacements:** CSP and `HttpOnly` cookies shrink the blast radius of an XSS but don't stop one, and OWASP is blunt that CSP is a second layer rather than your primary control. When you genuinely must render user-authored HTML, sanitize it with a vetted library like DOMPurify instead of a homegrown regex.

## Example
```python
# avoid: user input concatenated straight into the query
cursor.execute(f"SELECT * FROM users WHERE email = '{email}'")

# good: parameterized, so email is bound as data and never parsed as SQL
cursor.execute("SELECT * FROM users WHERE email = %s", [email])
User.objects.filter(email=email)          # the ORM parameterizes for you

# note: binds can't cover identifiers (column / table / sort direction).
# allow-list those instead of interpolating raw input:
SORTABLE = {"created", "email", "name"}
col = sort_col if sort_col in SORTABLE else "created"
cursor.execute(f"SELECT * FROM users ORDER BY {col} ASC")
```

```jsx
// avoid: raw user HTML injected into the DOM (stored XSS)
<div dangerouslySetInnerHTML={{ __html: comment }} />

// good: let JSX escape it, or sanitize first if you truly must render HTML
<div>{comment}</div>
<div dangerouslySetInnerHTML={{ __html: DOMPurify.sanitize(comment) }} />
```

## Interview Q&A
- **How do you prevent SQL injection?** Parameterized queries or prepared statements so input can never be parsed as SQL. The ORM does this for you. For identifiers you can't bind (table, column, sort order) allow-list against known-good values, and run on a least-privilege DB account.
- **What are the XSS types and the main defense?** Stored, reflected, and DOM-based. The primary defense is context-aware output encoding, which is why you lean on the framework's auto-escaping and treat CSP and `HttpOnly` as backstops, not the fix.
- **How does CSRF work and how do you stop it?** An attacker page tricks a logged-in user's browser into sending a request that auto-includes their cookies. Stop it with an anti-CSRF token plus SameSite cookies, and never mutate state on a GET.
- **Stored vs reflected XSS?** Stored is persisted server-side and served to every viewer. Reflected bounces off a single crafted request or link and only hits whoever triggers it.
- **Why don't CSRF tokens matter much for a JSON API using bearer tokens?** There's no ambient credential the browser attaches on its own. The client has to set the `Authorization` header deliberately, so a cross-site form can't forge an authenticated call. Keep CORS tight and don't quietly fall back to cookie sessions.

## Gotchas
> [!WARN] `|safe`, `mark_safe`, `dangerouslySetInnerHTML`, an f-string inside `execute()`, or `@csrf_exempt` each reopens the exact hole the framework closed. Every one is a "trust me" override, so treat them as **code-review red flags**.

> [!WARN] **XSS beats every CSRF defense.** If attacker JS runs on your origin it just reads the token and fires the request itself, so fixing XSS is **upstream** of fixing CSRF.

- CSP and `HttpOnly` reduce XSS damage but don't prevent XSS. OWASP explicitly calls CSP defense-in-depth, not your primary control. Encode output first.
- `SameSite=Lax` is the browser default now, but it still permits state-changing GETs and treats subdomains as same-site, so a compromised `sub.example.com` can still reach you. Keep the token.
- Client-side validation is UX, not security. A request can be replayed with `curl`, so validate and encode on the server every time.

## Revise next
- [OWASP Top 10:2025](owasp-top-10.md): A05 Injection and A01 Broken Access Control
- [Django security defaults](../django/security-csrf-xss-sql-injection.md) (ORM parameterization, template auto-escaping, CSRF middleware)
- Content-Security-Policy and Trusted Types for DOM XSS
- [HTTPS / TLS 1.3](https-tls-basics.md) (RFC 8446): 1-RTT vs 0-RTT handshakes and HSTS

*Reviewed against OWASP Top 10:2025 (A05 Injection, A01 Broken Access Control) and the OWASP SQL Injection / XSS / CSRF prevention cheat sheets, July 2026.*
