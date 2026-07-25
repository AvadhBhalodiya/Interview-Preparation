---
title: "Scaling WebSockets"
group: "Classic Designs"
order: 13
---

# Scaling WebSockets

> A WebSocket turns a stateless request into a long-lived connection pinned to one process, so scaling it is not about requests per second but about connections per pod, a shared pub/sub backplane so a message published on pod A reaches a subscriber on pod B, and a client that reconnects sanely when a deploy drops every connection at once.

## What it is
HTTP is stateless by design: any pod can serve any request, so scaling is "add pods". A WebSocket inverts that. After the HTTP `Upgrade` handshake (RFC 6455) the connection is a persistent TCP socket **owned by exactly one process**, which changes what the constraints are:

| Dimension | Stateless HTTP | WebSocket |
| --- | --- | --- |
| Unit of load | Requests/second | **Concurrent connections** (mostly idle, always resident) |
| Routing | Any pod, per request | **Pinned for the connection's life** |
| Scale-out | Add pods, done | Add pods, **plus a backplane** so pods can reach each other's clients |
| Deploy | Drain in-flight requests | **Every connection drops**; clients all reconnect at once |
| State | In Postgres/Redis | Some of it is **in the process**: subscriptions, presence, buffers |
| Failure | Retry the request | Reconnect, re-authenticate, and **recover missed messages** |

> [!KEY] **Sticky sessions do not scale WebSockets.** A WebSocket is inherently sticky - the TCP connection cannot move. Stickiness only affects the initial handshake and HTTP fallbacks. The problem it never solves is fan-out: a payment-status update produced by a worker on pod A must reach the browser attached to pod B. That needs a **backplane**, and the backplane is the design.

Three arrangements, in order of what you should reach for:

| Approach | How a message crosses pods | Cost |
| --- | --- | --- |
| **Shared pub/sub backplane** (Redis) | Every pod subscribes to the groups its clients joined | One Redis; **the default answer** |
| **Dedicated WebSocket tier** | Web pods publish, a separate ASGI fleet holds sockets | Deploys of the API stop dropping connections |
| **Managed fan-out** (API Gateway WebSocket API, Ably, Pusher) | The provider holds the sockets; you POST to connection ids | No connection ops; per-message pricing |

## Key points
- **Do the capacity arithmetic before choosing anything.** Budget tens of KB of memory and one file descriptor per idle connection, so a Python ASGI process is realistically good for **5,000-20,000** connections - and the default `ulimit -n` of 1024 will stop you long before memory does. CPU is usually the real ceiling, because it scales with **messages fanned out**, not connections held: 10,000 idle sockets are nearly free, 10,000 sockets each receiving 10 messages a second is 100k sends per second.
- **The channel layer is a message bus, not a database.** In Django Channels, `channels_redis` gives you `group_add` / `group_send`; its defaults matter under load - a channel holds **100 messages** before it raises `ChannelFull`, messages **expire after 60 seconds**, and group membership expires after **86,400 seconds**. A slow consumer therefore drops messages rather than blocking the sender, which is the right trade but only if you know it happens.
- **Presence must be reconstructible, because disconnects are not delivered.** A pod that is OOM-killed never runs your `disconnect` handler, so any "online users" set built purely from connect/disconnect events leaks ghosts forever. Store presence as a **Redis sorted set scored by last heartbeat** (`ZADD presence:room:42 <ts> user:7`) and treat anything older than two heartbeat intervals as offline. State that expires by itself survives crashes; state that depends on a cleanup callback does not.
- **Heartbeat faster than the shortest idle timeout on the path.** An ALB idles a connection out after **60 seconds by default** (configurable to 4,000), and nginx's `proxy_read_timeout` is also 60 seconds. Send WebSocket ping frames every 20-30 seconds. Use the protocol-level ping when you can, and an app-level heartbeat message when a proxy in between eats control frames.
- **Reconnect logic is part of the server design.** Exponential backoff **with jitter**, capped at ~30 seconds, plus a resume token: the client sends the last message id it saw and the server replays from a short Redis Stream buffer. Without a resume path, every reconnect is a silent gap in the user's data; without jitter, a pod dying sends 20,000 clients back in the same millisecond.
- **Authenticate at the handshake, and again over time.** The browser `WebSocket` API cannot set custom headers, so the token rides in a query-string ticket (short-lived and single-use) or the `Sec-WebSocket-Protocol` header. Then remember the connection can outlive the credential: a socket open for six hours with a 15-minute JWT needs a re-auth message or a server-side expiry that closes it with code `4401`.

> [!TIP] Not every "real-time" feature needs WebSockets. If data only flows server to client - a KYC status page, a payment result, a progress bar - **SSE** gives you auto-reconnect and `Last-Event-ID` replay for free over plain HTTP, and it passes through proxies that mangle upgrades. Note the HTTP/1.1 six-connections-per-origin browser limit; over HTTP/2 it multiplexes and the limit stops mattering.

| Need | Use | Why |
| --- | --- | --- |
| Bidirectional, low latency (chat, trading, collaborative editing) | **WebSocket** | Full duplex, minimal framing overhead |
| Server to client only (status, notifications, progress) | **SSE** | Reconnect and event ids are built into the protocol |
| Updates every few minutes, or a hostile network | **Polling** | No connection state anywhere; trivially cacheable |

## Example
A Django Channels consumer: group membership for fan-out, plus presence that expires on its own.

```python
class PaymentStatusConsumer(AsyncJsonWebsocketConsumer):
    async def connect(self):
        user = self.scope["user"]                      # populated by AuthMiddlewareStack
        if not user.is_authenticated:
            return await self.close(code=4401)         # 4000-4999 is the app-defined range
        self.group = f"merchant.{user.merchant_id}"
        await self.channel_layer.group_add(self.group, self.channel_name)
        await self.accept()

    async def receive_json(self, content):
        if content.get("type") == "heartbeat":
            # Presence is a score, not a flag: a pod that is OOM-killed leaves no ghost,
            # because the entry ages out on its own rather than waiting for a disconnect.
            await redis.zadd(f"presence:{self.group}", {str(self.scope['user'].id): time.time()})

    async def payment_update(self, event):             # invoked by group_send's "type"
        await self.send_json(event["payload"])

    async def disconnect(self, code):
        await self.channel_layer.group_discard(self.group, self.channel_name)
```

The producer is an ordinary Celery worker with no sockets of its own - it publishes to the backplane and whichever pod holds the client delivers it:

```python
@app.task
def notify_payment_captured(merchant_id: int, payment_id: str) -> None:
    layer = get_channel_layer()
    async_to_sync(layer.group_send)(
        f"merchant.{merchant_id}",
        {"type": "payment.update",                     # maps to payment_update() above
         "payload": {"id": payment_id, "status": "captured"}},
    )
    # Also persist it. The socket is a delivery optimisation, never the system of record -
    # a disconnected client must still see this on its next page load.
    Notification.objects.create(merchant_id=merchant_id, payment_id=payment_id)
```

## Interview Q&A
- **Why can't you scale WebSockets by just adding pods behind a load balancer?** Because the connection is pinned to one process, and the event that needs delivering is usually produced somewhere else - a Celery worker or another pod. Without a shared backplane, a message published on pod A simply never reaches a client attached to pod B. Adding pods makes that worse, not better.
- **Do you need sticky sessions?** Not for the WebSocket itself; the TCP connection cannot move once established. Stickiness matters only for the handshake path and for HTTP fallbacks like long-polling, and it is often actively harmful because it prevents even load distribution after a scale-out.
- **How do you track who is online?** Never from connect/disconnect events alone, since a crashed pod never sends the disconnect. Heartbeat into a Redis sorted set scored by timestamp and treat stale entries as offline. Presence is then eventually correct after any crash, with a bounded window of wrongness equal to the heartbeat interval.
- **What happens to 50,000 connections during a deploy?** They all drop. Mitigate on both sides: drain gracefully with a close code that tells the client to reconnect, spread rollout across batches, and require jittered exponential backoff on the client. If dropping them is unacceptable, split the socket tier out so API deploys stop touching it.
- **When would you use SSE instead?** Whenever the flow is one-directional. SSE gives reconnect and event replay for free, works over ordinary HTTP, and survives proxies that mishandle upgrades. Reach for WebSockets when you genuinely need the client to push at low latency.
- **How do you handle a client that reads slower than you write?** Bound the buffer and decide the policy explicitly: drop the oldest, coalesce to the latest state, or disconnect them. Unbounded queueing turns one slow mobile client into a memory leak in the pod that holds it.

## Gotchas
> [!WARN] **The idle timeout kills connections that look perfectly healthy.** An ALB at its default 60-second idle timeout closes a WebSocket that has sent nothing, and the browser often reports it as a generic close with no error. It reproduces only on quiet connections, which is why it usually ships to production. Ping every 20-30 seconds.

> [!WARN] **A reconnect storm is a self-inflicted DDoS.** Lose a pod holding 20,000 sockets and every client retries immediately, hits the survivors, and knocks them over too. Jittered backoff on the client is mandatory, and an accept-rate limit at the edge is the seatbelt.

- **`runserver` and plain WSGI cannot serve WebSockets at all.** You need an ASGI server (Daphne, or Uvicorn with the ASGI app) and an ASGI-aware deployment. Gunicorn with sync workers will just fail the upgrade.
- **One blocking call in an async consumer stalls every connection in that process.** A synchronous ORM query inside an `async def` handler blocks the event loop for all the sockets that worker holds. Wrap it in `database_sync_to_async`, or do the work in Celery.
- **Redis pub/sub is fire-and-forget.** A message published while a pod is briefly disconnected from Redis is gone; nothing replays it. Persist anything the user must not miss, and treat the socket as the fast path rather than the source of truth.
- **Fan-out cost is per recipient, not per message.** Broadcasting to a group of 100,000 is 100,000 sends spread over the pods holding them. Above a few thousand recipients, batch, sample, or move to a provider built for it.

## Revise next
- [Design a notification system](notification-system.md): the durable path behind the socket
- [Redis data structures](../caching/redis-data-structures.md) - sorted sets for presence, streams for replay
- [Load balancing and auto scaling](../devops/load-balancing-auto-scaling.md): idle timeouts, draining, target tracking
- [Async endpoints in FastAPI](../fastapi/async-endpoints.md) - why one blocking call stalls the loop

*Reviewed against RFC 6455, the Django Channels 4 and channels-redis docs, and the AWS ALB user guide, July 2026.*
