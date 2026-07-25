---
title: "API Gateway & BFF"
group: "Design Fundamentals"
order: 4
---

# API Gateway and the BFF Pattern

> An API gateway is the single front door that handles what every service would otherwise reimplement - routing, authentication, rate limiting, TLS termination - and a BFF is a gateway owned by one client team that shapes responses for that client specifically, which is worth the extra hop right up until business logic starts leaking into either of them.

## What it is
Without a gateway, every service terminates its own TLS, parses its own JWTs, runs its own rate limiter, and publishes its own URL. A **gateway** is a reverse proxy that owns the cross-cutting concerns once, at the edge, so services behind it can assume the request is already authenticated, decoded, and within quota.

The four boxes in this space get used interchangeably in conversation and mean different things in an interview:

| | Operates at | Routes on | Also does | Traffic |
| --- | --- | --- | --- | --- |
| **Load balancer (L4)** - AWS NLB | TCP/UDP | IP and port | Health checks, connection draining. Millions of req/s, ~ms | North-south |
| **Reverse proxy (L7)** - nginx, AWS ALB | HTTP | Host, path, header | TLS termination, compression, static caching | North-south |
| **API gateway** - AWS API Gateway, Kong | HTTP | Path, method, API key | AuthN/Z, per-key rate limits, request validation, aggregation, usage plans | North-south |
| **Service mesh** - Istio, Linkerd | HTTP/gRPC via sidecar | Service identity | mTLS between services, retries, circuit breaking, per-service telemetry | **East-west** |

> [!KEY] A gateway is a superset of a reverse proxy, which is a superset of an L7 load balancer - the differences are features, not architecture. The genuinely different one is the **service mesh**: a gateway governs traffic entering your system (north-south), a mesh governs traffic *between* your services (east-west), and most microservice estates eventually run both.

A **BFF (Backend for Frontend)** is a different axis. Instead of one general-purpose API that every client must contort itself around, each client gets its own thin backend: a web BFF, a mobile BFF, a partner-API BFF. The pattern came out of SoundCloud around 2015 for a concrete reason - a generic API forces the *worst-case* payload on everyone, so mobile pays for fields it discards and makes six round trips on a 4G connection to render one screen. A mobile BFF makes those six calls server-side, over the datacentre network, and returns one 4 KB response.

The rule that keeps a BFF healthy: **it is owned by the client team, and it contains orchestration, not domain logic.** The moment the mobile BFF knows how to calculate a settlement fee, you have a second copy of the payments domain that will drift.

## Key points
- **Aggregation is the gateway's highest-value and most dangerous feature.** Turning six client round trips into one is a genuine win over mobile latency. But a fan-out to six services fails if any one fails, so an aggregating endpoint needs a per-call timeout, a circuit breaker, and a defined partial-response contract. Without those, your 99.9%-available services compose into a 99.4%-available endpoint.
- **Rate limiting belongs at the gateway, and it must be centralised to be correct.** Per-node counters on 4 gateway instances behind a load balancer mean a "100 req/min" limit actually permits 400. Back it with a shared store - Redis, or API Gateway usage plans - and be explicit about the algorithm: token bucket allows bursts, sliding window does not. See [Rate limiting](../api-design/rate-limiting.md).
- **Terminate TLS at the edge, but do not stop there.** The ALB or gateway holds the ACM certificate and decrypts once, which saves every service the handshake cost and centralises certificate rotation. Internal traffic then runs plaintext unless you re-encrypt - fine inside a VPC for most, unacceptable for cardholder data, where PCI DSS effectively pushes you to mTLS between services and therefore to a mesh.
- **Authenticate at the gateway; still authorise at the service.** The gateway is the right place to validate a JWT signature and expiry and reject the obvious garbage before it costs you a service hop. But if the gateway is your *only* check, anything inside the perimeter - a compromised pod, an SSRF, a misrouted internal call - has full access. Services must re-verify the token and enforce their own object-level permissions. Background in [AuthN vs AuthZ](../api-design/authn-authz-oauth-jwt.md).
- **On AWS, the ALB-versus-API-Gateway choice is about per-consumer control, not about scale.** An ALB routes on host and path and costs a fraction as much per request; API Gateway adds API keys, usage plans, request validation, JWT and Lambda authorizers, WAF integration, and per-stage throttling. Internal service-to-service traffic behind an ALB, partner-facing APIs behind API Gateway, is the split most teams land on.
- **A BFF is not a microservice and must not own a database.** It calls services, merges responses, and renames fields for its client. If it has its own persistent store, you have created a service that duplicates state, and the two copies will disagree during an incident.

> [!TIP] Sanity-check the extra hop against real numbers. In-region, a gateway adds roughly **1-5 ms**, which is nothing against a 40-120 ms mobile RTT you are collapsing six of. But a gateway that itself calls a Lambda authorizer on every request adds a cold-start tail - cache the authorizer result (API Gateway caches up to **1 hour**, keyed on the token) or that tail becomes your p99.

## Example
The topology that shows what sits where:

```text
                    Internet
                       |
              [ CloudFront / WAF ]          edge cache, DDoS, TLS
                       |
              [ API Gateway / ALB ]         authn, rate limit, routing
                  /         \
        [ web BFF ]       [ mobile BFF ]    per-client shaping (yours)
             \    \         /    /
              \    \       /    /
        [ payments ] [ kyc ] [ ledger ]     domain services
              \___________|______/
                  service mesh              mTLS, retries (east-west)
```

A mobile BFF collapsing a six-call screen into one response - note that the timeouts and the partial-failure contract are the load-bearing parts, not the aggregation:

```python
import asyncio
import httpx
from fastapi import FastAPI

app = FastAPI()
client = httpx.AsyncClient(timeout=httpx.Timeout(2.0, connect=0.5))

async def safe(name: str, coro):
    # Every fan-out leg degrades independently. Without this, a slow KYC
    # service turns the whole dashboard into a 504 - six 99.9% services
    # composed naively give you 99.4%.
    try:
        return await asyncio.wait_for(coro, timeout=1.5)
    except (asyncio.TimeoutError, httpx.HTTPError):
        logger.warning("bff.leg_failed", extra={"leg": name})
        return None

@app.get("/mobile/v1/home")
async def home(merchant_id: int):
    balance, payouts, kyc = await asyncio.gather(
        safe("ledger",   client.get(f"http://ledger/balance/{merchant_id}")),
        safe("payments", client.get(f"http://payments/payouts?m={merchant_id}&limit=5")),
        safe("kyc",      client.get(f"http://kyc/status/{merchant_id}")),
    )
    # Explicit partial-response contract: the client renders a skeleton for a
    # null section rather than getting an error for the whole screen.
    return {
        "balance": balance.json() if balance else None,
        "recent_payouts": payouts.json()["items"][:5] if payouts else [],
        "kyc_status": kyc.json()["status"] if kyc else "unknown",
        "degraded": [n for n, r in
                     (("ledger", balance), ("payments", payouts), ("kyc", kyc))
                     if r is None],
    }
```

Rate limiting at the gateway, backed by a shared Redis so the limit means what it says across every gateway node:

```python
# Token bucket in one atomic Lua script. Doing GET-then-SET from Python races:
# two gateway nodes both read 99, both allow, and the limit is 101.
BUCKET = """
local tokens = tonumber(redis.call('HGET', KEYS[1], 'tokens') or ARGV[1])
local last   = tonumber(redis.call('HGET', KEYS[1], 'ts') or ARGV[4])
local refill = math.min(tonumber(ARGV[1]), tokens + (ARGV[4] - last) * ARGV[2])
if refill < 1 then return 0 end
redis.call('HSET', KEYS[1], 'tokens', refill - 1, 'ts', ARGV[4])
redis.call('EXPIRE', KEYS[1], ARGV[3])
return 1
"""
# Key on the API key, not the source IP - every merchant behind one corporate
# NAT would otherwise share a single bucket.
allowed = r.eval(BUCKET, 1, f"rl:{api_key}", 100, 100/60, 120, time.time())
```

## Interview Q&A
- **What is the difference between a load balancer and an API gateway?** A load balancer distributes traffic across healthy instances - L4 on IP/port, L7 on host and path. A gateway does that too, then adds the API-aware concerns: authentication, per-key rate limiting, request validation, response aggregation and usage plans. Gateway is a superset; the choice is how much you need.
- **What is a service mesh and when do you need one over a gateway?** A gateway governs north-south traffic entering the system; a mesh governs east-west traffic between services via sidecar proxies, giving mTLS, retries, circuit breaking and per-hop telemetry without touching application code. You need one when service-to-service reliability and encryption become the problem - typically past a dozen services, or immediately if compliance requires mTLS internally.
- **What is a BFF and why not just one API?** A BFF is a per-client backend that shapes responses for that client. One general-purpose API forces the worst-case payload on every consumer and makes mobile do many round trips over high-latency links; a BFF collapses those server-side and strips fields the client cannot use. The cost is another deployable per client and a real risk of duplicated logic.
- **Is the gateway a single point of failure?** As a component, yes - which is why you run it multi-AZ and multi-instance, or use a managed regional service. The subtler risk is that redundancy does not remove: a bad route config, a broken authorizer, or an exhausted connection pool takes down every API at once regardless of how many nodes you run. Stage config changes and keep a health check that exercises a real route.
- **Where do you put authentication - gateway or service?** Both. Validate the token at the gateway to reject junk cheaply and centralise the signing-key logic; re-verify and enforce object-level permissions at the service, because gateway-only auth means anything inside the perimeter is trusted.
- **When would you not use an API gateway?** A single service or a monolith - an ALB is enough and a gateway is a hop and a bill for nothing. Also avoid it for high-throughput internal traffic where the per-request cost and latency dominate; put a mesh or plain client-side load balancing there instead.

## Gotchas
> [!WARN] **Business logic in the gateway is unversioned, untestable, and invisible.** VTL mapping templates, Lambda authorizers making domain decisions, and routing rules encoding "if the merchant is enterprise, send to the v2 service" all live outside your repo, outside CI, and outside code review. They will be the last place anyone looks during an incident. Keep the gateway to routing, authn, throttling and transport concerns.

> [!WARN] **Timeouts do not compose - they cascade.** AWS API Gateway's integration timeout is **29 seconds** (30 s for HTTP APIs) and the ALB idle timeout defaults to **60 seconds**. If your client waits 30 s, the gateway gives up at 29 s, and the service keeps working for another 45 s, you get a client-visible failure on a request that succeeded server-side - and if it was a payment, a retry against work already done. Set timeouts to decrease at every hop inward, and make the write idempotent.

- **API Gateway caps payloads at 10 MB** and does not stream; an ALB will happily carry far more. Report exports and document uploads should go to S3 with a pre-signed URL rather than through the gateway.
- **Aggregation multiplies failure and hides it.** One BFF endpoint calling six services turns six independent error budgets into one. Track per-leg success rates, not just the endpoint's, or a permanently broken leg disappears into a "degraded" field nobody alerts on.
- **A BFF per client becomes N copies of the same code.** Web and mobile BFFs drift, then someone fixes a rounding bug in one and not the other. Share the domain client library; duplicate only the shaping.
- **Gateway rate limits are not application rate limits.** API Gateway throttles per stage and per key, but it cannot express "5 payout attempts per merchant per hour" - that is domain state and belongs in the service. Expect to run both.
- **Losing the client IP at TLS termination breaks fraud rules.** After the ALB decrypts, your service sees the ALB's IP unless you read `X-Forwarded-For` - and you must take the *right* element of that list, not the last, or a client can forge it. In Django this means configuring the proxy chain deliberately rather than trusting the header.

## Revise next
- [Rate limiting](../api-design/rate-limiting.md): token bucket versus sliding window, and where the counter lives
- [Load balancing and auto-scaling](../devops/load-balancing-auto-scaling.md): the L4/L7 layer underneath the gateway
- [AuthN vs AuthZ](../api-design/authn-authz-oauth-jwt.md): why gateway-only authentication is not enough
- [REST, GraphQL and gRPC](../api-design/rest-vs-graphql-vs-grpc.md): GraphQL as the other answer to the over-fetching problem a BFF solves

*Reviewed against AWS API Gateway, ALB and Istio docs, July 2026.*
