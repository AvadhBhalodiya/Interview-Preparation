---
title: "REST / GraphQL / gRPC"
group: "Security & Integration"
order: 8
---

# REST vs GraphQL vs gRPC (Trade-offs)

> Three ways to move data over a network: REST models resources over plain HTTP and gets the web's caching for free, GraphQL puts one typed endpoint in front of your data so the client asks for exactly the fields it wants, and gRPC runs a Protobuf contract over HTTP/2 for fast, streaming service-to-service calls.

## What it is
Three styles for moving data between a client and a server, and they are not really rivals - a big system usually runs all three and the real question is which one per hop. **REST** is an architectural style (not a protocol) that models nouns (resources) and leans on HTTP's verbs, status codes, and caching. **GraphQL** is a query language plus a type system that sits in front of your data behind one endpoint. **gRPC** is remote procedure calls: you invoke a typed method on another service as if it were local, with Protobuf on the wire.

> [!KEY] Match the style to the hop: **REST** trades response flexibility for the web's free caching, **GraphQL** trades caching for a client-shaped response, and **gRPC** trades human-readability for raw speed and streaming.

How they line up across the dimensions an interviewer actually probes:

| Dimension | REST | GraphQL | gRPC |
| --- | --- | --- | --- |
| Transport | **HTTP/1.1 or HTTP/2 + JSON** text | **HTTP**, usually one POST to `/graphql` | **HTTP/2 + Protobuf** binary |
| Schema / typing | Optional (OpenAPI), **not enforced** by the style | **Strongly typed** SDL schema, introspectable | **Strongly typed** `.proto`, code-generated |
| Over-/under-fetch | **Both**: fixed payload per resource | **Neither**: client lists exact fields | **Neither**: shape fixed by the contract |
| Streaming | **None** natively (SSE or polling) | **Subscriptions** (server to client) | **Native**, including bidirectional |
| Caching | **Easy**: GET is cacheable by URL | **Hard**: POST, one URL, no per-object key | **Not HTTP-cacheable** (binary over HTTP/2) |
| When to pick | **Public / CRUD** APIs, broad reach | **Varied, changing client data** (BFF, mobile) | **Internal service-to-service**, low latency |

## Key points
- REST's superpower is using HTTP as intended. Per RFC 9110, GET and HEAD are safe and cacheable and GET, PUT, DELETE are idempotent, so CDNs cache responses and clients retry failed calls without fear. The cost is response shape: a fixed payload means you either **over-fetch** (fields you do not need) or **under-fetch** (several round trips to stitch the ones you do).
- GraphQL is one endpoint, one typed schema, and a query naming exactly the fields wanted. That kills over- and under-fetching and shines when one screen pulls from several backends. The bill: HTTP caching gets hard, and a naive resolver setup fans out into **N+1 queries**.
- gRPC starts from a `.proto` file. `protoc` generates typed client and server code across a dozen languages, all riding HTTP/2 with binary Protobuf. Four call shapes ship out of the box: **unary, server-streaming, client-streaming, and bidirectional**. The trade-off: the wire format is not human-readable and browsers cannot call it directly.
- Pagination is a good tell for how each style thinks:

| Style | Pagination convention | Key fields |
| --- | --- | --- |
| REST | **`Link` header** (RFC 8288) or opaque cursor | `rel="next"`, `page_token` |
| GraphQL | **Cursor Connections** (Relay spec) | `edges { node cursor }`, `pageInfo`, `first`/`after` |
| gRPC / Google | **AIP-158** cursor tokens | `page_size`, `page_token`, `next_page_token` |

> [!TIP] The three coexist by design: REST or GraphQL at the public edge, gRPC between backend services. Choose per hop, not per company.

## Example
One screen's data - GraphQL asks once, REST usually needs two calls:

```graphql
# GraphQL: one round trip, exactly these fields
query {
  user(id: 42) {
    name
    orders(last: 3) { total }
  }
}
```

```http
GET /users/42                    # REST: same data, two calls (under-fetching)
GET /users/42/orders?limit=3

POST /payments                   # a write you might retry on a flaky network
Idempotency-Key: 5f3a-...        # POST is not idempotent, so the key makes the retry safe
```

The gRPC contract is the source of truth, and streaming is declared right in it:

```proto
// gRPC: the .proto contract defines the service and its messages
service Users {
  rpc GetUser (GetUserRequest) returns (User);
  rpc WatchOrders (WatchRequest) returns (stream Order);  // server streaming
}
```

## Interview Q&A
- **One line each?** REST is resources over HTTP that cache for free. GraphQL is one endpoint where the client picks the fields. gRPC is typed Protobuf RPC over HTTP/2 built for speed and streaming.
- **What does GraphQL actually fix?** Over- and under-fetching. A single query returns exactly the listed fields, so you stop minting a new endpoint every time a screen's data needs change.
- **Why is gRPC fast?** Binary Protobuf instead of JSON text, and HTTP/2 multiplexing many calls over one connection. Streaming is native, not emulated with polling.
- **When gRPC over REST?** Internal, high-throughput, strongly-typed service-to-service calls, and anything that streams. Not for a public, browser-facing API.
- **Is POST idempotent, and how do you make a retry safe?** No. RFC 9110 lists GET, PUT, and DELETE as idempotent but not POST (and PATCH is neither safe nor idempotent, RFC 5789). For a POST that must survive retries, the client sends an `Idempotency-Key` and the server dedupes: the draft returns **409** while the first request is still in flight and **422** if the key returns with a different payload.

## Gotchas
> [!WARN] GraphQL throws away easy HTTP caching. One POST to one URL means no per-object cache key, so expose a globally-unique `id` per object for clients to cache on, add query depth and cost limits, and batch with a DataLoader - otherwise a naive schema fans out into N+1 queries.

> [!WARN] gRPC is not browser-callable. Browsers do not expose the HTTP/2 framing gRPC depends on, so a frontend needs gRPC-Web behind a proxy (Envoy) or something like Connect. Settle that before you promise a gRPC API to a web team.

- "GraphQL everywhere" or "gRPC everywhere" is usually resume-driven. For plain CRUD, REST is the pragmatic default: easiest to cache, poke at with curl, and hand to an outside consumer.
- Auth is the same across all three: a bearer token (**OAuth 2.1** / OIDC), typically a JWT validated per the best practices in RFC 8725. OAuth 2.1 now requires PKCE for every authorization-code client, drops the implicit and password grants, and mandates exact-match redirect URIs.
- Cross-cutting concerns live in HTTP, not in the style: rate limiting returns **429** (RFC 6585) with `Retry-After` and advertises budgets via the `RateLimit` / `RateLimit-Policy` fields (still an IETF draft), and deprecation uses the `Deprecation` (RFC 9745) and `Sunset` (RFC 8594) response headers.
- Do not tie REST to HTTP/1.1 in an interview. REST is version-agnostic and runs happily over HTTP/2. The style is about resources and the uniform interface, not a wire version.

## Revise next
- **[HTTP semantics](rest-http-methods-status-codes.md) (RFC 9110)**: safe vs idempotent methods, status codes, and caching - the ground REST stands on.
- **[Pagination](pagination-offset-cursor.md)**: the `Link` header (RFC 8288), GraphQL Cursor Connections, and Google AIP-158 (`page_token` / `next_page_token`).
- **[Safe retries](idempotency-http-methods.md) and [versioning](api-versioning.md)**: the `Idempotency-Key` draft, `PATCH` (RFC 5789), and `Deprecation` (RFC 9745) / `Sunset` (RFC 8594).
- **Async delivery**: [webhooks](webhooks.md) (Standard Webhooks - `webhook-id` / `webhook-signature`, HMAC-SHA256) as the event-driven alternative to streaming.

*Reviewed against RFC 9110 (HTTP Semantics), OAuth 2.1, the Idempotency-Key IETF draft, and the official GraphQL and gRPC docs, July 2026.*
