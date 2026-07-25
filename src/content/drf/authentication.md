---
title: "Authentication"
group: "Auth & Permissions"
order: 3
---

# DRF Authentication: Session, Token, and JWT

> Authentication answers **“Who is making this request?”**  
> Permissions answer **“Is this authenticated user allowed to perform this action?”**

This guide explains the three authentication approaches commonly used with Django REST Framework:

1. **Session Authentication**
2. **DRF Token Authentication**
3. **JWT Authentication**

The examples are written for developers who already understand Django models, views, URLs, and basic REST APIs.

---

## Table of Contents

- [1. Authentication in DRF](#1-authentication-in-drf)
  - [Authentication request flow](#authentication-request-flow)
  - [`request.user` and `request.auth`](#requestuser-and-requestauth)
  - [Authentication vs permissions](#authentication-vs-permissions)
- [2. Common project setup](#2-common-project-setup)
- [3. Session Authentication](#3-session-authentication)
  - [How it works](#how-session-authentication-works)
  - [Configuration](#session-authentication-configuration)
  - [Login and logout](#session-login-and-logout)
  - [CSRF protection](#csrf-protection)
  - [When to use it](#when-to-use-session-authentication)
- [4. DRF Token Authentication](#4-drf-token-authentication)
  - [How it works](#how-token-authentication-works)
  - [Configuration](#token-authentication-configuration)
  - [Obtaining a token](#obtaining-a-token)
  - [Using and revoking a token](#using-and-revoking-a-token)
  - [When to use it](#when-to-use-token-authentication)
- [5. JWT Authentication](#5-jwt-authentication)
  - [How JWT works](#how-jwt-works)
  - [Access and refresh tokens](#access-and-refresh-tokens)
  - [Simple JWT configuration](#simple-jwt-configuration)
  - [Obtaining, refreshing, and verifying tokens](#obtaining-refreshing-and-verifying-tokens)
  - [Logout and token blacklisting](#jwt-logout-and-token-blacklisting)
  - [Custom claims](#custom-jwt-claims)
  - [When to use it](#when-to-use-jwt-authentication)
- [6. Protecting API endpoints](#6-protecting-api-endpoints)
- [7. Global and per-view authentication](#7-global-and-per-view-authentication)
- [8. Multiple authentication classes](#8-multiple-authentication-classes)
- [9. Session vs Token vs JWT](#9-session-vs-token-vs-jwt)
- [10. Choosing the right approach](#10-choosing-the-right-approach)
- [11. Security best practices](#11-security-best-practices)
- [12. Testing authentication](#12-testing-authentication)
- [13. Practical project structure](#13-practical-project-structure)
- [14. Key takeaways](#14-key-takeaways)
- [References](#references)

---

# 1. Authentication in DRF

Django REST Framework runs authentication before permission checks and before the main view logic.

A successful authentication class normally sets:

```python
request.user
request.auth
```

A view then uses permission classes such as `IsAuthenticated` to decide whether the request is allowed.

## Authentication request flow

```mermaid
flowchart LR
    A[Client Request] --> B[DRF Authentication Classes]
    B --> C{Credentials valid?}
    C -- No credentials --> D[AnonymousUser]
    C -- Invalid credentials --> E[Authentication Error]
    C -- Valid credentials --> F[request.user and request.auth]
    D --> G[Permission Classes]
    F --> G
    G --> H{Permission granted?}
    H -- Yes --> I[Run View Logic]
    H -- No --> J[401 or 403 Response]
```

A simplified internal flow looks like this:

```text
Incoming request
      |
      v
Authentication class checks credentials
      |
      +-- Credentials valid ------> Set request.user/request.auth
      |
      +-- No credentials ---------> Continue as AnonymousUser
      |
      +-- Invalid credentials ----> Raise AuthenticationFailed
      |
      v
Permission classes check access
      |
      +-- Allowed ----------------> Execute view
      |
      +-- Denied -----------------> Return 401 or 403
```

## `request.user` and `request.auth`

The values depend on the authentication scheme.

| Authentication scheme | `request.user` | `request.auth` |
|---|---|---|
| Session Authentication | Django user | `None` |
| DRF Token Authentication | Django user | `Token` model instance |
| Simple JWT | Django user | Validated JWT token object |
| No successful authentication | `AnonymousUser` | `None` |

Example:

```python
from rest_framework.response import Response
from rest_framework.views import APIView


class CurrentUserView(APIView):
    def get(self, request):
        return Response(
            {
                "user_id": request.user.id,
                "username": request.user.get_username(),
                "auth": str(request.auth),
            }
        )
```

## Authentication vs permissions

Authentication only identifies the requester.

It does not automatically guarantee that the requester can access every endpoint.

```python
from rest_framework.permissions import IsAuthenticated
from rest_framework.views import APIView


class ProfileView(APIView):
    permission_classes = [IsAuthenticated]
```

Common permission classes:

| Permission class | Meaning |
|---|---|
| `AllowAny` | Authentication is not required |
| `IsAuthenticated` | Any authenticated user is allowed |
| `IsAdminUser` | Only users with `is_staff=True` |
| `IsAuthenticatedOrReadOnly` | Anonymous users can read; authenticated users can write |

---

# 2. Common Project Setup

Install Django REST Framework:

```bash
python -m pip install djangorestframework
```

Add DRF to `INSTALLED_APPS`:

```python
# settings.py

INSTALLED_APPS = [
    # Django applications...
    "rest_framework",
]
```

A common global permission policy is:

```python
# settings.py

REST_FRAMEWORK = {
    "DEFAULT_PERMISSION_CLASSES": [
        "rest_framework.permissions.IsAuthenticated",
    ],
}
```

This makes endpoints private by default.

Public endpoints must then explicitly use `AllowAny`.

```python
from rest_framework.permissions import AllowAny
from rest_framework.views import APIView


class HealthCheckView(APIView):
    permission_classes = [AllowAny]
```

> **Practical rule:** Private-by-default APIs are generally safer than making every endpoint public and protecting them individually.

---

# 3. Session Authentication

## How Session Authentication works

Session Authentication uses Django’s standard session framework.

After a successful login:

1. Django creates a server-side session.
2. The browser receives a session cookie, usually named `sessionid`.
3. The browser sends that cookie with later requests.
4. Django uses the session key to identify the logged-in user.
5. DRF sets `request.user`.

```mermaid
sequenceDiagram
    participant Browser
    participant Django
    participant SessionStore as Session Store

    Browser->>Django: POST /login/ with username and password
    Django->>SessionStore: Create session for user
    SessionStore-->>Django: Session key
    Django-->>Browser: Set-Cookie: sessionid=...
    Browser->>Django: GET /api/profile/ with session cookie
    Django->>SessionStore: Resolve session key
    SessionStore-->>Django: Authenticated user
    Django-->>Browser: 200 Profile response
```

The browser generally manages the cookie automatically.

Session authentication is most natural when:

- Django renders the frontend.
- The frontend and API use the same site and login session.
- A same-origin browser application calls DRF endpoints.
- Developers use DRF’s browsable API.

## Session Authentication configuration

```python
# settings.py

REST_FRAMEWORK = {
    "DEFAULT_AUTHENTICATION_CLASSES": [
        "rest_framework.authentication.SessionAuthentication",
    ],
    "DEFAULT_PERMISSION_CLASSES": [
        "rest_framework.permissions.IsAuthenticated",
    ],
}
```

For the DRF browsable API, include the built-in login and logout routes:

```python
# urls.py

from django.urls import include, path

urlpatterns = [
    path(
        "api-auth/",
        include("rest_framework.urls", namespace="rest_framework"),
    ),
]
```

This provides browsable API login and logout pages.

## Session login and logout

For an application login endpoint, use Django’s standard authentication functions.

```python
# views.py

from django.contrib.auth import authenticate, login, logout
from rest_framework import status
from rest_framework.permissions import AllowAny, IsAuthenticated
from rest_framework.response import Response
from rest_framework.views import APIView


class SessionLoginView(APIView):
    authentication_classes = []
    permission_classes = [AllowAny]

    def post(self, request):
        username = request.data.get("username")
        password = request.data.get("password")

        user = authenticate(
            request=request,
            username=username,
            password=password,
        )

        if user is None:
            return Response(
                {"detail": "Invalid credentials."},
                status=status.HTTP_400_BAD_REQUEST,
            )

        login(request, user)

        return Response(
            {
                "message": "Login successful.",
                "user_id": user.id,
                "username": user.get_username(),
            }
        )


class SessionLogoutView(APIView):
    permission_classes = [IsAuthenticated]

    def post(self, request):
        logout(request)
        return Response({"message": "Logout successful."})
```

URLs:

```python
# urls.py

from django.urls import path

from .views import SessionLoginView, SessionLogoutView

urlpatterns = [
    path("auth/session/login/", SessionLoginView.as_view()),
    path("auth/session/logout/", SessionLogoutView.as_view()),
]
```

> The login endpoint itself must be protected against CSRF. Do not treat `SessionAuthentication` as a replacement for Django’s secure login handling.

## CSRF protection

Session cookies are sent automatically by browsers. That creates a CSRF risk.

For authenticated session requests, unsafe methods require a valid CSRF token:

- `POST`
- `PUT`
- `PATCH`
- `DELETE`

Safe methods such as `GET`, `HEAD`, and `OPTIONS` should not change server state.

Typical browser request:

```javascript
const csrfToken = getCookie("csrftoken");

const response = await fetch("/api/profile/", {
  method: "PATCH",
  credentials: "include",
  headers: {
    "Content-Type": "application/json",
    "X-CSRFToken": csrfToken,
  },
  body: JSON.stringify({
    display_name: "Avadh",
  }),
});
```

Cookie helper:

```javascript
function getCookie(name) {
  const cookies = document.cookie ? document.cookie.split(";") : [];

  for (const cookie of cookies) {
    const trimmedCookie = cookie.trim();

    if (trimmedCookie.startsWith(`${name}=`)) {
      return decodeURIComponent(trimmedCookie.slice(name.length + 1));
    }
  }

  return null;
}
```

### CSRF and CORS are different

| Concern | Protects against |
|---|---|
| CSRF | Another site causing a user’s browser to submit an authenticated request |
| CORS | Controls which browser origins may read or send cross-origin requests |
| Authentication | Identifies the requester |
| Permissions | Decides what the requester may do |

Enabling CORS does not disable the need for CSRF protection when cookie-based authentication is used.

## When to use Session Authentication

Use it when:

- The API and browser frontend belong to the same Django application.
- Users already log in through Django.
- You want automatic cookie handling.
- You want straightforward logout and server-side session invalidation.
- You use Django admin or DRF’s browsable API.

Avoid it as the default choice when:

- Native mobile or desktop clients consume the API.
- Third-party clients consume the API.
- The frontend and backend are hosted on unrelated domains.
- You are building service-to-service authentication.

---

# 4. DRF Token Authentication

## How Token Authentication works

DRF Token Authentication uses a long random token associated with a user.

The client sends the token on every request:

```http
Authorization: Token 0123456789abcdef...
```

The server looks up the token in the database and identifies its user.

```mermaid
sequenceDiagram
    participant Client
    participant API
    participant Database

    Client->>API: POST /api-token-auth/ with credentials
    API->>Database: Validate user
    Database-->>API: User
    API->>Database: Read or create token
    API-->>Client: token
    Client->>API: GET /api/profile/ + Authorization: Token ...
    API->>Database: Find token and user
    Database-->>API: Authenticated user
    API-->>Client: 200 Profile response
```

DRF’s built-in token implementation is intentionally simple:

- One token per user.
- Token stored in the database.
- No built-in expiration time.
- Rotation must be implemented manually.
- Revocation usually means deleting the token.

## Token Authentication configuration

Add the token application:

```python
# settings.py

INSTALLED_APPS = [
    # ...
    "rest_framework",
    "rest_framework.authtoken",
]
```

Run migrations:

```bash
python manage.py migrate
```

Configure DRF:

```python
# settings.py

REST_FRAMEWORK = {
    "DEFAULT_AUTHENTICATION_CLASSES": [
        "rest_framework.authentication.TokenAuthentication",
    ],
    "DEFAULT_PERMISSION_CLASSES": [
        "rest_framework.permissions.IsAuthenticated",
    ],
}
```

## Obtaining a token

DRF provides a basic token endpoint:

```python
# urls.py

from django.urls import path
from rest_framework.authtoken.views import obtain_auth_token

urlpatterns = [
    path("api-token-auth/", obtain_auth_token, name="api_token_auth"),
]
```

Request:

```bash
curl \
  -X POST \
  -H "Content-Type: application/json" \
  -d '{"username":"alice","password":"strong-password"}' \
  http://localhost:8000/api-token-auth/
```

Response:

```json
{
  "token": "0123456789abcdef0123456789abcdef01234567"
}
```

The built-in endpoint has minimal behavior. Real projects commonly add:

- Throttling.
- Audit logging.
- User information in the response.
- Device information.
- Custom error responses.

A custom token view:

```python
from rest_framework.authtoken.models import Token
from rest_framework.authtoken.views import ObtainAuthToken
from rest_framework.response import Response


class CustomAuthTokenView(ObtainAuthToken):
    def post(self, request, *args, **kwargs):
        serializer = self.serializer_class(
            data=request.data,
            context={"request": request},
        )
        serializer.is_valid(raise_exception=True)

        user = serializer.validated_data["user"]
        token, _ = Token.objects.get_or_create(user=user)

        return Response(
            {
                "token": token.key,
                "user": {
                    "id": user.id,
                    "username": user.get_username(),
                },
            }
        )
```

URL:

```python
path("auth/token/login/", CustomAuthTokenView.as_view())
```

You can also generate a token from the command line:

```bash
python manage.py drf_create_token alice
```

Regenerate an existing token:

```bash
python manage.py drf_create_token -r alice
```

## Using and revoking a token

Use the token:

```bash
curl \
  -H "Authorization: Token 0123456789abcdef0123456789abcdef01234567" \
  http://localhost:8000/api/profile/
```

A simple logout endpoint deletes the token:

```python
from rest_framework.permissions import IsAuthenticated
from rest_framework.response import Response
from rest_framework.views import APIView


class TokenLogoutView(APIView):
    permission_classes = [IsAuthenticated]

    def post(self, request):
        request.auth.delete()
        return Response({"message": "Token revoked successfully."})
```

After deletion, the old token can no longer authenticate.

### Important limitation

Because the built-in implementation normally keeps one token per user, logging out from one device can invalidate the same token used by other devices.

For advanced requirements such as:

- Separate tokens per device.
- Automatic expiration.
- Token rotation.
- Stronger token-storage behavior.
- Detailed session management.

use a more capable token package or JWT-based design.

## When to use Token Authentication

Use DRF Token Authentication when:

- The API is small or internal.
- Requirements are simple.
- A mobile or desktop client needs a persistent credential.
- Immediate database-backed revocation is useful.
- You do not need refresh tokens.

Avoid it when:

- Tokens must expire automatically.
- Users need independent sessions on many devices.
- You need scalable cross-service verification.
- You need access and refresh token lifecycles.

---

# 5. JWT Authentication

JWT authentication is not included directly in DRF’s core authentication classes.

A widely used DRF integration is **Simple JWT**.

## How JWT works

JWT stands for **JSON Web Token**.

A JWT usually contains three Base64URL-encoded sections:

```text
header.payload.signature
```

Example structure:

```text
eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9
.
eyJ1c2VyX2lkIjoxLCJleHAiOjE3MDAwMDAwMDB9
.
signature-value
```

```mermaid
flowchart LR
    A[Header] --> D[header.payload.signature]
    B[Payload / Claims] --> D
    C[Cryptographic Signature] --> D
```

### Header

Describes token metadata, commonly the signing algorithm.

```json
{
  "alg": "HS256",
  "typ": "JWT"
}
```

### Payload

Contains claims.

```json
{
  "user_id": 12,
  "token_type": "access",
  "exp": 1785000000,
  "iat": 1784999700,
  "jti": "unique-token-id"
}
```

### Signature

Allows the server to detect modification of the header or payload.

> A signed JWT is **not encrypted**. Anyone holding the token can decode its header and payload. Never place passwords, secrets, or unnecessary sensitive data inside JWT claims.

## Access and refresh tokens

Simple JWT commonly uses a token pair.

| Token | Purpose | Recommended behavior |
|---|---|---|
| Access token | Sent to protected API endpoints | Short lifetime |
| Refresh token | Gets a new access token | Longer lifetime and stronger storage protection |

```mermaid
sequenceDiagram
    participant Client
    participant API

    Client->>API: POST /api/token/ with credentials
    API-->>Client: Access token + Refresh token
    Client->>API: Request with Bearer access token
    API-->>Client: Protected response
    Note over Client: Access token expires
    Client->>API: POST /api/token/refresh/ with refresh token
    API-->>Client: New access token
```

A short-lived access token limits the damage window if it is stolen.

A refresh token improves user experience because users do not need to submit their password whenever an access token expires.

## Simple JWT configuration

Install Simple JWT:

```bash
python -m pip install "djangorestframework-simplejwt[crypto]"
```

Configure authentication:

```python
# settings.py

REST_FRAMEWORK = {
    "DEFAULT_AUTHENTICATION_CLASSES": [
        "rest_framework_simplejwt.authentication.JWTAuthentication",
    ],
    "DEFAULT_PERMISSION_CLASSES": [
        "rest_framework.permissions.IsAuthenticated",
    ],
}
```

Add token endpoints:

```python
# urls.py

from django.urls import path
from rest_framework_simplejwt.views import (
    TokenObtainPairView,
    TokenRefreshView,
    TokenVerifyView,
)

urlpatterns = [
    path(
        "api/token/",
        TokenObtainPairView.as_view(),
        name="token_obtain_pair",
    ),
    path(
        "api/token/refresh/",
        TokenRefreshView.as_view(),
        name="token_refresh",
    ),
    path(
        "api/token/verify/",
        TokenVerifyView.as_view(),
        name="token_verify",
    ),
]
```

Configure token lifetimes:

```python
# settings.py

from datetime import timedelta

SIMPLE_JWT = {
    "ACCESS_TOKEN_LIFETIME": timedelta(minutes=10),
    "REFRESH_TOKEN_LIFETIME": timedelta(days=7),

    "ROTATE_REFRESH_TOKENS": True,
    "BLACKLIST_AFTER_ROTATION": True,

    "AUTH_HEADER_TYPES": ("Bearer",),
    "ALGORITHM": "HS256",

    # Use an independent environment secret in production.
    "SIGNING_KEY": env("JWT_SIGNING_KEY"),

    "ISSUER": "https://api.example.com",
    "AUDIENCE": "example-clients",
}
```

The exact lifetimes depend on the application’s risk level and user experience.

Examples:

| Application type | Access token | Refresh token |
|---|---:|---:|
| High-risk administrative application | 5–10 minutes | Hours or a few days |
| General business application | 10–30 minutes | Several days |
| Low-risk internal application | 30–60 minutes | Several days or weeks |

These are design examples, not universal security rules.

## Obtaining, refreshing, and verifying tokens

### Obtain a token pair

```bash
curl \
  -X POST \
  -H "Content-Type: application/json" \
  -d '{"username":"alice","password":"strong-password"}' \
  http://localhost:8000/api/token/
```

Response:

```json
{
  "refresh": "<refresh-token>",
  "access": "<access-token>"
}
```

### Call a protected endpoint

```bash
curl \
  -H "Authorization: Bearer <access-token>" \
  http://localhost:8000/api/profile/
```

### Refresh an access token

```bash
curl \
  -X POST \
  -H "Content-Type: application/json" \
  -d '{"refresh":"<refresh-token>"}' \
  http://localhost:8000/api/token/refresh/
```

Typical response:

```json
{
  "access": "<new-access-token>",
  "refresh": "<new-refresh-token-when-rotation-is-enabled>"
}
```

### Verify token format and signature

```bash
curl \
  -X POST \
  -H "Content-Type: application/json" \
  -d '{"token":"<token>"}' \
  http://localhost:8000/api/token/verify/
```

Token verification confirms that a token is structurally and cryptographically valid.

It does not by itself decide whether a particular user is authorized to access a resource.

## JWT logout and token blacklisting

JWT access tokens are normally valid until they expire.

To revoke refresh tokens, enable Simple JWT’s blacklist application.

```python
# settings.py

INSTALLED_APPS = [
    # ...
    "rest_framework_simplejwt.token_blacklist",
]
```

Run migrations:

```bash
python manage.py migrate
```

Add the blacklist endpoint:

```python
# urls.py

from django.urls import path
from rest_framework_simplejwt.views import TokenBlacklistView

urlpatterns = [
    path(
        "api/token/blacklist/",
        TokenBlacklistView.as_view(),
        name="token_blacklist",
    ),
]
```

Logout request:

```bash
curl \
  -X POST \
  -H "Content-Type: application/json" \
  -d '{"refresh":"<refresh-token>"}' \
  http://localhost:8000/api/token/blacklist/
```

### What happens after logout?

- The submitted refresh token becomes unusable.
- A previously issued access token may remain valid until it expires.
- Short access-token lifetimes reduce this remaining risk window.

This is a central JWT trade-off:

```text
No database lookup for every token
                |
                v
Fast and portable verification
                |
                v
Immediate access-token revocation becomes harder
```

Remove expired blacklist records regularly:

```bash
python manage.py flushexpiredtokens
```

Schedule this command through cron, a job scheduler, or your deployment platform.

## Custom JWT claims

Claims can carry limited identity or authorization context.

Example custom serializer:

```python
# serializers.py

from rest_framework_simplejwt.serializers import (
    TokenObtainPairSerializer,
)


class CustomTokenObtainPairSerializer(TokenObtainPairSerializer):
    @classmethod
    def get_token(cls, user):
        token = super().get_token(user)

        token["username"] = user.get_username()
        token["is_staff"] = user.is_staff

        return token
```

Custom view:

```python
# views.py

from rest_framework_simplejwt.views import TokenObtainPairView

from .serializers import CustomTokenObtainPairSerializer


class CustomTokenObtainPairView(TokenObtainPairView):
    serializer_class = CustomTokenObtainPairSerializer
```

URL:

```python
path(
    "api/token/",
    CustomTokenObtainPairView.as_view(),
    name="token_obtain_pair",
)
```

Use custom claims carefully.

Good claim examples:

- User identifier.
- Tenant identifier.
- Stable role name.
- Token version.
- Issuer and audience.

Avoid:

- Passwords.
- API secrets.
- Personal data not needed by the client.
- Large permission lists that change frequently.
- Data that must always reflect the latest database state.

> Claims can become stale until a new token is issued. Keep rapidly changing authorization decisions in permissions or the database.

## When to use JWT Authentication

Use JWT when:

- A separate SPA, mobile application, or desktop application consumes the API.
- Several backend services need to validate the same identity token.
- Short-lived access tokens and refresh tokens are useful.
- You need signed claims.
- The architecture benefits from portable credentials.

Avoid JWT by default when:

- A normal Django browser application already works well with sessions.
- Immediate revocation of every active request credential is mandatory.
- The additional token lifecycle complexity provides no real benefit.
- The team cannot safely implement storage, refresh, rotation, and logout behavior.

---

# 6. Protecting API Endpoints

A protected function-based view:

```python
from rest_framework.decorators import (
    api_view,
    permission_classes,
)
from rest_framework.permissions import IsAuthenticated
from rest_framework.response import Response


@api_view(["GET"])
@permission_classes([IsAuthenticated])
def profile(request):
    return Response(
        {
            "id": request.user.id,
            "username": request.user.get_username(),
        }
    )
```

A protected class-based view:

```python
from rest_framework.permissions import IsAuthenticated
from rest_framework.response import Response
from rest_framework.views import APIView


class ProfileView(APIView):
    permission_classes = [IsAuthenticated]

    def get(self, request):
        return Response(
            {
                "id": request.user.id,
                "username": request.user.get_username(),
            }
        )
```

A protected ViewSet:

```python
from rest_framework.permissions import IsAuthenticated
from rest_framework.viewsets import ModelViewSet

from .models import Project
from .serializers import ProjectSerializer


class ProjectViewSet(ModelViewSet):
    queryset = Project.objects.all()
    serializer_class = ProjectSerializer
    permission_classes = [IsAuthenticated]

    def get_queryset(self):
        return Project.objects.filter(owner=self.request.user)
```

Authentication identifies the user, while `get_queryset()` prevents users from reading other users’ records.

---

# 7. Global and Per-View Authentication

## Global configuration

```python
REST_FRAMEWORK = {
    "DEFAULT_AUTHENTICATION_CLASSES": [
        "rest_framework_simplejwt.authentication.JWTAuthentication",
    ],
}
```

Every DRF view uses this configuration unless it overrides it.

## Per-view configuration

```python
from rest_framework.authentication import SessionAuthentication
from rest_framework.permissions import IsAuthenticated
from rest_framework.views import APIView


class BrowserOnlyView(APIView):
    authentication_classes = [SessionAuthentication]
    permission_classes = [IsAuthenticated]
```

Function-based view:

```python
from rest_framework.authentication import TokenAuthentication
from rest_framework.decorators import (
    api_view,
    authentication_classes,
    permission_classes,
)
from rest_framework.permissions import IsAuthenticated


@api_view(["GET"])
@authentication_classes([TokenAuthentication])
@permission_classes([IsAuthenticated])
def token_only_view(request):
    ...
```

Use per-view overrides for intentional exceptions, not random configuration differences.

---

# 8. Multiple Authentication Classes

DRF can support more than one authentication scheme on an endpoint.

```python
REST_FRAMEWORK = {
    "DEFAULT_AUTHENTICATION_CLASSES": [
        "rest_framework.authentication.SessionAuthentication",
        "rest_framework_simplejwt.authentication.JWTAuthentication",
    ],
}
```

DRF tries the classes in order.

```text
Request
  |
  v
SessionAuthentication
  |
  +-- Authenticated? --> Stop
  |
  +-- Not attempted --> Try JWTAuthentication
                            |
                            +-- Authenticated? --> Stop
                            |
                            +-- No valid credentials --> Anonymous/deny
```

### Order matters

The first authentication class influences whether an unauthenticated denied request becomes `401 Unauthorized` or `403 Forbidden`.

In DRF:

- A successfully authenticated user without permission receives `403`.
- An unauthenticated request may receive `401` when the highest-priority authentication class uses a `WWW-Authenticate` header.
- Session Authentication commonly produces `403` for denied unauthenticated requests.

Do not mix schemes merely because it is possible. Support multiple schemes only when real clients require them.

A practical combination is:

- Session Authentication for internal staff using the browsable API.
- JWT Authentication for application clients.

---

# 9. Session vs Token vs JWT

| Feature | Session | DRF Token | JWT |
|---|---|---|---|
| Credential sent as | Cookie | `Authorization: Token` | `Authorization: Bearer` |
| Server-side state | Yes | Yes | Usually minimal for access-token validation |
| Database lookup | Session lookup | Token lookup | Depends on implementation and user resolution |
| Built into DRF | Yes | Yes | No; commonly Simple JWT |
| CSRF required | Yes for cookie-authenticated unsafe browser requests | Usually no | No for header tokens; yes when JWT is placed in cookies |
| Built-in expiration | Session expiry | No | Yes |
| Refresh token | No | No | Yes |
| Simple immediate revocation | Yes | Yes | Refresh-token blacklist; access token may survive until expiry |
| Best fit | Same-site web applications | Small/simple API clients | SPA, mobile, distributed APIs |
| Main complexity | Cookies and CSRF | Token lifecycle limitations | Storage, refresh, rotation, revocation |

## Conceptual comparison

```text
SESSION
Client cookie ---> Server session store ---> User
                    Server controls state

TOKEN
Client token ----> Token database row -----> User
                    Simple persistent key

JWT
Client JWT ------> Signature validation ----> Claims/User
                    Expiry built into token
```

---

# 10. Choosing the Right Approach

## Same Django website with an API

Choose **Session Authentication**.

Example:

```text
Django templates / same-site frontend
                |
                v
Session cookie + CSRF token
                |
                v
DRF API
```

Why:

- Existing Django login works naturally.
- Logout invalidates the session.
- Browsers manage cookies.
- CSRF protection is mature.

## Small internal API or basic mobile client

Choose **DRF Token Authentication** when requirements are intentionally simple.

Why:

- Minimal setup.
- Easy database-backed revocation.
- Easy to understand.

Reconsider when you need expiry, per-device tokens, or refresh flows.

## SPA, mobile app, or multi-service architecture

Choose **JWT**, commonly with Simple JWT.

Why:

- Standard Bearer-token flow.
- Access and refresh token separation.
- Built-in expiration.
- Portable signed claims.

Accept the additional responsibility for:

- Safe token storage.
- Refresh-token rotation.
- Logout and blacklisting.
- Key management.
- Token expiry handling.

## Decision tree

```mermaid
flowchart TD
    A[Who consumes the API?] --> B{Same-site Django browser app?}
    B -- Yes --> C[Session Authentication]
    B -- No --> D{Very simple internal or client API?}
    D -- Yes --> E[DRF Token Authentication]
    D -- No --> F{SPA, mobile, or multiple services?}
    F -- Yes --> G[JWT with Simple JWT]
    F -- No --> H[Review requirements before choosing]
```

---

# 11. Security Best Practices

## Use HTTPS everywhere

Session cookies, DRF tokens, and JWTs are bearer credentials.

Anyone who obtains a valid bearer credential may be able to use it.

Always use HTTPS outside local development.

## Keep authentication and permissions separate

```python
authentication_classes = [JWTAuthentication]
permission_classes = [IsAuthenticated]
```

Then enforce resource ownership:

```python
def get_queryset(self):
    return Invoice.objects.filter(customer=self.request.user)
```

Being authenticated must not imply access to every database record.

## Protect login and refresh endpoints

These endpoints are attractive attack targets.

Use:

- DRF throttling.
- Strong password policy.
- Login auditing.
- Suspicious activity monitoring.
- Multi-factor authentication where appropriate.
- Generic error messages that do not reveal whether a username exists.

## Use secure cookie settings for session-based deployments

```python
# settings.py

SESSION_COOKIE_SECURE = True
CSRF_COOKIE_SECURE = True
SESSION_COOKIE_HTTPONLY = True
SESSION_COOKIE_SAMESITE = "Lax"
CSRF_COOKIE_SAMESITE = "Lax"
```

Choose `SameSite`, domain, and cross-origin settings according to the actual deployment architecture.

## Handle JWT signing keys safely

Do not hard-code production signing keys.

```python
SIMPLE_JWT = {
    "SIGNING_KEY": env("JWT_SIGNING_KEY"),
}
```

Prefer a signing key independent from Django’s `SECRET_KEY`.

This allows JWT keys to be rotated without also changing unrelated Django cryptographic behavior.

## Use issuer and audience validation

```python
SIMPLE_JWT = {
    "ISSUER": "https://api.example.com",
    "AUDIENCE": "example-web-and-mobile-clients",
}
```

These claims reduce the chance that a valid token created for one system is accepted by another system unintentionally.

## Keep access tokens short-lived

An access token may remain usable until expiration even after its refresh token has been blacklisted.

Shorter access-token lifetimes reduce this window.

## Rotate refresh tokens

```python
SIMPLE_JWT = {
    "ROTATE_REFRESH_TOKENS": True,
    "BLACKLIST_AFTER_ROTATION": True,
}
```

The client must replace the old refresh token with the newly returned refresh token.

## Do not log secrets

Avoid logging:

- `Authorization` headers.
- Session cookies.
- Refresh tokens.
- Full access tokens.
- Passwords.

Sanitize request logging and application monitoring.

## Store browser tokens deliberately

There is no single storage design that fits every application.

Common approaches include:

### Access token in memory

- Reduces long-term persistence.
- Lost on page refresh unless renewed.
- Still exposed to successful script injection while the page is running.

### Refresh token in a secure HttpOnly cookie

- JavaScript cannot directly read the cookie.
- Browser sends it automatically.
- Requires appropriate CSRF and cookie configuration.

### Local storage

- Easy to implement.
- Readable by JavaScript.
- A successful XSS attack can steal stored tokens.

For security-sensitive browser applications, design storage together with:

- Content Security Policy.
- XSS prevention.
- CSRF protection.
- Short access-token lifetime.
- Refresh rotation.
- Secure and HttpOnly cookie settings.

## Do not put secrets inside JWT claims

JWT payloads are encoded, not hidden.

This is unsafe:

```json
{
  "user_id": 12,
  "password": "secret",
  "database_key": "..."
}
```

## Invalidate credentials when risk changes

Consider revocation or session termination after:

- Password change.
- Account deactivation.
- Role downgrade.
- Suspected credential theft.
- User-requested “log out from all devices.”

The implementation differs by authentication method.

---

# 12. Testing Authentication

## Test with DRF APIClient

### Force authentication

Useful when testing business behavior rather than the authentication mechanism itself.

```python
from django.contrib.auth import get_user_model
from rest_framework.test import APITestCase


User = get_user_model()


class ProfileTests(APITestCase):
    def setUp(self):
        self.user = User.objects.create_user(
            username="alice",
            password="strong-password",
        )

    def test_authenticated_user_can_read_profile(self):
        self.client.force_authenticate(user=self.user)

        response = self.client.get("/api/profile/")

        self.assertEqual(response.status_code, 200)
```

### Test token authentication

```python
from rest_framework.authtoken.models import Token
from rest_framework.test import APITestCase


class TokenProfileTests(APITestCase):
    def setUp(self):
        self.user = User.objects.create_user(
            username="alice",
            password="strong-password",
        )
        self.token = Token.objects.create(user=self.user)

    def test_token_header_authenticates_user(self):
        self.client.credentials(
            HTTP_AUTHORIZATION=f"Token {self.token.key}"
        )

        response = self.client.get("/api/profile/")

        self.assertEqual(response.status_code, 200)
```

### Test JWT authentication

```python
from rest_framework.test import APITestCase
from rest_framework_simplejwt.tokens import RefreshToken


class JWTProfileTests(APITestCase):
    def setUp(self):
        self.user = User.objects.create_user(
            username="alice",
            password="strong-password",
        )

    def test_access_token_authenticates_user(self):
        access_token = RefreshToken.for_user(self.user).access_token

        self.client.credentials(
            HTTP_AUTHORIZATION=f"Bearer {access_token}"
        )

        response = self.client.get("/api/profile/")

        self.assertEqual(response.status_code, 200)
```

> When creating JWTs manually, check that the user is active before issuing a token. `RefreshToken.for_user()` does not replace your account-status validation.

## Test unauthenticated behavior

```python
def test_anonymous_user_cannot_read_profile(self):
    response = self.client.get("/api/profile/")

    self.assertIn(response.status_code, [401, 403])
```

The exact status can depend on the configured authentication class and its order.

## Test authorization separately

```python
def test_user_cannot_read_another_users_project(self):
    self.client.force_authenticate(user=self.user)

    response = self.client.get(
        f"/api/projects/{self.other_users_project.id}/"
    )

    self.assertEqual(response.status_code, 404)
```

Filtering the queryset can return `404` instead of exposing that another user’s object exists.

---

# 13. Practical Project Structure

A maintainable authentication module might look like this:

```text
project/
├── config/
│   ├── settings.py
│   └── urls.py
│
├── apps/
│   ├── accounts/
│   │   ├── models.py
│   │   ├── serializers.py
│   │   ├── permissions.py
│   │   ├── services.py
│   │   ├── views.py
│   │   ├── urls.py
│   │   └── tests/
│   │       ├── test_login.py
│   │       ├── test_refresh.py
│   │       ├── test_logout.py
│   │       └── test_permissions.py
│   │
│   └── projects/
│       ├── models.py
│       ├── serializers.py
│       ├── views.py
│       └── permissions.py
│
└── manage.py
```

Suggested responsibilities:

| File | Responsibility |
|---|---|
| `serializers.py` | Validate login input and customize token response |
| `services.py` | Authentication-related business operations |
| `permissions.py` | Reusable access rules |
| `views.py` | HTTP request and response handling |
| `tests/` | Login, logout, expiry, refresh, and permission tests |

Avoid placing all authentication, authorization, and user-management logic in one large view.

---

# 14. Key Takeaways

- **Session Authentication** is usually the best fit for a same-site Django browser application.
- **DRF Token Authentication** is simple and database-backed, but has no built-in expiration or refresh-token flow.
- **JWT Authentication** provides signed, expiring access and refresh tokens but introduces more lifecycle and storage complexity.
- Authentication identifies the requester; permissions decide whether that requester may perform an action.
- Session-based unsafe requests require CSRF protection.
- A JWT payload is readable and must not contain secrets.
- Short-lived access tokens, refresh rotation, blacklisting, HTTPS, throttling, and secure key management are important production controls.
- Choose the simplest authentication design that satisfies the real client, security, and revocation requirements.

---

# References

Official documentation used for this guide:

- [Django REST Framework — Authentication](https://www.django-rest-framework.org/api-guide/authentication/)
- [Django REST Framework — Permissions](https://www.django-rest-framework.org/api-guide/permissions/)
- [Django REST Framework — Browsable API](https://www.django-rest-framework.org/topics/browsable-api/)
- [Django REST Framework — AJAX, CSRF, and CORS](https://www.django-rest-framework.org/topics/ajax-csrf-cors/)
- [Django REST Framework — Release Notes](https://www.django-rest-framework.org/community/release-notes/)
- [Simple JWT — Getting Started](https://django-rest-framework-simplejwt.readthedocs.io/en/stable/getting_started.html)
- [Simple JWT — Settings](https://django-rest-framework-simplejwt.readthedocs.io/en/stable/settings.html)
- [Simple JWT — Blacklist App](https://django-rest-framework-simplejwt.readthedocs.io/en/stable/blacklist_app.html)
- [Django — Sessions](https://docs.djangoproject.com/en/stable/topics/http/sessions/)
- [Django — CSRF Protection](https://docs.djangoproject.com/en/stable/ref/csrf/)
