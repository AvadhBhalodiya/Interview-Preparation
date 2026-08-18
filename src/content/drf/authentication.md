---
title: "Authentication"
group: "Auth & Permissions"
order: 3
---

# DRF Authentication: Session, Token, and JWT

> Authentication answers **“Who is making this request?”**
>
> Permissions answer **“Is this authenticated user allowed to perform this action?”**

## In short

- DRF runs authentication **before** permissions. An authentication class either sets `request.user` and `request.auth`, or leaves `AnonymousUser` — it never decides access; permission classes do.
- **Session** authentication is a cookie plus a server-side session. It fits a same-site Django browser app, and unsafe methods (`POST`, `PUT`, `PATCH`, `DELETE`) then require a CSRF token.
- **DRF Token** authentication is one long-lived database row per user, sent as `Authorization: Token <key>`. No expiry, no refresh; revocation is deleting the row.
- **JWT** (Simple JWT) sends a short-lived signed access token as `Authorization: Bearer <token>` alongside a longer-lived refresh token. Expiry is built into the token; immediate revocation is not.
- `DEFAULT_AUTHENTICATION_CLASSES` sets the scheme globally, `authentication_classes` overrides it per view. Several classes are tried in order and the first one that authenticates wins.
- `401` vs `403` is decided by the *first* authentication class: DRF returns `401` only when that class supplies a `WWW-Authenticate` header, so `SessionAuthentication` denials surface as `403`.
- Being authenticated is not being authorized to a row. Scope `get_queryset()` by user or tenant as well.

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

**Interview answer:** DRF ships three practical schemes and they differ in where the state lives. Session authentication keeps the state on the server and the key in a cookie, so it is the natural fit when Django already renders the site — at the cost of CSRF handling. DRF's own `TokenAuthentication` is a single database-backed key per user: trivial to set up and to revoke, but with no expiry, no refresh, and no per-device separation. JWT via Simple JWT moves the state into a signed, expiring token that any service can verify without a lookup, which is what a SPA, a mobile client, or a multi-service backend needs — and the price is that you now own storage, refresh, rotation, and blacklisting.

**Gotcha:** Treating a JWT "logout" endpoint as if it ended the session. Blacklisting invalidates the **refresh** token; the access token already in the client's hands keeps working until its `exp`. That window is why access-token lifetimes are kept short.

---

# 1. Authentication in DRF

Django REST Framework runs authentication before permission checks and before the main view logic.

A successful authentication class normally sets `request.user` and `request.auth`. A view then uses permission classes such as `IsAuthenticated` to decide whether the request is allowed.

## Authentication request flow

```mermaid
flowchart TD
    A[Incoming request] --> B[Authentication class<br/>checks credentials]
    B -->|Credentials valid| C["Set request.user/request.auth"]
    B -->|No credentials| D[Continue as AnonymousUser]
    B -->|Invalid credentials| E[Raise AuthenticationFailed]
    C --> F[Permission classes check access]
    D --> F
    F -->|Allowed| G[Execute view]
    F -->|Denied| H[Return 401 or 403]
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

Authentication only identifies the requester. It does not automatically guarantee that the requester can access every endpoint — that is what a view's `permission_classes` decides.

Common permission classes:

| Permission class | Meaning |
|---|---|
| `AllowAny` | Authentication is not required |
| `IsAuthenticated` | Any authenticated user is allowed |
| `IsAdminUser` | Only users with `is_staff=True` |
| `IsAuthenticatedOrReadOnly` | Anonymous users can read; authenticated users can write |

---

# 2. Common Project Setup

Install Django REST Framework: `python -m pip install djangorestframework`

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

This makes endpoints private by default. Public endpoints must then explicitly opt out with `permission_classes = [AllowAny]`.

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

The client sends the token on every request: `Authorization: Token 0123456789abcdef...`

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

Run migrations: `python manage.py migrate`

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

Route it with `path("auth/token/login/", CustomAuthTokenView.as_view())`.

You can also manage tokens from the command line:

```bash
python manage.py drf_create_token alice       # create
python manage.py drf_create_token -r alice    # regenerate an existing token
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

## What you need to know about the format

The JWT format itself — structure, claim validation, algorithm choice, revocation strategies, and browser storage — is covered in [JWT Pitfalls](../security/jwt-pitfalls.md). The five points that matter for the DRF wiring below:

- A JWT is `header.payload.signature`, Base64URL-**encoded, not encrypted**: anyone holding it can read every claim, so nothing secret goes into a Simple JWT claim.
- The signature only proves the token was not modified. Issuer, audience, token type, and expiry still have to be validated — Simple JWT does this for you when `ISSUER`, `AUDIENCE`, and `ALGORITHM` are configured.
- Verification needs no database lookup, which is what makes JWT portable across services and what makes revoking a live access token hard.
- Expiry is carried inside the token as `exp`, so a JWT expires without the server tracking it.
- Simple JWT's own claims include `user_id`, `token_type`, `exp`, `iat`, and `jti`; the `jti` is what the blacklist application keys on.

The rest of this section is `djangorestframework-simplejwt` specifically.

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

Install Simple JWT: `python -m pip install "djangorestframework-simplejwt[crypto]"`

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

```bash
# Obtain a pair -> {"refresh": "<refresh-token>", "access": "<access-token>"}
curl -X POST -H "Content-Type: application/json" \
  -d '{"username":"alice","password":"strong-password"}' \
  http://localhost:8000/api/token/

# Call a protected endpoint
curl -H "Authorization: Bearer <access-token>" http://localhost:8000/api/profile/

# Refresh -> {"access": "<new-access-token>"} plus a new "refresh" when rotation is on
curl -X POST -H "Content-Type: application/json" \
  -d '{"refresh":"<refresh-token>"}' \
  http://localhost:8000/api/token/refresh/

# Verify signature and structure only
curl -X POST -H "Content-Type: application/json" \
  -d '{"token":"<token>"}' \
  http://localhost:8000/api/token/verify/
```

`TokenVerifyView` confirms that a token is structurally and cryptographically valid. It does not by itself decide whether a particular user is authorized to access a resource.

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

Run migrations: `python manage.py migrate`

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

```bash
# Logout: blacklist a refresh token
curl -X POST -H "Content-Type: application/json" \
  -d '{"refresh":"<refresh-token>"}' \
  http://localhost:8000/api/token/blacklist/

# Housekeeping: drop expired blacklist rows. Run this on a schedule.
python manage.py flushexpiredtokens
```

After this call, the submitted refresh token is unusable, but an access token already issued from it stays valid until its `exp` — which is why access-token lifetimes are kept short. [JWT Pitfalls](../security/jwt-pitfalls.md) covers the stronger revocation strategies (`jti` denylists, session versioning, introspection) when that window is unacceptable.

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

Register it in place of `TokenObtainPairView` at the same `api/token/` path, keeping `name="token_obtain_pair"`.

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

The same protection, written as a function-based view and as a class-based view:

```python
from rest_framework.decorators import api_view, permission_classes
from rest_framework.permissions import IsAuthenticated
from rest_framework.response import Response
from rest_framework.views import APIView

@api_view(["GET"])
@permission_classes([IsAuthenticated])
def profile(request):
    return Response({"id": request.user.id, "username": request.user.get_username()})

class ProfileView(APIView):
    permission_classes = [IsAuthenticated]

    def get(self, request):
        return Response({"id": request.user.id, "username": request.user.get_username()})
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

```mermaid
flowchart TD
    A[Request] --> B[SessionAuthentication]
    B --> C{Authenticated?}
    C -->|Yes| D[Stop and use this identity]
    C -->|Not attempted| E[Try JWTAuthentication]
    E --> F{Authenticated?}
    F -->|Yes| D
    F -->|No valid credentials| G["Anonymous/deny"]
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

```mermaid
flowchart LR
    subgraph SESS[Session]
        SC[Client cookie] --> SS[(Server session store<br/>Server controls state)]
        SS --> SU[User]
    end
    subgraph TOK[DRF Token]
        TC[Client token] --> TR[(Token database row<br/>Simple persistent key)]
        TR --> TU[User]
    end
    subgraph JWT[JWT]
        JC[Client JWT] --> JV[Signature validation<br/>Expiry built into token]
        JV --> JU["Claims/User"]
    end
```

---

# 10. Choosing the Right Approach

## Same Django website with an API

Choose **Session Authentication**.

Example:

```mermaid
flowchart TD
    A["Django templates / same-site frontend"] --> B["Session cookie + CSRF token"]
    B --> C[DRF API]
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

The decision tree covering all three is in **In short** at the top of this note.

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

# ...then enforce resource ownership in the view:
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

## Configure `SIMPLE_JWT` defensively

```python
SIMPLE_JWT = {
    # Never hard-code the key, and keep it independent of Django's SECRET_KEY
    # so JWT keys can rotate without disturbing unrelated Django cryptography.
    "SIGNING_KEY": env("JWT_SIGNING_KEY"),

    # Reduce the chance that a token minted for one system is accepted by another.
    "ISSUER": "https://api.example.com",
    "AUDIENCE": "example-web-and-mobile-clients",

    # The client must replace the old refresh token with the newly returned one.
    "ROTATE_REFRESH_TOKENS": True,
    "BLACKLIST_AFTER_ROTATION": True,
}
```

## Keep access tokens short-lived

An access token may remain usable until expiration even after its refresh token has been blacklisted. Shorter access-token lifetimes reduce this window.

## Do not log secrets

Avoid logging:

- `Authorization` headers.
- Session cookies.
- Refresh tokens.
- Full access tokens.
- Passwords.

Sanitize request logging and application monitoring.

## Store browser tokens deliberately

There is no single storage design that fits every application: an in-memory access token is lost on refresh, `localStorage` is readable by any successful XSS, and an `HttpOnly` cookie closes that but then needs CSRF handling. The full comparison, the backend-for-frontend pattern, and the rule that nothing secret belongs in a claim are in [JWT Pitfalls](../security/jwt-pitfalls.md).

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

`APIClient` offers three ways to authenticate a request. `force_authenticate()` bypasses the scheme entirely and is what you want when the test is about business behavior, not about the credential; `credentials()` sets a real header and therefore exercises the authentication class itself.

```python
from django.contrib.auth import get_user_model
from rest_framework.authtoken.models import Token
from rest_framework.test import APITestCase
from rest_framework_simplejwt.tokens import RefreshToken

User = get_user_model()

class ProfileTests(APITestCase):
    def setUp(self):
        self.user = User.objects.create_user(
            username="alice",
            password="strong-password",
        )

    def test_force_authenticate_bypasses_the_scheme(self):
        self.client.force_authenticate(user=self.user)
        self.assertEqual(self.client.get("/api/profile/").status_code, 200)

    def test_token_header_authenticates_user(self):
        token = Token.objects.create(user=self.user)
        self.client.credentials(HTTP_AUTHORIZATION=f"Token {token.key}")
        self.assertEqual(self.client.get("/api/profile/").status_code, 200)

    def test_access_token_authenticates_user(self):
        access_token = RefreshToken.for_user(self.user).access_token
        self.client.credentials(HTTP_AUTHORIZATION=f"Bearer {access_token}")
        self.assertEqual(self.client.get("/api/profile/").status_code, 200)
```

> When creating JWTs manually, check that the user is active before issuing a token. `RefreshToken.for_user()` does not replace your account-status validation.

## Test unauthenticated and unauthorized behavior separately

```python
def test_anonymous_user_cannot_read_profile(self):
    response = self.client.get("/api/profile/")
    # 401 or 403 depending on the configured authentication class and its order.
    self.assertIn(response.status_code, [401, 403])

def test_user_cannot_read_another_users_project(self):
    self.client.force_authenticate(user=self.user)
    response = self.client.get(f"/api/projects/{self.other_users_project.id}/")
    # A filtered queryset returns 404 rather than revealing the object exists.
    self.assertEqual(response.status_code, 404)
```

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
