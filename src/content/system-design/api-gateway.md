---
title: "API Gateway & BFF"
group: "Design Fundamentals"
order: 4
---

# API Gateway and the Backend for Frontend (BFF) Pattern

> Understand where an API Gateway and a Backend for Frontend fit in a modern system, how they differ, and how to use them together.

## In short

- An **API Gateway** is the shared public entry point in front of many services: route selection, TLS termination, token validation, rate limiting, edge protection, and central logging.
- A **BFF** is one backend per client type — web, mobile, admin — that aggregates several services into a single screen-shaped response for that client.
- The gateway is platform-owned and shared, so an outage is broad; a BFF is frontend-owned and client-specific, so its blast radius is one client experience.
- Edge authentication does not replace service authorization: the gateway answers "is this token valid?", the Order Service still answers "can `U123` read `ORD-101`?".
- A browser BFF can act as a confidential OAuth client, keeping tokens server-side and handing the browser only an `HttpOnly` session cookie — which then needs CSRF protection.
- Aggregation runs independent calls in parallel under a nested timeout budget (client > gateway > BFF > service), with dependencies split into required and optional so an optional failure degrades the page instead of failing it.
- Neither layer owns domain rules: pricing, stock reservation, and order state stay in the domain services.

```mermaid
sequenceDiagram
    participant W as Web App
    participant G as API Gateway
    participant B as Web BFF
    participant P as Product Service
    participant I as Inventory Service

    W->>G: GET /web/product-page/P100
    G->>G: Authenticate and rate-limit
    G->>B: Forward request
    par Fetch product
        B->>P: GET /products/P100
    and Fetch inventory
        B->>I: GET /inventory/P100
    end
    B->>B: Compose frontend response
    B-->>G: Product page model
    G-->>W: 200 OK
```

**Interview answer:** An API Gateway is a shared traffic-control layer — one public endpoint that routes to internal services and enforces cross-cutting policy such as TLS, token validation, rate limiting, and request size limits. A BFF sits behind it and is client-specific: it calls several domain services in parallel and composes exactly the response one frontend's screen needs, so mobile and web are not squeezed through the same generic contract. Neither holds business rules — the gateway manages traffic, the BFF manages shape, and domain services stay the source of truth.

**Gotcha:** Treating gateway authentication as authorization. Validating a JWT at the edge proves who the caller is, not that they may read this particular order — the gateway usually does not own the domain data needed for that decision, so every service must still enforce object-level access itself.

---

# 1. The Problem They Solve

A frontend in a microservice-based system rarely talks to only one backend service. A single product screen may need the Product, Pricing, Inventory, Review, Recommendation, and User services.

Without an intermediate layer, the frontend has to know the address and contract of every service, make many network calls, combine different response formats, handle authentication for each service, implement its own retries and failure handling, and change whenever an internal service changes.

```mermaid
flowchart LR
    WEB[Web Application]
    MOBILE[Mobile Application]

    WEB --> PRODUCT[Product Service]
    WEB --> PRICE[Pricing Service]
    WEB --> STOCK[Inventory Service]
    WEB --> REVIEW[Review Service]

    MOBILE --> PRODUCT
    MOBILE --> PRICE
    MOBILE --> STOCK
    MOBILE --> REVIEW
```

This creates strong coupling between frontend applications and internal microservices.

Two common patterns help solve this:

1. **API Gateway**: a shared entry point that controls and routes API traffic.
2. **Backend for Frontend (BFF)**: a client-specific backend that prepares data for one frontend experience.

They solve related problems, but they are not the same component.

---

# 2. API Gateway

An **API Gateway** is the entry point through which external clients access backend APIs.

Instead of exposing every microservice publicly, the system exposes the gateway.

```mermaid
flowchart LR
    CLIENT[Client] --> GW[API Gateway]
    GW --> USER[User Service]
    GW --> ORDER[Order Service]
    GW --> PAYMENT[Payment Service]
    GW --> CATALOG[Catalog Service]
```

The client sees one public API domain, `https://api.example.com`, and the gateway maps public routes to internal services:

```text
GET  /users/42          -> User Service
GET  /orders/ORD-101    -> Order Service
POST /payments          -> Payment Service
GET  /products          -> Catalog Service
```

## 2.1 Core Responsibilities

### Request Routing

The gateway selects the correct backend from the URL path, HTTP method, hostname, headers, API version, tenant, or geographic region. For example, `/api/v1/orders/*` routes to Order Service v1 while `/api/v2/orders/*` routes to v2.

### Authentication at the Edge

The gateway can validate API keys, OAuth access tokens, JWT signatures and standard claims, mTLS client certificates, and signed requests.

This rejects obviously invalid requests before they reach internal services.

> Authentication at the gateway does not remove the need for authorization inside backend services.

A service must still verify whether the authenticated user is allowed to access a specific resource.

### Rate Limiting and Quotas

Rate limiting protects the backend from accidental request bursts, abusive clients, brute-force attempts, denial-of-service pressure, and expensive API usage. Limits are usually keyed by IP address, user ID, API key, tenant ID, route, or subscription plan.

Example policy:

```text
Anonymous client:       20 requests/minute
Authenticated customer: 300 requests/minute
Internal partner:       5,000 requests/minute
```

### TLS Termination

The gateway commonly terminates external HTTPS connections and may create a new encrypted connection to internal services: `Client -- HTTPS --> Gateway -- HTTPS/mTLS --> Backend`.

### Request and Response Transformation

A gateway may perform small protocol-level transformations: adding a correlation ID, normalizing headers, removing internal headers, rewriting paths, converting a public hostname to an internal route, and applying basic schema validation.

Transformation should stay lightweight. Complex business-specific transformation normally belongs in a BFF or application service.

### Load Balancing and Traffic Management

A gateway may distribute requests across healthy service instances and support weighted routing, canary releases, blue-green deployments, region-based routing, header-based routing, and failover. A canary rule might send `95% traffic -> Checkout v1` and `5% traffic -> Checkout v2`.

### API Protection

A gateway can enforce edge controls such as a maximum request body size, an allowed HTTP method list, CORS policy, WAF rules, request schema validation, IP allowlists or blocklists, and bot and abuse protection.

### Logging and Metrics

The gateway provides a central place to measure request count, status codes, request latency, rejected requests, rate-limit events, backend response time, and route-level error rate.

## 2.2 API Gateway Request Flow

```mermaid
sequenceDiagram
    participant C as Client
    participant G as API Gateway
    participant A as Auth Provider
    participant S as Order Service

    C->>G: GET /orders/ORD-101 + access token
    G->>G: Validate route, limits, headers
    G->>A: Validate token or use cached keys
    A-->>G: Token valid
    G->>S: Forward authenticated request
    S-->>G: Order response
    G-->>C: 200 OK
```

In many deployments, JWT validation uses locally cached public keys, so the gateway does not call the identity provider for every request.

## 2.3 What Should Not Live in the Gateway

The gateway should not become a central business application. Keep out of it: pricing calculations, order state transitions, commission rules, inventory reservation logic, complex data aggregation, long-running workflows, database-backed domain logic, and client-specific screen composition.

A good rule is:

> The gateway manages traffic and cross-cutting policies; domain services manage business truth.

---

# 3. Backend for Frontend Pattern

A **Backend for Frontend** is a backend built for the needs of one frontend type or user experience.

Typical BFFs include a Web BFF, a Mobile BFF, an Admin Portal BFF, a Partner BFF, and a Smart TV BFF.

```mermaid
flowchart LR
    WEB[Web App] --> WBFF[Web BFF]
    MOBILE[Mobile App] --> MBFF[Mobile BFF]
    ADMIN[Admin Portal] --> ABFF[Admin BFF]

    WBFF --> PRODUCT[Product Service]
    WBFF --> ORDER[Order Service]
    WBFF --> USER[User Service]

    MBFF --> PRODUCT
    MBFF --> ORDER
    MBFF --> USER

    ABFF --> ORDER
    ABFF --> USER
    ABFF --> AUDIT[Audit Service]
```

## 3.1 Why Separate BFFs

Different clients often have different requirements.

| Client | What it typically needs |
|---|---|
| Desktop web | Detailed product information, large images, reviews, recommendations, multiple dashboard widgets |
| Mobile application | Smaller payloads, fewer round trips, compressed images, offline-friendly responses, backward compatibility for older app versions |
| Admin portal | Internal operational fields, audit data, search and filtering, bulk actions, elevated permissions |

Trying to serve every client through one general-purpose endpoint often produces large responses full of unused fields, too many client-side API calls, conditional logic based on client type, slow frontend development, and coupling between unrelated frontend teams.

A BFF lets each frontend evolve around its own use cases.

## 3.2 BFF Responsibilities

### Response Aggregation

The BFF can combine data from several services into one screen-oriented response. A single call to `GET /bff/product-page/P100` fans out internally:

```text
Product Service        -> product details
Pricing Service        -> current price
Inventory Service      -> availability
Review Service         -> rating summary
Recommendation Service -> related products
```

Client-facing response:

```json
{
  "product": {
    "id": "P100",
    "name": "Mechanical Keyboard",
    "price": 7499,
    "currency": "INR",
    "inStock": true,
    "rating": 4.6
  },
  "recommendations": [
    {
      "id": "P212",
      "name": "Wireless Mouse",
      "price": 2499
    }
  ]
}
```

The frontend receives exactly what the screen needs.

### Client-Specific Data Shaping

The BFF can rename fields, remove unnecessary ones, combine nested structures, format dates and currencies, convert service-oriented responses into view-oriented responses, and return mobile-friendly payloads.

### Reducing Network Round Trips

Without a BFF the frontend calls the Product, Price, Inventory, and Review services itself. With a BFF it makes one call, and the BFF fans out to those services in parallel and returns a combined response.

This is especially useful on high-latency mobile networks.

### Authentication Session Handling

For browser applications, a BFF can act as a confidential OAuth client:

- It performs OAuth/OIDC exchanges.
- It stores access and refresh tokens on the server side.
- The browser receives a secure session cookie instead of raw access tokens.
- The BFF attaches access tokens when calling downstream APIs.

The current IETF browser-based OAuth draft describes the BFF architecture as a strong browser security option. Because it is still an Internet-Draft, teams should track its final standardization and their identity provider's guidance.

### Frontend-Oriented Workflows

A BFF may coordinate a small client-facing workflow, such as:

1. Validate checkout input.
2. Create a draft order.
3. Request a payment session.
4. Return a frontend-ready checkout response.

The core rules still remain in domain services. The BFF coordinates calls but does not become the source of truth.

### Client Compatibility

A mobile BFF can support older app versions while backend services continue evolving. Keyed on a header such as `X-App-Version: 4.2.0`, the BFF may map a newer internal response to the older mobile contract.

## 3.3 What Should Not Live in a BFF

A BFF should not own reusable domain behavior such as final price calculation, ledger posting, payment settlement, stock reservation, eligibility decisions, order status rules, or customer master data. These rules belong in the relevant domain service.

A useful boundary: the BFF asks *what data does this screen need?*, the domain service asks *what is valid in the business?*

---

# 4. API Gateway vs BFF

| Area | API Gateway | Backend for Frontend |
|---|---|---|
| Primary purpose | Control and route API traffic | Serve one frontend experience |
| Scope | Shared across clients and services | Client-specific |
| Main owner | Platform or infrastructure team | Frontend-aligned product team |
| Typical logic | Routing, authentication, limits, TLS, policies | Aggregation, orchestration, data shaping |
| Business logic | Minimal | Minimal; orchestration only |
| Response design | Service/API oriented | Screen or use-case oriented |
| Deployment frequency | Usually controlled and stable | Can evolve with the frontend |
| Data source calls | Usually routes to one upstream | Often calls several upstream services |
| Authentication role | Validates credentials at the edge | May manage browser sessions and tokens |
| Scaling | Based on total API traffic | Based on traffic for one frontend |
| Failure impact | Can affect many APIs | Usually limited to one client experience |

The gateway is a **traffic control layer**.

The BFF is a **frontend adaptation layer**.

---

# 5. Using API Gateway and BFF Together

A mature system often uses both.

```mermaid
flowchart LR
    WEB[Web App] --> CDN[CDN / WAF]
    MOBILE[Mobile App] --> CDN
    ADMIN[Admin Portal] --> CDN

    CDN --> GW[API Gateway]

    GW --> WBFF[Web BFF]
    GW --> MBFF[Mobile BFF]
    GW --> ABFF[Admin BFF]

    WBFF --> CATALOG[Catalog Service]
    WBFF --> PRICE[Pricing Service]
    WBFF --> ORDER[Order Service]

    MBFF --> CATALOG
    MBFF --> PRICE
    MBFF --> ORDER

    ABFF --> ORDER
    ABFF --> USER[User Service]
    ABFF --> AUDIT[Audit Service]
```

Each layer owns a distinct set of responsibilities:

| Layer | Responsibilities |
|---|---|
| API Gateway | Public endpoint, TLS termination, authentication checks, rate limiting, WAF integration, route selection, request size limits, access logging, canary routing |
| BFF | Client-specific endpoints, API aggregation, response shaping, session handling, frontend compatibility, client-oriented orchestration |
| Domain service | Business validation, domain rules, data ownership, transactions, authorization for protected resources, event publication |

---

# 6. Practical E-Commerce Example

Consider an e-commerce platform with a React web application, Android and iOS applications, and an internal operations portal in front of the Catalog, Pricing, Inventory, Order, Payment, and Customer services.

## Web Product Page

`GET /web-bff/products/P100/page` returns everything the desktop page displays: product description, full image gallery, price and discount, delivery estimate, inventory, review summary, and recommendations.

## Mobile Product Page

`GET /mobile-bff/products/P100/page` returns only what the mobile screen needs: compact product details, one optimized image, price, basic stock status, and a small recommendation list.

Possible mobile response:

```json
{
  "id": "P100",
  "name": "Mechanical Keyboard",
  "thumbnail": "https://cdn.example.com/p100-480.webp",
  "price": 7499,
  "available": true,
  "recommended": [
    {
      "id": "P212",
      "name": "Wireless Mouse"
    }
  ]
}
```

The internal services remain the same. Only the client-facing composition changes.

## Admin Order View

The admin portal needs operational data not suitable for customers. `GET /admin-bff/orders/ORD-101/details` may return payment attempt history, fraud review state, inventory reservation, shipment events, customer support notes, and the audit trail.

These fields should not accidentally appear in customer-facing APIs. A separate admin BFF creates a clearer security and contract boundary.

---

# 7. Authentication and Security

## 7.1 Gateway Authentication

The gateway should commonly handle TLS, token signature validation, standard claim checks, API key validation, rate limiting, IP policies, request size limits, and basic schema validation.

Example JWT checks:

```text
signature is valid
issuer == expected identity provider
audience == expected API
expiration time is valid
token is not used before its valid time
required scope is present
```

## 7.2 Service-Level Authorization

The Order Service must still enforce:

> Can user U123 read order ORD-101?

The gateway cannot safely make every object-level authorization decision because it may not own the required domain data.

```mermaid
flowchart LR
    C[Client] --> G[Gateway: Is token valid?]
    G --> S[Order Service: Can this user access this order?]
    S --> DB[(Order Database)]
```

This separation helps address API risks such as broken authentication and broken object-level authorization.

## 7.3 Browser BFF Session Model

A browser-focused BFF can keep OAuth tokens away from browser JavaScript.

```mermaid
sequenceDiagram
    participant B as Browser
    participant F as BFF
    participant IDP as Identity Provider
    participant API as Resource API

    B->>F: Start login
    F->>IDP: Authorization request
    IDP-->>B: User login and consent
    B->>F: Authorization response
    F->>IDP: Exchange code using confidential client
    IDP-->>F: Access and refresh tokens
    F-->>B: Secure session cookie

    B->>F: API request + session cookie
    F->>API: Request + access token
    API-->>F: Protected data
    F-->>B: Frontend response
```

Recommended cookie properties normally include `HttpOnly`, `Secure`, `SameSite=Lax` or `SameSite=Strict` where compatible, a narrow `Path` and `Domain`, and an appropriate expiration.

Because cookies are automatically sent by the browser, the BFF must include CSRF protection where required.

## 7.4 Trust Between Internal Components

Common options include mTLS, workload identity, short-lived service tokens, private networks, signed internal requests, and service mesh identity.

Do not assume traffic is trusted only because it is inside a private network.

## 7.5 Propagating Identity

A BFF should pass only the identity context required by downstream services.

Example:

```http
Authorization: Bearer <downstream-access-token>
X-Correlation-ID: 8fbeb8ef-9b38-4dc9-a1af-8e9d1f6ce82d
```

Avoid trusting user-supplied identity headers such as `X-User-ID: admin`. The gateway should remove or overwrite protected internal headers.

---

# 8. Aggregation, Parallel Calls, and Partial Failure

A BFF often calls multiple services. Sequential calls increase latency.

## Sequential Calls

```text
Product Service:   100 ms
Pricing Service:    80 ms
Inventory Service: 120 ms
Review Service:     90 ms
--------------------------------
Approximate total: 390 ms + network overhead
```

## Parallel Calls

```text
Product Service:   100 ms
Pricing Service:    80 ms
Inventory Service: 120 ms
Review Service:     90 ms
--------------------------------
Approximate total: 120 ms + composition overhead
```

Independent requests should usually run concurrently.

## Example with Python and FastAPI

```python
import asyncio
from typing import Any

import httpx
from fastapi import FastAPI, HTTPException

app = FastAPI()

PRODUCT_URL = "http://product-service"
PRICE_URL = "http://pricing-service"
INVENTORY_URL = "http://inventory-service"

async def fetch_json(
    client: httpx.AsyncClient,
    url: str,
    *,
    required: bool = True,
) -> dict[str, Any] | None:
    try:
        response = await client.get(url)
        response.raise_for_status()
        return response.json()
    except (httpx.TimeoutException, httpx.HTTPError):
        if required:
            raise
        return None

@app.get("/web/products/{product_id}/page")
async def product_page(product_id: str) -> dict[str, Any]:
    timeout = httpx.Timeout(connect=0.3, read=1.0, write=0.5, pool=0.5)

    async with httpx.AsyncClient(timeout=timeout) as client:
        product_task = fetch_json(
            client,
            f"{PRODUCT_URL}/products/{product_id}",
            required=True,
        )
        price_task = fetch_json(
            client,
            f"{PRICE_URL}/prices/{product_id}",
            required=True,
        )
        inventory_task = fetch_json(
            client,
            f"{INVENTORY_URL}/inventory/{product_id}",
            required=False,
        )

        try:
            product, price, inventory = await asyncio.gather(
                product_task,
                price_task,
                inventory_task,
            )
        except httpx.HTTPError as exc:
            raise HTTPException(
                status_code=502,
                detail="Required upstream service failed",
            ) from exc

    return {
        "id": product["id"],
        "name": product["name"],
        "description": product["description"],
        "price": price["amount"],
        "currency": price["currency"],
        "availability": (
            inventory.get("status", "unknown")
            if inventory
            else "unknown"
        ),
    }
```

## Required vs Optional Dependencies

For a product page:

| Dependency | Importance | Failure handling |
|---|---|---|
| Product Service | Required | Fail the request |
| Pricing Service | Required | Fail or return controlled unavailable state |
| Inventory Service | Important | Return `unknown` if temporarily unavailable |
| Review Service | Optional | Hide the review section |
| Recommendation Service | Optional | Return an empty list |

This creates deliberate partial-failure behavior.

## Response Metadata for Partial Results

```json
{
  "product": {
    "id": "P100",
    "name": "Mechanical Keyboard"
  },
  "availability": "unknown",
  "recommendations": [],
  "warnings": [
    {
      "component": "inventory",
      "code": "TEMPORARILY_UNAVAILABLE"
    }
  ]
}
```

Do not expose internal stack traces, hostnames, or exception details.

---

# 9. Caching Strategy

Caching may exist at several layers.

```mermaid
flowchart LR
    C[Client Cache] --> CDN[CDN Cache]
    CDN --> GW[Gateway Cache]
    GW --> B[BFF Cache]
    B --> S[Service Cache]
    S --> DB[(Database)]
```

## Gateway or CDN Cache

Useful for public product catalog responses, static reference data, public configuration, and anonymous content. The cache key may include the HTTP method, path, query parameters, selected headers, tenant, and locale.

Be careful with personalized responses. A shared cache must not serve one user's data to another user.

## BFF Cache

Useful for client-composed data such as home-page sections, navigation configuration, feature flags, short-lived product summaries, and aggregated read models.

## Service Cache

The domain service is usually the best place to cache reusable business data, because it understands data freshness requirements, invalidation rules, authorization boundaries, and domain events.

## Cache-Control Example

```http
Cache-Control: public, max-age=60, stale-while-revalidate=30
```

For sensitive or user-specific responses: `Cache-Control: private, no-store`

---

# 10. Resilience and Performance

## 10.1 Timeouts

Every outbound call needs a timeout, and the budgets must nest: `Client timeout > Gateway timeout > BFF total timeout > Individual service timeout`.

Example budget:

```text
Client timeout:            5.0 seconds
Gateway timeout:           4.0 seconds
BFF request budget:        3.5 seconds
Required service timeout:  1.0 second
Optional service timeout:  0.5 second
```

Timeouts should leave enough time to return a controlled error.

## 10.2 Retries

Retry only when the operation is safe: a temporary connection failure, `502 Bad Gateway`, `503 Service Unavailable`, or `429 Too Many Requests` when `Retry-After` is respected. Use a small retry count, exponential backoff, jitter, and an overall deadline.

Do not blindly retry non-idempotent operations such as payment or order creation.

For retriable writes, use an idempotency key: `Idempotency-Key: 32ae3958-85ab-4e32-8404-28ef8a73b3c4`

## 10.3 Circuit Breaker

A circuit breaker temporarily stops calls to an unhealthy dependency.

```mermaid
stateDiagram-v2
    [*] --> Closed
    Closed --> Open: Failure threshold reached
    Open --> HalfOpen: Cooldown elapsed
    HalfOpen --> Closed: Probe succeeds
    HalfOpen --> Open: Probe fails
```

This prevents repeated slow failures from consuming all BFF resources.

## 10.4 Bulkheads

Separate resource pools for unrelated dependencies.

Example:

```text
Recommendation calls -> dedicated concurrency limit
Payment calls        -> separate concurrency limit
```

A slow recommendation service should not exhaust all connections needed for checkout.

## 10.5 Load Shedding

Under heavy traffic, protect core functionality by rejecting or reducing lower-priority work: disable recommendations, return cached reviews, reject expensive report generation, and preserve login, checkout, and payment capacity.

## 10.6 Payload Optimization

A BFF can reduce unused fields, image size, nested response depth, duplicate data, and the number of requests.

Compression such as Brotli or gzip is useful for text responses, but smaller response contracts are still important.

---

# 11. Scaling and Deployment

## 11.1 Stateless Components

Gateways and BFFs should normally be stateless so any instance can handle any request.

```mermaid
flowchart LR
    LB[Load Balancer] --> B1[BFF Instance 1]
    LB --> B2[BFF Instance 2]
    LB --> B3[BFF Instance 3]

    B1 --> REDIS[(Shared Session or Cache Store)]
    B2 --> REDIS
    B3 --> REDIS
```

If the BFF uses server-side sessions, store them in a shared system such as Redis or a managed session store rather than process memory.

## 11.2 Independent Scaling

Different clients may have different traffic patterns:

```text
Mobile BFF: 8,000 requests/second
Web BFF:    3,000 requests/second
Admin BFF:     50 requests/second
```

Separate BFFs can scale independently.

## 11.3 Deployment Ownership

A practical ownership model:

| Component | Typical owner |
|---|---|
| CDN, WAF, shared gateway | Platform team |
| Web BFF | Web product team |
| Mobile BFF | Mobile product team |
| Admin BFF | Internal tools team |
| Domain services | Domain-aligned backend teams |

The BFF should usually be deployed with or closely coordinated with its frontend contract.

## 11.4 Multi-Region Design

A global system may deploy CDN and WAF globally, with regional API gateways, regional BFF instances, regional service clusters, and replicated data stores where the domain permits.

```mermaid
flowchart TB
    U[Global Users] --> EDGE[Global DNS / CDN / WAF]

    EDGE --> G1[Gateway - India Region]
    EDGE --> G2[Gateway - Europe Region]

    G1 --> B1[BFF - India]
    G2 --> B2[BFF - Europe]

    B1 --> S1[Regional Services]
    B2 --> S2[Regional Services]
```

Routing must consider data residency, session affinity, replication delay, and failover behavior.

---

# 12. Observability

Because the gateway and BFF sit in the request path, weak observability makes failures difficult to diagnose.

## 12.1 Correlation and Trace Context

Create or propagate a request identifier:

```http
X-Request-ID: 8fbeb8ef-9b38-4dc9-a1af-8e9d1f6ce82d
traceparent: 00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01
```

Use the same trace across `Client -> Gateway -> BFF -> Product Service -> Database`.

## 12.2 Important Metrics

| Layer | Metrics worth alerting on |
|---|---|
| Gateway | Requests per route, authentication failures, rate-limit rejections, `4xx` and `5xx` rate, upstream connection failures, gateway latency, backend latency |
| BFF | Endpoint latency, upstream latency by service, aggregation failure rate, partial-response rate, timeout count, retry count, circuit-breaker state, cache hit ratio, active requests, connection-pool saturation |

## 12.3 Latency Percentiles

Do not rely only on average latency. Track `p50` for the typical request, `p95` for the slower user experience, and `p99` for tail latency and dependency issues.

For aggregated endpoints, one slow downstream dependency can dominate tail latency.

## 12.4 Structured Logs

Example:

```json
{
  "timestamp": "2026-08-03T06:25:00Z",
  "level": "INFO",
  "request_id": "8fbeb8ef-9b38-4dc9-a1af-8e9d1f6ce82d",
  "trace_id": "4bf92f3577b34da6a3ce929d0e0e4736",
  "route": "/web/products/{id}/page",
  "method": "GET",
  "status": 200,
  "duration_ms": 184,
  "upstreams": {
    "product_ms": 80,
    "pricing_ms": 66,
    "inventory_ms": 112
  }
}
```

Never log access tokens, session cookies, passwords, payment details, sensitive personal data, or full request bodies by default.

---

# 13. API Versioning and Contract Ownership

## Public Gateway Contract

The API Gateway exposes stable public routes such as `/api/v1/orders` and `/api/v2/orders`.

## BFF Contract

The BFF contract is owned by a specific frontend experience: `/web/v2/home`, `/mobile/v5/home`, `/admin/v1/order-search`.

A BFF contract can be screen-oriented, but avoid coupling it to minor UI component names that change frequently. Prefer `GET /mobile/v2/product-details/P100` over `GET /mobile/v2/right-side-card/P100`.

## Backward Compatibility

Mobile clients cannot always be upgraded immediately, so a mobile BFF may need to support several active app versions at once — for example Mobile 8.x on BFF contract v3, Mobile 7.x on v2, and Mobile 6.x with limited support.

Track usage before removing older contracts.

## Contract Validation

Use OpenAPI specifications, JSON Schema, consumer-driven contract tests, compatibility checks in CI/CD, and deprecation headers with documentation.

---

# 14. Testing Strategy

## Unit Tests

Test BFF composition logic: field mapping, optional service fallback, error translation, and version-specific response shaping.

## Integration Tests

Run the BFF against real test services, service emulators, containers, a test identity provider, and test gateway policies. Verify timeouts, headers, authentication context, and response contracts.

## Contract Tests

A BFF is a consumer of several services. Contract tests catch upstream changes such as the Pricing Service renaming `amount` to `value`, or the Inventory Service removing `availableQuantity`.

## End-to-End Tests

Test important flows through the real entry path (`Client -> Gateway -> BFF -> Services`): login, product page, checkout, order history, and admin order search.

## Resilience Tests

Test a slow downstream service, a `503` response, a timeout, a malformed response, partial dependency failure, circuit-breaker transitions, cache failure, and gateway rate limiting.

---

# 15. When to Use Each Pattern

## Use an API Gateway When

- Several services need one controlled public entry point.
- Authentication and rate limiting should be centralized.
- Services should not be directly exposed.
- Traffic splitting or canary routing is required.
- Central API monitoring and governance are important.
- Multiple protocols or upstream systems must be routed consistently.

## Use a BFF When

- Web, mobile, and admin clients need substantially different data.
- A screen requires aggregation from multiple services.
- Mobile latency and payload size matter.
- Frontend teams need independent API evolution.
- Browser tokens should be kept server-side.
- Client compatibility logic is becoming complex.

## Use Both When

- A system has multiple external clients and multiple internal services.
- Shared edge controls are required.
- Each client also needs tailored aggregation and contracts.

## A Simpler Design May Be Better When

- The application has one frontend.
- The backend is a small modular monolith.
- Most endpoints map directly to one backend operation.
- There is little client-specific transformation.
- Operational capacity for extra services is limited.

Possible simple architecture:

```mermaid
flowchart LR
    CLIENT[Single Client] --> APP[Application Backend]
    APP --> DB[(Database)]
```

Patterns should reduce complexity, not add components without a clear need.

---

# 16. Design Checklist

## API Gateway

- [ ] Are public routes clearly defined?
- [ ] Are TLS and security headers configured?
- [ ] Are authentication tokens validated?
- [ ] Are protected internal headers overwritten?
- [ ] Are rate limits defined by user, client, tenant, or route?
- [ ] Are request size and timeout limits configured?
- [ ] Are access logs and metrics enabled?
- [ ] Is canary or rollback routing available?
- [ ] Are backend services private where possible?
- [ ] Is service-level authorization still enforced?

## BFF

- [ ] Is the BFF aligned with one frontend or experience?
- [ ] Does it return only client-relevant data?
- [ ] Are independent service calls parallelized?
- [ ] Are required and optional dependencies identified?
- [ ] Are timeouts and deadlines explicit?
- [ ] Are retries limited to safe operations?
- [ ] Are partial failures handled deliberately?
- [ ] Is core business logic kept in domain services?
- [ ] Are tokens and session cookies handled securely?
- [ ] Are contracts versioned and tested?
- [ ] Are trace IDs propagated?
- [ ] Can the BFF scale horizontally?

## Before Adding Either Layer

- [ ] Do the clients differ *meaningfully* in the data they need, rather than merely being built with different frontend technologies?
- [ ] Would a single backend still be the clearest and most maintainable design at this system's size?
- [ ] Is there operational capacity to run, monitor, and release the extra components?

---
