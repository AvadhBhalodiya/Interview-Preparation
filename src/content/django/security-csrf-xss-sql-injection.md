---
title: "Built-in Security"
group: "Performance & Security"
order: 12
---

# Django Built-in Security: CSRF, XSS, and SQL Injection

> Django gives strong security defaults, but those protections work only when we keep the framework's security boundaries intact: **CSRF middleware for state-changing requests, template escaping for browser output, and ORM parameterization for database queries**.

**Version note:** Updated for **Django 6.1**.

## In Short

| Threat | What the attacker tries to control | Django's main protection |
|---|---|---|
| **CSRF** | A logged-in user's browser request | `CsrfViewMiddleware` + CSRF token + Origin/Referer checks |
| **XSS** | HTML/JavaScript executed in another user's browser | Template auto-escaping + safe output handling |
| **SQL Injection** | SQL query structure | ORM/query parameterization |

A useful interview mental model is:

```text
Request enters Django
      |
      +--> State-changing request? --> CSRF validation
      |
      +--> Database access? --------> ORM parameterization
      |
      +--> HTML response? ----------> Template escaping
```

---

# 1. Security Model at a Glance

Django's security model starts with one rule:

> **Treat every value controlled by a user or external system as untrusted data.**

That includes form fields, query parameters, cookies, headers, uploaded files, API payloads, webhook data, and user-generated database records.

Django does not provide one global "security switch." Different protections handle different boundaries:

- **CSRF** protects server-side actions.
- **XSS protection** protects browser output.
- **SQL injection protection** protects database queries.
- `ALLOWED_HOSTS`, HTTPS settings, secure cookies, clickjacking protection, and CSP provide additional defense in depth.

---

# 2. CSRF Protection

## 2.1 What CSRF Means

Cross-Site Request Forgery happens when another site causes a user's browser to perform an action on your application using credentials the browser sends automatically, such as a Django session cookie.

A session cookie answers:

```text
Who is this browser session?
```

A CSRF token helps answer:

```text
Did this state-changing request come through a trusted application flow?
```

Django's `CsrfViewMiddleware` protects unsafe requests and normally returns **HTTP 403** when CSRF validation fails.

Safe HTTP methods should not change state:

```text
GET  HEAD  OPTIONS  TRACE
```

State-changing operations normally use methods such as:

```text
POST  PUT  PATCH  DELETE
```

### Correct pattern

```python
from django.contrib.auth.decorators import login_required
from django.http import HttpResponse
from django.views.decorators.http import require_POST


@login_required
@require_POST
def delete_account(request):
    request.user.delete()
    return HttpResponse(status=204)
```

Do not perform destructive actions through `GET` endpoints.

---

## 2.2 CSRF Token in Templates

For an internal Django POST form, include `{% csrf_token %}`:

```html
<form method="post">
    {% csrf_token %}

    <input type="text" name="display_name">
    <button type="submit">Save</button>
</form>
```

Django renders a hidden token field. `CsrfViewMiddleware` validates the submitted token against the CSRF secret associated with the request.

Do not send your CSRF token to unrelated external domains.

---

## 2.3 CSRF with `fetch()` / AJAX

For JavaScript requests using cookie-based Django authentication, send the token in the `X-CSRFToken` header.

```html
{% csrf_token %}

<script>
    const csrfToken = document.querySelector(
        "[name=csrfmiddlewaretoken]"
    ).value;

    async function updateProfile() {
        const response = await fetch("/profile/update/", {
            method: "POST",
            headers: {
                "Content-Type": "application/json",
                "X-CSRFToken": csrfToken,
            },
            body: JSON.stringify({ display_name: "Avadh" }),
        });

        if (!response.ok) {
            throw new Error(`Request failed: ${response.status}`);
        }
    }
</script>
```

For a frontend hosted on another trusted origin, configure only the origins you control:

```python
CSRF_TRUSTED_ORIGINS = [
    "https://app.example.com",
]
```

`CSRF_TRUSTED_ORIGINS` affects Django's CSRF origin checks; it is **not** a replacement for CORS configuration.

---

## 2.4 `csrf_exempt`

`@csrf_exempt` disables Django's CSRF check for that view.

```python
from django.views.decorators.csrf import csrf_exempt


@csrf_exempt
def webhook(request):
    ...
```

This is reasonable for some third-party webhook endpoints because the provider cannot participate in a browser CSRF-token flow. The endpoint still needs its own verification, such as an HMAC or provider signature.

```text
Browser form/API using session cookie
        -> use Django CSRF protection

Third-party webhook
        -> verify provider signature/HMAC
```

Disabling CSRF simply to remove a `403` weakens the application.

---

# 3. XSS Protection

## 3.1 Django Template Auto-Escaping

Django templates auto-escape variables by default.

Template:

```html
<p>{{ comment.body }}</p>
```

Stored value:

```html
<script>alert("XSS")</script>
```

The browser receives escaped text instead of an executable `<script>` element.

```text
Untrusted value
     |
     v
Django template escaping
     |
     v
Escaped HTML text
     |
     v
Browser displays data instead of executing it
```

This is why normal `{{ variable }}` rendering is the preferred default for user-generated text.

---

## 3.2 Auto-Escaping Has Context Limits

HTML escaping is not the same as JavaScript, CSS, or URL validation.

### Safe HTML text context

```html
<p>{{ username }}</p>
```

### Quote attributes

```html
<div class="{{ css_class }}">Content</div>
```

Avoid unquoted values:

```html
<div class={{ css_class }}>Content</div>
```

### Do not inject template variables directly into JavaScript strings

Avoid:

```html
<script>
    const username = "{{ username }}";
</script>
```

For structured data consumed by JavaScript, use `json_script`:

```html
{{ profile_data|json_script:"profile-data" }}

<script>
    const profileData = JSON.parse(
        document.getElementById("profile-data").textContent
    );
</script>
```

Also remember that escaping an `href` value does not automatically decide whether a URL scheme is acceptable. User-provided URLs should be validated against the schemes your application allows.

---

## 3.3 Security-Sensitive Escaping Bypasses

These APIs intentionally tell Django that content is already safe:

```html
{{ value|safe }}
```

```python
from django.utils.safestring import mark_safe

html = mark_safe(value)
```

```html
{% autoescape off %}
    {{ value }}
{% endautoescape %}
```

Use them only when the value is trusted or has been correctly sanitized.

If the application intentionally supports rich HTML, use a maintained HTML sanitizer with an explicit allowlist. Escaping and sanitization are different:

```text
Escaping     -> show markup as text
Sanitization -> allow selected markup and remove unsafe markup
```

For browser-side rendering, prefer `textContent` when you only need text:

```javascript
result.textContent = apiResponse.message;
```

instead of:

```javascript
result.innerHTML = apiResponse.message;
```

---

## 3.4 Content Security Policy (Defense in Depth)

Django includes built-in CSP support. CSP can restrict which scripts, styles, frames, and other resources the browser is allowed to load.

```python
from django.utils.csp import CSP

MIDDLEWARE = [
    # ...
    "django.middleware.csp.ContentSecurityPolicyMiddleware",
    # ...
]

SECURE_CSP = {
    "default-src": [CSP.SELF],
    "script-src": [CSP.SELF],
    "object-src": [CSP.NONE],
}
```

CSP is **defense in depth**. It does not replace output escaping, sanitization, or safe JavaScript APIs.

Django 6.1 also supports the `csp_nonce_attr` template tag for applying request-specific CSP nonces to supported script/style assets.

---

# 4. SQL Injection Protection

## 4.1 Why the ORM Is Safe by Default

Django QuerySets separate the SQL structure from field values.

```python
username = request.GET.get("username", "")
user = User.objects.filter(username=username).first()
```

Conceptually:

```sql
SELECT *
FROM auth_user
WHERE username = %s;
```

and the value is sent separately:

```text
["' OR '1'='1"]
```

The database driver treats the value as data rather than executable SQL syntax.

Normal ORM operations such as `filter()`, `exclude()`, `create()`, `update()`, and model saves should therefore be preferred over manually constructed SQL.

---

## 4.2 Safe Raw SQL

When raw SQL is genuinely needed, use placeholders and pass parameters separately.

```python
from django.db import connection


def find_user(email: str):
    with connection.cursor() as cursor:
        cursor.execute(
            """
            SELECT id, email
            FROM auth_user
            WHERE email = %s
            """,
            [email],
        )
        return cursor.fetchone()
```

The same principle applies to `raw()` and `RawSQL`: values belong in the separate `params` argument.

### Never build SQL with user input

```python
# Unsafe
query = f"SELECT * FROM auth_user WHERE email = '{email}'"
```

Avoid f-strings, `.format()`, and `%` interpolation when building SQL from untrusted values.

Also do not quote the placeholder yourself:

```python
# Correct
cursor.execute(
    "SELECT * FROM auth_user WHERE email = %s",
    [email],
)
```

---

## 4.3 Dynamic Identifiers Need an Allowlist

SQL parameters represent **values**, not identifiers such as table names, column names, sort directions, or SQL keywords.

For user-controlled sorting, map external values to known server-side fields:

```python
ALLOWED_SORT_FIELDS = {
    "name": "first_name",
    "email": "email",
    "created": "date_joined",
}

requested_sort = request.GET.get("sort", "created")
sort_field = ALLOWED_SORT_FIELDS.get(
    requested_sort,
    "date_joined",
)

users = User.objects.order_by(sort_field)
```

The important part is that the final identifier comes from your allowlist, not directly from request data.

---

# 5. One End-to-End Example

A comment feature shows how all three protections work together.

## Model

```python
from django.conf import settings
from django.db import models


class Comment(models.Model):
    author = models.ForeignKey(
        settings.AUTH_USER_MODEL,
        on_delete=models.CASCADE,
    )
    body = models.TextField(max_length=2000)
    created_at = models.DateTimeField(auto_now_add=True)
```

## View

```python
from django.contrib.auth.decorators import login_required
from django.shortcuts import redirect, render
from django.views.decorators.http import require_http_methods

from .forms import CommentForm
from .models import Comment


@login_required
@require_http_methods(["GET", "POST"])
def comment_list(request):
    if request.method == "POST":
        form = CommentForm(request.POST)

        if form.is_valid():
            comment = form.save(commit=False)
            comment.author = request.user
            comment.save()
            return redirect("comment-list")
    else:
        form = CommentForm()

    comments = Comment.objects.select_related("author")

    return render(
        request,
        "comments/comment_list.html",
        {"form": form, "comments": comments},
    )
```

## Template

```html
<form method="post">
    {% csrf_token %}
    {{ form.as_p }}
    <button type="submit">Add comment</button>
</form>

{% for comment in comments %}
    <article>
        <strong>{{ comment.author.username }}</strong>
        <p>{{ comment.body }}</p>
    </article>
{% endfor %}
```

## Security Flow

```text
POST /comments/
      |
      +--> {% csrf_token %}
      |       prevents forged session-authenticated POSTs
      |
      +--> CommentForm validation
      |
      +--> comment.save()
      |       ORM parameterizes database values
      |
      +--> {{ comment.body }}
              template auto-escapes HTML output
```

If a user submits:

```html
<script>alert("XSS")</script>
```

Django may store that text as ordinary data. The SQL insert remains parameterized, and normal template rendering escapes it so the browser displays the text instead of executing it.

---

# 6. Production Security Essentials

For a normal production deployment, the important baseline includes:

```python
DEBUG = False

ALLOWED_HOSTS = [
    "app.example.com",
]

CSRF_TRUSTED_ORIGINS = [
    "https://app.example.com",
]

SECURE_SSL_REDIRECT = True
SESSION_COOKIE_SECURE = True
CSRF_COOKIE_SECURE = True
SESSION_COOKIE_HTTPONLY = True

SESSION_COOKIE_SAMESITE = "Lax"
CSRF_COOKIE_SAMESITE = "Lax"
```

Keep `SECRET_KEY` outside source control and use a production-ready WSGI/ASGI server instead of `runserver`.

Run Django's deployment checks against production settings:

```bash
python manage.py check --deploy
```

If HTTPS is terminated by a trusted reverse proxy, configure proxy headers only when that proxy removes or overwrites spoofed forwarded headers.

Security also depends on staying on a supported Django version and applying security patch releases promptly.

---

# 7. Interview-Ready Summary

```text
CSRF
  Browser/request boundary
  -> CsrfViewMiddleware + token + Origin/Referer checks

XSS
  HTML/browser boundary
  -> template auto-escaping + context-safe output

SQL Injection
  database/query boundary
  -> ORM parameterization + parameterized raw SQL
```

The key point is not simply that "Django is secure." The stronger explanation is:

> **Django gives secure defaults at each boundary, but developers must avoid bypassing them.** Keep CSRF middleware enabled for cookie-authenticated state changes, render untrusted text through normal template escaping, and keep user values separate from SQL structure.
