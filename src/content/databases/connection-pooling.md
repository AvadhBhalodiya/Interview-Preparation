---
title: "Connection Pooling"
group: "Schema & Scaling"
order: 8
---

# Connection Pooling

> A connection pool keeps a handful of DB connections open and hands them out on demand, so each request skips the cost of opening a fresh one - and on PostgreSQL that cost is a whole OS process, not just a socket.

## What it is
A **connection pool** is a cache of already-established DB connections your app borrows and returns, instead of opening one per request. Opening a Postgres connection is not cheap: the postmaster **forks a brand-new backend process**, runs authentication, and allocates per-connection memory. Pay that once, then reuse the connection across thousands of requests.

A pool lives in one of two places, and big deployments run both: **in-process** inside the app (SQLAlchemy's `QueuePool`, Django's persistent connections) and as a **standalone proxy** in front of the database (PgBouncer, AWS RDS Proxy).

> [!KEY] The win is **amortization**. A request holds a connection for only a few milliseconds of query time, so a **small pool of warm, reused backends** serves far more traffic than open-one-per-request ever could.

The whole point is where the connection setup cost lands:

| Per request | **No pool** - connect each time | **With a pool** - borrow and return |
| --- | --- | --- |
| Get a connection | **Fork a backend**, authenticate, allocate memory | Grab an **idle, warm** connection |
| Run the query | Same cost either way | Same cost either way |
| When done | **Tear the backend down** | **Return** it to the pool |
| Who pays setup | **Every single request** | Paid **once**, then reused for thousands |

## Key points
- **Why Postgres feels this more than most databases.** It is **process-per-connection**: the postmaster spawns one backend process per client, and each backend holds memory even while idle. `max_connections` defaults to **100** and can only change at server restart. Point a few hundred direct clients at it and you burn RAM and context-switch across connections that spend most of their life asleep.
- **PgBouncer pooling modes.** PgBouncer multiplexes many client connections onto a few server ones, and the mode decides when a server connection returns to the pool:

| Mode | Server conn returned | Reuse level | Best for |
| --- | --- | --- | --- |
| **Session** | On **client disconnect** | Lowest - one backend per client | Apps needing full session state |
| **Transaction** | At each `COMMIT` / `ROLLBACK` | **Highest for web apps** | Short requests (**reach for this**) |
| **Statement** | After **every statement** | High, but **multi-statement txns banned** | Autocommit / sharding proxies |

- **What transaction mode takes away.** Your next statement may land on a **different backend**, so anything that assumes it owns one connection across statements breaks: `SET`/`RESET`, session-level advisory locks, `LISTEN`, `WITH HOLD` cursors, and SQL-level `PREPARE`. `NOTIFY` still works, only `LISTEN` is out. Server-side prepared statements were the classic footgun, but **PgBouncer 1.21+** supports **protocol-level** prepared statements once `max_prepared_statements` is non-zero (10 is a good start). Text-level `PREPARE ... AS` still breaks, because PgBouncer never sees it.
- **App-side pools.** SQLAlchemy uses `QueuePool` by default for every non-SQLite engine (`pool_size` defaults to **5**, `max_overflow` to **10**, so 15 max), and `pool_pre_ping` fires a cheap `SELECT 1` on checkout so you never hand out a dead connection. **Django is different**: `CONN_MAX_AGE` keeps **one** connection alive *per worker process* (`0` closes it every request, a number holds it that many seconds, `None` is unlimited). That is **not a pool** - fifty Gunicorn workers means up to fifty open connections. Pair it with `CONN_HEALTH_CHECKS`.
- **Sizing: smaller than you would guess.** More connections is **not** more throughput. The Postgres-wiki rule of thumb is `(cores * 2) + effective_spindles`, where spindles trend to zero once the working set is cached in RAM. Postgres pushes 10,000 transactions through faster running 10-20 at a time than 500 at a time.
- **Serverless forces an external pooler.** Lambda scales out to hundreds of short-lived containers, each wanting its own connection, and they blow past `max_connections` fast. Put PgBouncer or RDS Proxy between them and the DB so the database only ever sees a bounded, reused set.
- **NoSQL contrast.** DynamoDB does not have this problem. It is an **HTTP API**, not a stateful session, so there is no backend per connection and no `max_connections` to exhaust. "Pooling" there means **HTTP keep-alive**: reuse the TCP/TLS socket to skip the handshake per call. The SDK handles it (boto3's `max_pool_connections` defaults to **10**).

> [!TIP] Aim for **two bounded layers**: one external pool (PgBouncer/RDS Proxy) sized to the DB server, with small app-side pools underneath. The database then only ever sees the outer cap, no matter how many app workers or Lambdas spin up.

## Example
```python
# SQLAlchemy: QueuePool is already the default; here we size it explicitly
from sqlalchemy import create_engine
engine = create_engine(
    DB_URL,
    pool_size=10,       # kept-open connections (default 5)
    max_overflow=5,     # extra burst connections (default 10)
    pool_pre_ping=True, # validate with SELECT 1 on checkout
)

# Django: keep each worker's connection for 60s, health-check before reuse.
# Note: this is one connection PER worker, not a shared pool.
DATABASES = {"default": {..., "CONN_MAX_AGE": 60, "CONN_HEALTH_CHECKS": True}}
```

```python
# NoSQL contrast: DynamoDB has no DB sessions, just an HTTP client pool.
import boto3
from botocore.config import Config
# One client, reused everywhere (build it in Lambda init, not the handler)
ddb = boto3.resource("dynamodb", config=Config(max_pool_connections=20))
table = ddb.Table("MyTable")
```

## Interview Q&A
- **Why does pooling matter more for PostgreSQL than for a stateless HTTP store?** Postgres is process-per-connection. Each one forks a backend that holds memory even when idle, so pooling saves both the fork-and-auth cost and the standing memory of hundreds of sleeping connections.
- **What are PgBouncer's pooling modes, and which do you pick?** Session, transaction, and statement. Pick **transaction** for web apps: it returns the server connection at the end of each transaction, which is where almost all the reuse comes from.
- **Is a bigger pool always better?** No. Past the point where the DB's CPU and disk saturate, extra connections just add contention. Size to the server, roughly `(cores * 2) + spindles`, and keep the pool small and busy.
- **What breaks under transaction-mode pooling?** Session-scoped state: `SET`, session advisory locks, `LISTEN`, `WITH HOLD` cursors, and SQL-level `PREPARE`. Protocol-level prepared statements need `max_prepared_statements` non-zero (PgBouncer 1.21+).

## Gotchas
> [!WARN] **An oversized pool overloads the database, not your app.** CPU, memory, and context-switching all climb once the DB saturates. Size to the **DB server**, not to your app's request rate - a small busy pool beats a huge thrashing one.

> [!WARN] **Django's `CONN_MAX_AGE` is not a pool.** It is one persistent connection **per worker**, so at high worker counts the total still explodes. Cap it with **PgBouncer or RDS Proxy** in front.

- Transaction-mode PgBouncer plus SQL-level `PREPARE`, `SET`, or `LISTEN` fails, because the next statement may land on a different backend. Protocol-level prepared statements work only with `max_prepared_statements` non-zero (PgBouncer 1.21+).
- **Stale connections** after a DB restart or network blip fail at random. Validate on checkout with `pool_pre_ping` (SQLAlchemy) or `CONN_HEALTH_CHECKS` (Django).
- Guard pooled backends with `statement_timeout` and `idle_in_transaction_session_timeout` so one stuck client cannot pin a connection and starve the pool.

## Revise next
- [Replication, sharding & partitioning](replication-sharding-partitioning.md)
- [Isolation levels & transactions](transaction-isolation-levels.md)
- [PostgreSQL specifics](postgresql-jsonb-partial-index-vacuum.md) (processes, VACUUM)
- Prepared statements & the extended query protocol

*Reviewed against PostgreSQL 18, PgBouncer, and AWS DynamoDB docs, July 2026.*
