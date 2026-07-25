---
title: "Async Endpoints"
group: "Dependencies & Async"
order: 5
---

# Async Endpoints (and why FastAPI is fast)

> FastAPI runs on ASGI, so `async def` handlers share one event loop and keep serving other requests while each one waits on its IO. Plain `def` handlers still work because FastAPI offloads them to a threadpool, and the "fast" reputation is really that concurrency plus a lean Starlette core, the Uvicorn/uvloop server, and Pydantic v2's Rust validation core.

## What it is
FastAPI handlers come in two shapes: coroutines (`async def`) and ordinary functions (`def`). It subclasses Starlette and speaks **ASGI** (Uvicorn serves it), not the old **WSGI** model where a worker is pinned to one request from start to finish. On ASGI a single worker runs one **event loop** that keeps many IO-bound requests in flight at once - while one awaits the network or the database, the loop moves on to the next.

> [!KEY] `async def` runs **on** the event loop and must only ever `await`, never block. Plain `def` runs **off** it in a threadpool, so blocking there is safe. Choose by what the body does, not by habit.

One question picks the keyword: does the body `await` async IO, or call a blocking/sync library?

| Aspect | `async def` | `def` |
| --- | --- | --- |
| Where it runs | **on the single event loop** | **offloaded to a threadpool** |
| Reach for it when | the body **`await`s** async IO (`httpx`, async DB driver) | you call **blocking/sync** libs (`requests`, `psycopg2`, sync ORM) |
| Concurrency ceiling | thousands of in-flight IO waits per worker | capped at **~40 threads** (AnyIO limiter) |
| A blocking call inside | **freezes the loop** - every request on the worker stalls | **safe** - only that one thread blocks, the loop keeps serving |
| Pure transform, no IO | **best** - skips a pointless threadpool hop | a needless hop through the pool |

## Key points
- Reach for `async def` only when the body actually `await`s something - an async DB driver, `httpx.AsyncClient`, an async cache client. No `await` in there and you do not need it. The keyword is the tell.
- Got a blocking or sync library? Make the endpoint a plain `def`. FastAPI runs it in the threadpool and awaits the result, so it never blocks the loop. That is the safe default when you are unsure.
- The same rule governs **dependencies**: a `def` dependency is run in the threadpool, an `async def` one runs on the loop. A blocking `def` dependency injected into every route can quietly exhaust that shared threadpool.
- Stuck calling a blocking function from async code? Hand it to `run_in_threadpool(fn, ...)` and `await` that. You free the loop without rewriting the whole endpoint as `def`.
- Async buys **concurrency, not parallelism**. One worker is one event loop, in practice one core. To use all your cores, run more worker processes, not more `async`.
- **CPU-bound work** (image resizing, ML inference) gains nothing from async, since there is no waiting to overlap. Push it to a process pool or a task queue like Celery and keep it off the request path.
- The "fast" label is four things stacked: ASGI concurrency, a lean Starlette core, Uvicorn with uvloop, and Pydantic v2's compiled-Rust validation core. "On par with NodeJS and Go" describes that stack, not a benchmark to quote.

> [!TIP] It is async all the way down: an `async def` handler only helps if whatever it `await`s is itself async. `await` a sync library that secretly blocks and you get the worst of both - async syntax with a stalled loop.

## Example
```python
import httpx
from fastapi import FastAPI
from fastapi.concurrency import run_in_threadpool

app = FastAPI()

@app.get("/proxy")
async def proxy():
    # good: awaitable IO, so the loop stays free while the request is in flight
    async with httpx.AsyncClient() as client:
        r = await client.get("https://api.example.com/data")
    return r.json()

@app.get("/report")
async def report():
    # good: blocking lib called from async, so offload it and let the loop serve on
    return await run_in_threadpool(generate_pdf, report_id=42)

@app.get("/lookup")
def lookup(q: str):
    # good: sync driver in a plain def, FastAPI threadpools the whole handler for you
    return legacy_orm.search(q)

# avoid: requests.get(...), time.sleep(...), or a heavy loop inside async def freezes every request
```
```bash
uvicorn app:app --workers 4    # 4 processes, 4 event loops, 4 cores
```

## Interview Q&A
- **When do you use `async def` vs plain `def` for an endpoint?** `async def` when the body awaits something (async driver, `httpx`). Plain `def` for blocking or sync libraries, which FastAPI hands to its threadpool. Nothing to `await`? Plain `def` is the safe call.
- **Why is FastAPI considered fast?** ASGI concurrency lets one worker handle many IO-bound requests at once, on a lean Starlette core, a Uvicorn/uvloop server, and Pydantic v2 validation compiled to Rust.
- **What is the quickest way to tank an async endpoint?** Drop one blocking call into it. A sync HTTP request or a `time.sleep` blocks the event loop, and every concurrent request on that worker queues behind it.
- **Does going async speed up CPU-bound work?** No. Async only helps when there is IO to wait on and overlap. CPU-bound work needs real parallelism: more processes, a process pool, or a task queue.
- **How do you call a blocking function from inside an `async def`?** Do not call it directly. Offload it with `await run_in_threadpool(fn, ...)` (or `await asyncio.to_thread(fn, ...)`), so it runs on a worker thread while the loop keeps serving.

## Gotchas
> [!WARN] Never put a blocking call inside `async def`. A sync `requests.get`, a `time.sleep`, or a heavy CPU loop freezes the single event loop for **every** concurrent request on that worker. It hides well - fine with one local caller, then a latency cliff under real traffic.

> [!WARN] Do not call a **sync ORM** (sync SQLAlchemy, the Django ORM) directly inside `async def`. Reach for an async engine, or wrap the call in `run_in_threadpool`.

- The `def`-in-a-threadpool escape hatch is not free. The pool defaults to **40 threads** (AnyIO's limiter), shared across every sync handler and sync dependency you have. Lean on `def` for a genuinely slow endpoint and you can saturate it - once it is full, new requests wait for a thread to free up. Raise the limit, or better, move to an async driver.
- Each `--workers` process is its own event loop, threadpool, and **connection pool**. Four workers means roughly four times the DB connections, so size your database pool with the worker count in mind or you will exhaust it.
- Inside `async def`, reach for `await asyncio.sleep(...)`, never `time.sleep(...)`. The first **yields** to the loop, the second **blocks** it. That split runs through every library: the async variant yields, the sync one stalls.

## Revise next
- **[Background tasks](background-tasks.md) (`BackgroundTasks`)**: firing follow-up work after the response returns, without blocking the handler.
- **[Dependency injection](dependency-injection-depends.md) (`Depends`)**: sync vs async dependencies, and how a sync dependency also rides the threadpool.
- **Lifespan (`@asynccontextmanager`)**: opening and closing shared resources - a DB pool, an `httpx` client - once per worker at startup and shutdown.
- **[FastAPI vs Django](fastapi-vs-django.md)**: ASGI vs WSGI, and why a worker-per-request model cannot overlap IO the way one event loop can.

*Reviewed against FastAPI 0.139 / Pydantic 2.13, July 2026.*
