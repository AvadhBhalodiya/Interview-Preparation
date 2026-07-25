---
title: "API Versioning"
group: "API Design"
order: 3
---

# API Versioning Strategies

> Versioning lets you make breaking changes without breaking the clients already built against you. Most teams put the version in the URI path (`/v1/`), while header and media-type variants trade visibility for cleaner, more RESTful URLs.

## What it is
Versioning means running more than one version of your **contract** at once, so a breaking change on your side does not take down clients coded against the old shape. What you version is that contract - field names and types, status codes, what a value means - not your source code. One deployment can serve two versions, and two deployments can serve the same one.

It buys you out of the flag-day migration where every consumer has to update in lockstep the moment you ship. Old clients stay on `/v1`, new ones move to `/v2`, and you retire `/v1` on your own schedule.

> [!KEY] You version the observable **contract**, never the code behind it, and you bump it **only for a breaking change**. Additive changes ride the current version as long as clients are tolerant readers that ignore fields they do not recognise.

## Key points
Four places to put the version, each trading visibility against RESTful purity:

| Strategy | Example | Pros | Cons |
| --- | --- | --- | --- |
| **URI path** | `GET /v1/users` | **Visible** in logs, cacheable, easy to route and curl | Same resource now lives at **two URIs** |
| **Query param** | `GET /users?version=1` | **Quickest** to bolt on | Clutters cache keys, **silently** dropped or defaulted |
| **Custom header** | `Api-Version: 2` | **Clean** URLs, version as pure metadata | Invisible in a browser, must go in **`Vary`** |
| **Media type** | `Accept: application/vnd.acme.v2+json` | **Textbook-correct** content negotiation (RFC 9110 §12) | **Fiddly** to document, test, and eyeball |

- **Pick one strategy and enforce it at the gateway.** The URI path is the sane default. On a custom header skip the legacy `X-` prefix (RFC 6648 retired it), and for a media type use the `vnd.acme` IANA vendor tree (RFC 6838).
- **Version only on breaking changes.** **Breaking** means removing or renaming a field, changing its type, tightening validation, or changing what a value means or does. **Additive** changes - a new optional field, endpoint, or param - should not earn a bump.
- **Have a deprecation policy before you ship v1.** Announce a version's retirement in-band with two headers that mark two different moments:

| Header | What it says | Value type |
| --- | --- | --- |
| **`Deprecation`** (RFC 9745) | Discouraged, but **still works** | Structured **Date**: `@1767225600` |
| **`Sunset`** (RFC 8594) | Will **stop responding** at this time | An **HTTP-date** timestamp |

Add a `Link` with `rel="deprecation"` pointing at the migration guide (RFC 9745), keep the old version alive through the window, watch traffic drain, then pull it.

> [!TIP] Stripe pins a **dated version** per account (like `2025-03-31`) and lets you override it per request with a `Stripe-Version` header, so a five-year-old integration keeps its exact behaviour until someone chooses to upgrade. More machinery to run, but it never surprises a client.

## Example
```http
# Same user, three ways to ask for v2

# good: version in the path (most common, most visible)
GET /v2/users/42 HTTP/1.1
Host: api.acme.com

# header-based: clean URL, version rides as metadata
GET /users/42 HTTP/1.1
Host: api.acme.com
Api-Version: 2

# media type: one URI, negotiated representation (RFC 9110)
GET /users/42 HTTP/1.1
Host: api.acme.com
Accept: application/vnd.acme.v2+json
```

```http
# Retiring v1: tell clients it's deprecated, when it dies, and where to read
HTTP/1.1 200 OK
Deprecation: @1767225600
Sunset: Thu, 31 Dec 2026 23:59:59 GMT
Link: <https://developer.acme.com/versions>; rel="deprecation"
Content-Type: application/json
# note: Sunset must not be earlier than Deprecation (RFC 9745)
```

```protobuf
// gRPC/protobuf: evolve the wire format in place; bump the package only for real breaks
syntax = "proto3";
package acme.user.v1;

message User {
  reserved 4, 7;                // note: never reuse a removed field's number...
  reserved "email_verified";    //       ...or its name; reuse corrupts data on the wire
  int64  id    = 1;
  string name  = 2;
  string email = 3;
  string phone = 8;             // additive: old clients just ignore the field they don't know
}
```

## Interview Q&A
- **Why version at all?** So you can ship a breaking change without breaking clients written against the old shape. The version pins the contract they were built on.
- **Which strategy, and why?** **URI path** (`/v1/`) most of the time: visible in logs, trivial to curl, friendly to routing and caching. The honest tradeoff is that the same resource now lives at two URIs, which is what REST purists object to.
- **What actually counts as breaking?** Removing or renaming a field, changing its type, tightening validation, or changing what a value means or does. Adding an optional field or a new endpoint is **additive** and should not need a new version, assuming clients tolerate unknown fields.
- **How do you retire a version cleanly?** Announce it, serve it in-band with `Deprecation` (RFC 9745) and `Sunset` (RFC 8594) plus a `Link` to migration docs, keep it running through the grace window, watch usage fall, and only then remove it.
- **How does GraphQL handle versioning?** Mostly by not versioning. A client asks for exactly the fields it wants, so adding types or fields breaks nobody. You evolve the schema continuously and mark old fields `@deprecated(reason: "...")`, deleting them once analytics show no one queries them.
- **And gRPC?** The protobuf wire format is built to evolve: add fields freely, never reuse a field number, `reserved` the dead ones. Save a package bump (`v1` to `v2`) for genuine breaks.

## Gotchas
> [!WARN] The `Deprecation` header is a **date** (`@unix-timestamp`, RFC 9745), not `Deprecation: true`. Plenty of blog posts still show the boolean or `version=` syntax from old drafts that never became the standard. And `Sunset` must not be earlier than `Deprecation`.

> [!WARN] Header and media-type versioning **quietly break caching** when you forget the version in `Vary`. Two versions then share one cache entry and someone gets the wrong bytes.

- Cutting a new version for an **additive** change is how you end up maintaining five near-identical APIs. A new optional field does not earn a `/v2`.
- "We'll turn v1 off eventually" is **not a policy**. Commit a `Sunset` date, publish it, and hold the line, or clients will never migrate.
- **Mixing strategies** across endpoints (path here, header there) is a support-ticket generator. Pick one at the edge and enforce it in the gateway.
- Reusing a protobuf **field number** after deleting a field silently corrupts data for older peers. Always `reserved` the number and the name.

## Revise next
- [REST & HTTP methods](rest-http-methods-status-codes.md)
- [Pagination](pagination-offset-cursor.md)
- DRF versioning / FastAPI routers

*Reviewed against RFC 9110 (HTTP semantics), RFC 9745 (Deprecation), RFC 8594 (Sunset), and the GraphQL and Protocol Buffers docs, July 2026.*
