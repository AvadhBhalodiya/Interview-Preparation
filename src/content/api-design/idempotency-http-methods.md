---
title: "Idempotency (HTTP)"
group: "REST Fundamentals"
order: 2
---

# Idempotency: Which HTTP Methods Are Idempotent?

> **Topic:** API Design & REST  
> **Level:** Intermediate developer (3+ years)  
> **Last reviewed:** July 2026  
> **Primary standards:** RFC 9110, RFC 5789, RFC 10008, IANA HTTP Method Registry

---

## Index

1. [What Is Idempotency?](#1-what-is-idempotency)
2. [Why Idempotency Matters in APIs](#2-why-idempotency-matters-in-apis)
3. [Safe vs Idempotent Methods](#3-safe-vs-idempotent-methods)
4. [HTTP Method Idempotency Matrix](#4-http-method-idempotency-matrix)
5. [Understanding Each HTTP Method](#5-understanding-each-http-method)
6. [Idempotent Method vs Idempotent Operation](#6-idempotent-method-vs-idempotent-operation)
7. [Making POST and PATCH Retry-Safe](#7-making-post-and-patch-retry-safe)
8. [Idempotency-Key Processing Flow](#8-idempotency-key-processing-flow)
9. [Database Design for Idempotency](#9-database-design-for-idempotency)
10. [Idempotency and Concurrent Requests](#10-idempotency-and-concurrent-requests)
11. [Idempotency and Optimistic Concurrency](#11-idempotency-and-optimistic-concurrency)
12. [Retry Strategy for REST Clients](#12-retry-strategy-for-rest-clients)
13. [Practical API Design Examples](#13-practical-api-design-examples)
14. [Testing Idempotency](#14-testing-idempotency)
15. [Important Design Distinctions](#15-important-design-distinctions)
16. [Best-Practice Checklist](#16-best-practice-checklist)
17. [Quick Revision Summary](#17-quick-revision-summary)
18. [References](#18-references)

---

# 1. What Is Idempotency?

An operation is **idempotent** when performing the same operation multiple times has the same **intended final effect on the server** as performing it once.

In simple terms:

```text
One identical request      -> Final state X
Ten identical requests     -> Final state X
```

A mathematical way to remember it is:

```text
f(f(x)) = f(x)
```

The second execution does not produce an additional intended state change beyond the first execution.

## 1.1 Simple Example

Suppose a user currently has this status:

```json
{
  "id": 42,
  "status": "inactive"
}
```

The following operation sets the status to `active`:

```http
PUT /users/42/status
Content-Type: application/json

{
  "status": "active"
}
```

Whether the request is sent once or five times, the intended final state remains:

```json
{
  "id": 42,
  "status": "active"
}
```

Therefore, this operation is idempotent.

## 1.2 Non-Idempotent Example

Consider an endpoint that adds ₹500 to a wallet:

```http
POST /wallets/42/credits
Content-Type: application/json

{
  "amount": 500
}
```

Repeated requests may produce repeated credits:

```text
Initial balance      = ₹1,000
After first request  = ₹1,500
After second request = ₹2,000
After third request  = ₹2,500
```

The final state changes with every execution, so the operation is not naturally idempotent.

---

# 2. Why Idempotency Matters in APIs

Distributed systems regularly experience uncertain outcomes:

- The client sends a request.
- The server successfully processes it.
- The response is lost because of a timeout, broken connection, proxy failure, or client crash.
- The client does not know whether the operation succeeded.
- The client retries the request.

```text
Client                         Server
  |                               |
  |------ Create payment -------->|
  |                               | Payment created
  |<----- Response lost -------- X|
  |                               |
  |------ Retry request --------->|
  |                               |
```

Without idempotency, the retry could create:

- A duplicate payment
- A duplicate order
- A duplicate booking
- A duplicate message
- A repeated inventory reduction
- A webhook processed multiple times

Idempotency makes retries safer and improves the reliability of APIs running over imperfect networks.

## 2.1 Main Benefits

Idempotency helps with:

- Automatic client retries
- Load balancer and proxy retries
- Mobile applications with unstable networks
- Payment and checkout flows
- Webhook processing
- Message-driven systems with at-least-once delivery
- Job processing and background workers
- Recovery after service crashes

---

# 3. Safe vs Idempotent Methods

**Safe** and **idempotent** are related but different HTTP properties.

## 3.1 Safe Method

A safe method is intended to be read-only. The client does not request a state change on the target resource.

Examples include:

- `GET`
- `HEAD`
- `OPTIONS`
- `TRACE`
- `QUERY`

A server may still perform incidental work such as logging, metrics collection, cache population, or billing an advertisement account. These side effects do not change the method's defined semantics because the client did not request them.

## 3.2 Idempotent Method

An idempotent method may change server state, but repeating the same request has the same intended effect as sending it once.

Examples include:

- `PUT`
- `DELETE`

These methods are not safe because they request state changes, but they are idempotent.

## 3.3 Relationship

```text
                 HTTP Method Properties

                  +------------------+
                  |   Idempotent      |
                  |                  |
                  |  PUT   DELETE    |
      +-----------+------------------+
      | Safe and Idempotent          |
      |                              |
      | GET  HEAD  OPTIONS  TRACE    |
      | QUERY                        |
      +------------------------------+

Non-idempotent by specification:
POST, PATCH, CONNECT
```

A useful rule is:

> Every safe HTTP method is idempotent, but every idempotent method is not necessarily safe.

---

# 4. HTTP Method Idempotency Matrix

The following table covers the commonly discussed HTTP methods.

| HTTP Method | Safe? | Idempotent? | Typical Purpose |
|---|---:|---:|---|
| `GET` | Yes | Yes | Retrieve a resource or collection |
| `HEAD` | Yes | Yes | Retrieve response headers without response content |
| `OPTIONS` | Yes | Yes | Discover communication options or allowed methods |
| `TRACE` | Yes | Yes | Perform a diagnostic loop-back request |
| `QUERY` | Yes | Yes | Perform a safe query using request content |
| `PUT` | No | Yes | Create or fully replace a resource at a known URI |
| `DELETE` | No | Yes | Remove a resource |
| `POST` | No | No | Perform resource-specific processing, often create a subordinate resource |
| `PATCH` | No | No | Apply partial modifications to a resource |
| `CONNECT` | No | No | Establish a network tunnel |

## 4.1 Core Interview Answer

The traditional answer is:

```text
Idempotent:
GET, HEAD, PUT, DELETE, OPTIONS, TRACE

Not guaranteed to be idempotent:
POST, PATCH, CONNECT
```

As of June 2026, the standardized `QUERY` method is also explicitly **safe and idempotent**.

> In normal REST application development, the methods most frequently discussed are `GET`, `POST`, `PUT`, `PATCH`, and `DELETE`.

---

# 5. Understanding Each HTTP Method

## 5.1 GET — Idempotent and Safe

`GET` retrieves a representation of a resource.

```http
GET /users/42
```

Repeating the request does not ask the server to modify the user.

```text
GET /users/42  -> Read user
GET /users/42  -> Read user again
GET /users/42  -> Read user again
```

### Important Detail

Idempotency does **not** mean every response must be identical.

For example:

```http
GET /stock-prices/ABC
```

The response may change because the underlying stock price changed between requests. The request is still idempotent because the client only requested retrieval; it did not request an additional state change.

Similarly, response headers such as `Date`, rate-limit counters, request IDs, and cache metadata may differ.

### Correct Resource Design

Use:

```http
GET /orders/123
```

Avoid unsafe actions through `GET`:

```http
GET /orders/123/cancel
GET /users/42/delete
```

Search engines, browsers, link preview tools, and caches may automatically issue `GET` requests. A `GET` endpoint should therefore not perform a client-requested destructive action.

---

## 5.2 HEAD — Idempotent and Safe

`HEAD` has semantics similar to `GET`, but the response does not include response content.

```http
HEAD /documents/report.pdf
```

Possible response:

```http
HTTP/1.1 200 OK
Content-Type: application/pdf
Content-Length: 804250
ETag: "report-v7"
Last-Modified: Thu, 30 Jul 2026 08:15:00 GMT
```

Typical uses:

- Check whether a resource exists
- Inspect metadata
- Validate an `ETag`
- Check content size
- Check modification time
- Avoid downloading the complete representation

Repeated `HEAD` requests do not request a state change, so the method is safe and idempotent.

---

## 5.3 PUT — Idempotent but Not Safe

`PUT` creates or replaces the state of a resource at a known URI.

```http
PUT /users/42
Content-Type: application/json

{
  "name": "Aarav",
  "email": "aarav@example.com",
  "status": "active"
}
```

Repeating the identical request produces the same intended resource state:

```text
Request 1 -> User 42 has representation X
Request 2 -> User 42 still has representation X
Request 3 -> User 42 still has representation X
```

### Why PUT Is Not Safe

It changes server state by creating or replacing a resource.

### Full Replacement Semantics

Conceptually, `PUT` means:

```text
Make the resource at this URI match this representation.
```

For partial updates, `PATCH` is usually more semantically appropriate.

### Create at a Client-Known URI

`PUT` can also be used for creation when the client knows the final resource URI:

```http
PUT /user-settings/user-42
```

The first request may create the resource. Repeated identical requests replace it with the same state.

---

## 5.4 DELETE — Idempotent but Not Safe

`DELETE` requests removal of a resource.

```http
DELETE /users/42
```

Possible responses:

```text
First request  -> 204 No Content
Second request -> 404 Not Found
Third request  -> 404 Not Found
```

The status codes can differ, but the intended final state is the same:

```text
User 42 does not exist.
```

Therefore, `DELETE` is idempotent.

### Soft Delete Example

A soft-delete implementation may set:

```json
{
  "deleted": true,
  "deleted_at": "2026-07-30T10:30:00Z"
}
```

For clean idempotent behavior, repeated deletion should not continuously change meaningful resource state. For example, it should not keep generating new deletion records or repeatedly decrement an active-user counter without protection.

### External Side Effects

Deleting a user may trigger cleanup jobs, emails, audit logs, or events. These should also be designed to avoid unintended duplicate business actions when the delete request is retried.

---

## 5.5 OPTIONS — Idempotent and Safe

`OPTIONS` asks for communication options supported by a resource or server.

```http
OPTIONS /users/42
```

Possible response:

```http
HTTP/1.1 204 No Content
Allow: GET, PUT, PATCH, DELETE, OPTIONS
```

Browsers also use `OPTIONS` for CORS preflight requests.

```http
OPTIONS /payments
Origin: https://frontend.example.com
Access-Control-Request-Method: POST
Access-Control-Request-Headers: content-type, authorization
```

It is safe and idempotent because it requests capability information rather than a resource state change.

---

## 5.6 TRACE — Idempotent and Safe by Semantics

`TRACE` performs a diagnostic loop-back of the request message.

```http
TRACE /diagnostics
```

It is defined as safe and idempotent, but many production servers disable it because it can expose request information and increase security risk.

For REST API interviews, remember its method property, but in normal application development it is rarely used.

---

## 5.7 QUERY — Idempotent and Safe

`QUERY` was standardized in RFC 10008 in June 2026.

It allows a client to send query input in the request content while preserving explicit safe and idempotent semantics.

```http
QUERY /products/search
Content-Type: application/json

{
  "categories": ["laptops", "monitors"],
  "price": {
    "min": 30000,
    "max": 150000
  },
  "sort": "rating_desc"
}
```

It addresses cases where:

- A query is too large or complex for a URL
- A request body is useful
- `POST` would hide the fact that the operation is read-only
- Safe retries and query-response caching are desirable

### QUERY Compared with GET and POST

| Property | `GET` | `QUERY` | `POST` |
|---|---:|---:|---:|
| Safe | Yes | Yes | No by default |
| Idempotent | Yes | Yes | No by default |
| Query input in request content | No defined general semantics | Yes | Yes |
| Intended for state-changing processing | No | No | Possibly |

### Practical Adoption Note

Although `QUERY` is now standardized, API frameworks, gateways, browsers, proxies, SDKs, and observability tools may require time or configuration to support it consistently. Check your complete infrastructure before adopting it in a public API.

---

## 5.8 POST — Not Idempotent by Specification

`POST` asks the target resource to perform resource-specific processing.

It is commonly used to create a new subordinate resource:

```http
POST /orders
Content-Type: application/json

{
  "customer_id": 42,
  "product_id": 1001,
  "quantity": 2
}
```

Repeated requests may create multiple orders:

```text
Request 1 -> Order 501 created
Request 2 -> Order 502 created
Request 3 -> Order 503 created
```

Therefore, `POST` is not guaranteed to be idempotent.

### POST Can Be Implemented Idempotently

This endpoint could be made retry-safe through an idempotency key:

```http
POST /orders
Idempotency-Key: 6f904c38-0470-4e9d-85f9-3aa179a7b403
Content-Type: application/json

{
  "customer_id": 42,
  "product_id": 1001,
  "quantity": 2
}
```

Repeated requests with the same key and same request payload return the previously stored result instead of creating another order.

The important distinction is:

```text
POST method semantics       -> Not idempotent by default
Specific POST endpoint      -> Can be designed to behave idempotently
```

---

## 5.9 PATCH — Not Idempotent by Specification

`PATCH` applies partial modifications to a resource.

It is not guaranteed to be idempotent because the patch document may describe either a target state or a relative change.

### Non-Idempotent PATCH

```http
PATCH /products/1001
Content-Type: application/json

{
  "increment_stock_by": 5
}
```

Repeated execution changes the state every time:

```text
Initial stock       = 10
After first PATCH   = 15
After second PATCH  = 20
After third PATCH   = 25
```

### Idempotent PATCH Implementation

```http
PATCH /products/1001
Content-Type: application/merge-patch+json

{
  "stock": 15
}
```

Repeating this patch may keep the final stock at `15`.

However, the HTTP `PATCH` method itself remains classified as non-idempotent because not every valid patch operation has idempotent semantics.

### Patch Format Matters

A JSON Patch operation such as:

```json
[
  { "op": "replace", "path": "/status", "value": "active" }
]
```

can behave idempotently.

An operation such as adding an item to an array may not:

```json
[
  { "op": "add", "path": "/tags/-", "value": "featured" }
]
```

Repeated requests may append `featured` multiple times unless the application adds deduplication rules.

---

## 5.10 CONNECT — Not Idempotent and Not Safe

`CONNECT` establishes a tunnel to a server, commonly through an HTTP proxy.

```http
CONNECT example.com:443 HTTP/1.1
Host: example.com:443
```

Repeating it can create additional connection or tunnel state. It is therefore neither safe nor idempotent.

It is usually not part of normal REST resource design.

---

# 6. Idempotent Method vs Idempotent Operation

HTTP defines properties for methods, but application behavior also matters.

## 6.1 Method-Level Guarantee

A method-level guarantee is defined by HTTP semantics.

```text
PUT    -> Idempotent by specification
DELETE -> Idempotent by specification
POST   -> Not idempotent by specification
PATCH  -> Not idempotent by specification
```

## 6.2 Endpoint-Level Behavior

An API can implement a normally non-idempotent method in an idempotent way.

Example:

```http
POST /users/42/activate
```

If activation means setting:

```text
status = active
```

then repeated requests may have the same final effect.

However, clients and generic infrastructure cannot assume every `POST` endpoint behaves this way unless the API explicitly documents and enforces it.

## 6.3 An Idempotent Method Can Still Be Implemented Badly

Consider:

```http
PUT /accounts/42/status

{
  "status": "active"
}
```

A poor implementation might send a “Welcome back” email every time the request arrives, even when the status is already active.

The primary resource state may be idempotent, but the business workflow produces duplicate external effects.

A better implementation detects the state transition:

```text
inactive -> active  => Send one activation event
active   -> active  => No new activation event
```

---

# 7. Making POST and PATCH Retry-Safe

Non-idempotent methods are common and necessary. The goal is not to avoid them, but to protect operations that may be retried.

## 7.1 Idempotency Key

The client generates a unique key for one logical operation:

```http
POST /payments
Idempotency-Key: 5ed89c4c-f6c6-43f8-b668-d4992baf4708
Content-Type: application/json

{
  "order_id": "ORD-9001",
  "amount": 2499,
  "currency": "INR"
}
```

The server associates the key with:

- Authenticated customer or tenant
- Endpoint and HTTP method
- Request fingerprint or payload hash
- Processing status
- Created resource identifier
- Response status code
- Response body
- Expiration time

A retry with the same key returns the original result.

## 7.2 Business-Level Unique Identifier

A natural business identifier can prevent duplication:

```http
POST /payments

{
  "merchant_reference": "ORDER-9001-PAYMENT-1",
  "amount": 2499,
  "currency": "INR"
}
```

Add a database uniqueness rule:

```sql
UNIQUE (merchant_id, merchant_reference)
```

This approach is especially useful when the same logical identifier must remain unique beyond a short idempotency-key retention period.

## 7.3 Client-Generated Resource ID with PUT

Instead of asking the server to generate the resource identifier:

```http
POST /orders
```

The client can generate an ID and use `PUT`:

```http
PUT /orders/01J43FD8X78A4DMXQF9ZJ6W7TK
Content-Type: application/json

{
  "customer_id": 42,
  "total": 2499
}
```

Because the URI identifies the exact target resource, repeating the request replaces the same resource rather than creating another one.

Use this pattern only when client-generated identifiers and `PUT` replacement semantics fit the domain.

## 7.4 State-Transition Commands

Design commands around a target state rather than repeated arithmetic effects.

Prefer:

```http
PUT /orders/123/status

{
  "status": "cancelled"
}
```

Over:

```http
POST /orders/123/cancel-attempts
```

For financial operations, “set balance to X” is usually not an acceptable replacement for transaction-based accounting. Use a unique transaction or ledger-entry identifier instead.

---

# 8. Idempotency-Key Processing Flow

A robust server should process duplicate requests atomically.

```text
Client
  |
  | POST /payments
  | Idempotency-Key: payment-abc-123
  v
API Server
  |
  |-- Look up key within tenant + endpoint scope
  |
  +-- Key not found -----------------------------+
  |                                              |
  |   Reserve key atomically                     |
  |   Validate request fingerprint               |
  |   Execute business transaction               |
  |   Store response/status                      |
  |   Return response                            |
  |                                              |
  +-- Key found and completed -------------------+
  |                                              |
  |   Verify same request fingerprint            |
  |   Return stored response                     |
  |                                              |
  +-- Key found and processing ------------------+
  |                                              |
  |   Wait, return 409, or return 202            |
  |                                              |
  +-- Same key but different payload ------------+
                                                 |
      Reject request, usually as a conflict      |
```

## 8.1 First Request

1. Authenticate the caller.
2. Validate the idempotency key.
3. Compute a normalized request fingerprint.
4. Atomically reserve the key.
5. Process the operation.
6. Save the final response.
7. Return the response.

## 8.2 Duplicate Completed Request

1. Locate the existing record.
2. Verify that the method, endpoint, tenant, and payload match.
3. Return the stored response.
4. Do not execute the business operation again.

## 8.3 Concurrent Duplicate Request

If another request with the same key is still processing, the API can:

- Wait for the original request to finish
- Return `409 Conflict`
- Return `202 Accepted` with an operation-status URL
- Return a documented application-specific “request in progress” response

The key requirement is that both requests must not independently perform the business action.

## 8.4 Same Key with Different Payload

The server should reject reuse of the same key for a different logical request.

Example:

```text
Key: payment-abc-123, Amount: ₹2,499 -> Accepted
Key: payment-abc-123, Amount: ₹9,999 -> Rejected
```

Silently returning the old response for a changed payload can hide a client bug and create serious business confusion.

---

# 9. Database Design for Idempotency

A simplified PostgreSQL table might look like this:

```sql
CREATE TABLE idempotency_records (
    id                  UUID PRIMARY KEY,
    tenant_id           UUID NOT NULL,
    idempotency_key     VARCHAR(255) NOT NULL,
    http_method         VARCHAR(16) NOT NULL,
    request_path        TEXT NOT NULL,
    request_fingerprint VARCHAR(128) NOT NULL,
    status              VARCHAR(20) NOT NULL,
    response_status     INTEGER,
    response_body       JSONB,
    resource_id         UUID,
    created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    expires_at          TIMESTAMPTZ NOT NULL,

    UNIQUE (tenant_id, idempotency_key)
);
```

Possible statuses:

```text
PROCESSING
COMPLETED
FAILED_RETRYABLE
FAILED_FINAL
```

## 9.1 Atomic Reservation

Use a unique constraint or atomic insert:

```sql
INSERT INTO idempotency_records (
    id,
    tenant_id,
    idempotency_key,
    http_method,
    request_path,
    request_fingerprint,
    status,
    expires_at
)
VALUES (
    gen_random_uuid(),
    :tenant_id,
    :key,
    :method,
    :path,
    :fingerprint,
    'PROCESSING',
    NOW() + INTERVAL '24 hours'
)
ON CONFLICT (tenant_id, idempotency_key) DO NOTHING;
```

Only the request that successfully inserts the row should own initial processing.

## 9.2 Transaction Boundary

For strong guarantees, the idempotency record and business mutation should be coordinated within a transaction where possible.

```text
BEGIN
  Reserve idempotency key
  Create payment/order/booking
  Store final response metadata
COMMIT
```

External systems complicate this because a database transaction cannot normally roll back a remote payment provider or message broker. In such cases, combine:

- Stable external request IDs
- Provider-supported idempotency keys
- Transactional outbox pattern
- Reconciliation jobs
- Explicit operation states

## 9.3 Retention Period

Keep idempotency records long enough to cover realistic retry windows.

The correct duration depends on:

- Client retry behavior
- Payment-provider behavior
- Webhook delivery duration
- Business dispute window
- Storage cost
- Regulatory requirements

A short TTL such as a few minutes may be insufficient for mobile clients, asynchronous jobs, or webhook retries lasting hours or days.

---

# 10. Idempotency and Concurrent Requests

Idempotency is not only about sequential retries. Two identical requests can arrive at the same time.

```text
Request A ----+
              +----> Server ----> Create one payment
Request B ----+
```

Without atomic coordination:

```text
Request A checks key -> not found
Request B checks key -> not found
Request A creates payment
Request B creates payment
```

This is a race condition.

## 10.1 Correct Protection

Use at least one of the following:

- Unique database constraint
- Atomic insert
- Row-level lock
- Distributed lock with careful failure handling
- Compare-and-set operation
- Serializable transaction for critical cases

A database uniqueness constraint is usually more reliable than a simple “check first, then insert” application flow.

## 10.2 Scope the Key Correctly

Do not make a key globally reusable across unrelated customers unless that is intentional.

Typical scope:

```text
tenant_id + idempotency_key
```

or:

```text
authenticated_principal + HTTP method + normalized endpoint + idempotency_key
```

This prevents one user from colliding with another user's key.

---

# 11. Idempotency and Optimistic Concurrency

Idempotency and concurrency control solve different problems.

```text
Idempotency:
Did this logical request already run?

Optimistic concurrency:
Am I updating the resource version I originally read?
```

## 11.1 Lost Update Problem

Two clients read the same user:

```json
{
  "name": "Aarav",
  "status": "active",
  "version": 7
}
```

Client A updates the name. Client B updates the status using stale data. A full `PUT` from Client B could overwrite Client A's update.

The `PUT` request can still be idempotent while producing a lost update.

## 11.2 ETag and If-Match

The server returns:

```http
ETag: "user-42-v7"
```

The client updates conditionally:

```http
PUT /users/42
If-Match: "user-42-v7"
Content-Type: application/json

{
  "name": "Aarav Sharma",
  "status": "active"
}
```

If the resource has already changed, the server can return:

```http
HTTP/1.1 412 Precondition Failed
```

### Key Point

- `PUT` idempotency makes repeating the same intended replacement safe.
- `If-Match` prevents overwriting a newer version unexpectedly.

Reliable update APIs often need both concepts.

---

# 12. Retry Strategy for REST Clients

Idempotency enables safer retries, but retries still need control.

## 12.1 Typical Retry Decision

```text
Request failed
    |
    v
Was any response received?
    |
    +-- Yes --> Inspect status and API contract
    |
    +-- No  --> Outcome may be unknown
                    |
                    v
             Is operation retry-safe?
                    |
           +--------+--------+
           |                 |
          Yes                No
           |                 |
      Retry with         Check operation
      backoff            status or reconcile
```

## 12.2 Usually Retryable Situations

Depending on the API contract, retries may be appropriate for:

- Connection reset
- Connection timeout
- Read timeout after an idempotent request
- `408 Request Timeout`
- `429 Too Many Requests`
- Temporary `5xx` responses
- Service unavailable conditions

Always inspect API-specific behavior.

## 12.3 Exponential Backoff with Jitter

Avoid immediate retry loops.

```text
Attempt 1 -> wait about 1 second
Attempt 2 -> wait about 2 seconds
Attempt 3 -> wait about 4 seconds
Attempt 4 -> wait about 8 seconds
```

Add random jitter so thousands of clients do not retry at exactly the same time.

A simplified formula is:

```text
delay = min(max_delay, base_delay * 2^attempt) + random_jitter
```

## 12.4 Honor Retry-After

When the server returns `Retry-After`, the client should use it according to the API contract.

```http
HTTP/1.1 429 Too Many Requests
Retry-After: 30
```

## 12.5 Reuse the Same Idempotency Key

A retry of the same logical operation must use the same key.

```text
Initial payment request -> key payment-123
Retry 1                 -> key payment-123
Retry 2                 -> key payment-123
```

A new logical operation must use a new key.

---

# 13. Practical API Design Examples

## 13.1 User Profile Replacement

```http
PUT /users/42/profile
Content-Type: application/json

{
  "first_name": "Aarav",
  "last_name": "Sharma",
  "timezone": "Asia/Kolkata"
}
```

Repeated requests result in the same target representation.

```text
Naturally idempotent: Yes
```

---

## 13.2 Order Creation

```http
POST /orders
Idempotency-Key: order-checkout-session-7788
Content-Type: application/json

{
  "customer_id": 42,
  "items": [
    { "product_id": 1001, "quantity": 2 }
  ]
}
```

Server behavior:

```text
First request  -> Create order 501 and save response
Retry request  -> Return order 501 response
```

```text
Naturally idempotent method: No
Retry-safe endpoint design: Yes
```

---

## 13.3 Payment Capture

```http
POST /payments/captures
Idempotency-Key: capture-order-501-v1
Content-Type: application/json

{
  "payment_authorization_id": "AUTH-9001",
  "amount": 2499,
  "currency": "INR"
}
```

The server or payment provider must ensure only one capture is performed for this logical operation.

Protection may include:

```text
Idempotency key
+ unique merchant reference
+ provider transaction ID
+ reconciliation process
```

---

## 13.4 Inventory Update

### Target-State Design

```http
PUT /inventory/products/1001
Content-Type: application/json

{
  "available_quantity": 25
}
```

Repeated execution keeps quantity at 25.

### Relative-Change Design

```http
POST /inventory/products/1001/adjustments
Content-Type: application/json

{
  "adjustment_id": "SALE-501-PRODUCT-1001",
  "quantity_delta": -2
}
```

The operation is naturally non-idempotent, but `adjustment_id` can be unique so the same adjustment is applied only once.

For inventory and accounting, recording immutable adjustments is often better than directly setting totals because it preserves an audit trail.

---

## 13.5 Webhook Consumer

Webhook providers often deliver events more than once.

```http
POST /webhooks/payment-provider
Content-Type: application/json

{
  "event_id": "evt_9001",
  "type": "payment.succeeded",
  "payment_id": "pay_501"
}
```

Consumer flow:

```text
Receive event
    |
    v
Insert event_id into processed_events
    |
    +-- Insert succeeds -> Process event
    |
    +-- Unique conflict -> Already processed; return success
```

Database rule:

```sql
UNIQUE (provider_name, event_id)
```

Returning a successful response for an already processed event prevents unnecessary repeated deliveries while preserving exactly-once business effect.

---

## 13.6 Partial Status Update

```http
PATCH /orders/501
Content-Type: application/merge-patch+json

{
  "status": "cancelled"
}
```

This specific patch can behave idempotently if:

- `cancelled -> cancelled` performs no additional business transition
- Inventory is restored only during the first transition
- Refund creation is deduplicated
- Notification events are not emitted repeatedly

The method is still not idempotent by general HTTP classification.

---

# 14. Testing Idempotency

Idempotency should be tested at the API, database, and integration levels.

## 14.1 Repeated Sequential Request Test

Send the exact same request multiple times:

```text
Request 1
Request 2
Request 3
```

Verify:

- Only one business resource was created
- Final resource state is correct
- Stored response is returned when appropriate
- No duplicate financial transaction occurred
- No duplicate event or email was generated unexpectedly

## 14.2 Concurrent Duplicate Test

Send 10 or 100 requests with the same idempotency key at nearly the same time.

Expected result:

```text
One operation executes
All other requests reuse, wait for, or conflict with that operation
```

## 14.3 Same Key, Different Payload Test

```text
Key K + Payload A -> Accepted
Key K + Payload B -> Rejected
```

## 14.4 Timeout Simulation

Simulate this sequence:

1. Server completes the operation.
2. Response is dropped before the client receives it.
3. Client retries with the same key.
4. Server returns the original result.
5. No duplicate operation occurs.

## 14.5 Expiration Test

Confirm behavior after the idempotency record expires:

- Is the same key accepted as new?
- Is the business identifier still protected by a unique constraint?
- Is the documented retry window clear to clients?

## 14.6 External Dependency Test

Simulate failure after a remote provider succeeds but before the local database marks completion.

This reveals whether reconciliation, provider idempotency, or operation-status lookup is required.

---

# 15. Important Design Distinctions

## 15.1 Same Effect Does Not Mean Same Response

A repeated `DELETE` can return:

```text
204 No Content
404 Not Found
```

The responses differ, but the intended final server state is unchanged.

## 15.2 Idempotency Does Not Mean No Side Effects

An idempotent request may produce:

- Access logs
- Metrics
- Audit records
- Traces
- Cache activity
- Revision history

The method property concerns the intended effect requested by the client.

Business-critical side effects should still be deduplicated when necessary.

## 15.3 Idempotency Does Not Guarantee Atomicity

An idempotent operation can partially fail:

```text
Update database succeeded
Publish event failed
```

Use transaction boundaries, outbox patterns, sagas, or reconciliation for multi-step workflows.

## 15.4 Idempotency Does Not Guarantee Consistency

Repeating the same request may preserve the same intended effect while replicas or caches temporarily show stale state.

Idempotency and consistency are separate distributed-system concerns.

## 15.5 Idempotency Is Not Exactly-Once Delivery

Networks and message brokers frequently provide at-least-once delivery. Exactly-once business effect is normally achieved through:

- Deduplication
- Unique constraints
- Idempotent consumers
- Transactional processing
- Stable operation identifiers

The message may be delivered multiple times even though the business action occurs once.

## 15.6 Idempotency Is Not Concurrency Control

Idempotency protects against duplicate logical requests. `ETag`, version numbers, locks, and compare-and-set protect against conflicting updates from different logical requests.

---

# 16. Best-Practice Checklist

## 16.1 API Contract

- Document whether an operation is retry-safe.
- Use HTTP methods according to their defined semantics.
- Clearly define idempotency-key scope and retention.
- Document behavior for duplicate requests still in progress.
- Document behavior when the same key is used with a different payload.

## 16.2 Server Implementation

- Reserve idempotency keys atomically.
- Scope keys by tenant or authenticated principal.
- Store a request fingerprint.
- Store the original status code and response body when replay is supported.
- Use unique business identifiers for critical operations.
- Protect concurrent duplicate requests.
- Deduplicate external side effects.
- Define cleanup and retention policies.

## 16.3 Database and Messaging

- Prefer database unique constraints over application-only checks.
- Use an outbox pattern for reliable event publishing.
- Make webhook and message consumers idempotent.
- Keep immutable transaction or adjustment IDs for financial and inventory operations.
- Reconcile uncertain outcomes with external providers.

## 16.4 Client Behavior

- Retry only when the method or endpoint is known to be retry-safe.
- Reuse the same idempotency key for the same logical operation.
- Generate a new key for a new logical operation.
- Apply exponential backoff and jitter.
- Honor `Retry-After` where applicable.
- Stop after a reasonable maximum number of attempts.
- Query operation status when the outcome remains uncertain.

---

# 17. Quick Revision Summary

## 17.1 Definition

```text
Idempotency means that multiple identical requests have the same intended
final effect on the server as one request.
```

## 17.2 Method Classification

```text
Safe and idempotent:
GET, HEAD, OPTIONS, TRACE, QUERY

Idempotent but not safe:
PUT, DELETE

Not idempotent by specification:
POST, PATCH, CONNECT
```

## 17.3 Easy Memory Rule

```text
Reads are generally safe and idempotent.
PUT replaces a target state, so it is idempotent.
DELETE reaches the state “resource absent,” so it is idempotent.
POST and PATCH can describe repeatable actions, so they are not guaranteed
idempotent unless the API adds protection.
```

## 17.4 Practical Production Rule

```text
For payments, orders, bookings, inventory adjustments, webhooks, and jobs:

HTTP method semantics
        +
Idempotency key or unique operation ID
        +
Atomic database constraint
        +
Retry and reconciliation strategy
        =
Reliable duplicate-safe processing
```

---

# 18. References

1. **RFC 9110 — HTTP Semantics**  
   https://www.rfc-editor.org/rfc/rfc9110.html

2. **RFC 5789 — PATCH Method for HTTP**  
   https://www.rfc-editor.org/rfc/rfc5789.html

3. **RFC 10008 — The HTTP QUERY Method**  
   https://www.rfc-editor.org/rfc/rfc10008.html

4. **IANA Hypertext Transfer Protocol (HTTP) Method Registry**  
   https://www.iana.org/assignments/http-methods/http-methods.xhtml

---

> **Final takeaway:** Idempotency is a reliability contract about repeated requests and their intended server effect. HTTP gives `GET`, `HEAD`, `OPTIONS`, `TRACE`, `QUERY`, `PUT`, and `DELETE` idempotent semantics. For `POST` and `PATCH`, production APIs must explicitly add duplicate protection when retries can cause costly or irreversible actions.
