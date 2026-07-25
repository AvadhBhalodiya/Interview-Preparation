---
title: "Background Tasks"
group: "Dependencies & Async"
order: 6
---

# Background Tasks

> `BackgroundTasks` runs light work in the same process right after the response is sent, perfect for fire-and-forget email or logging, but nothing is persisted or retried, so anything you cannot afford to lose belongs in Celery or a real queue.

## What it is
- A way to defer work until **after the response has gone out**, so the client gets its answer without waiting on the slow part: sending a welcome email, writing an audit row, warming a cache.
- It comes from **Starlette** and FastAPI just re-exports it, so you import it from `fastapi`. The plural `BackgroundTasks` is the collection you inject into an endpoint. Starlette's singular `BackgroundTask` is a lower-level one-shot you attach to a `Response` by hand.
- You reach for it by declaring a `background_tasks: BackgroundTasks` parameter. FastAPI fills it in, and any task you add rides along with the response.

> [!KEY] This is **not a job queue or a thread server**. Whatever you add is attached to the response and run on the **same event loop and worker** the moment the body is flushed to the client, so it shares that worker's time and dies with it.

## Key points
- Queue work with `background_tasks.add_task(fn, *args, **kwargs)`. The **arguments are captured right then**, but `fn` does not run until the response is out.
- Match the function kind to the work, because the two are scheduled differently:

| Task kind | How Starlette runs it | Blocks the event loop? |
| --- | --- | --- |
| plain `def` | Pushed to the **threadpool** | **No** - blocking file or DB I/O is safe here |
| `async def` | Awaited **on the event loop** | **Yes if it blocks** - a sync call or CPU work stalls every request |

- Tasks fire **in the order you added them**, each one awaited before the next starts. They do **not** run concurrently, so one slow task delays the rest.
- **Dependencies can add tasks too.** Declare `BackgroundTasks` in a dependency and add to it there. FastAPI reuses the same object and merges the endpoint's tasks with every dependency's into one list.
- Good fits are **light jobs where dropping one now and then is survivable**: welcome emails, audit logging, cache invalidation, a quick webhook ping.
- Once you need **retries, persistence, scheduling, cross-process fan-out, or CPU-heavy work**, this is the wrong tool. Reach for Celery or another real queue (RQ, Dramatiq, arq).

The dividing line is durability - does the work have to survive a crash?

| Dimension | `BackgroundTasks` | Celery / task queue |
| --- | --- | --- |
| Where it runs | **Same process**, same event loop, after the response | **Separate worker** processes, often on other machines |
| Infrastructure | **None**, built in | **Broker required** (Redis/RabbitMQ) plus worker processes |
| Durability | **Ephemeral**, lost on crash or deploy | **Persisted** in the broker, survives restarts |
| Retries + scheduling | **None** | **Built in**: retries, countdown/ETA, cron beats |
| Results | **Fire-and-forget** only | **Result backend** can store return values |
| CPU-heavy work | **Blocks** the worker | **Scales out** across many workers |
| Best for | **Light, losable**: email, logs, cache warming | **Must-run or heavy**: payments, fulfillment, batch |

> [!TIP] Pick by one question: can you afford to lose this task? **Yes -> `BackgroundTasks`.** **No -> a durable queue.**

## Example
```python
from fastapi import BackgroundTasks, FastAPI

app = FastAPI()

def write_log(message: str):
    # plain def -> Starlette runs it in the threadpool, so blocking file I/O is fine
    with open("log.txt", "a") as f:
        f.write(message + "\n")

@app.post("/signup")
def signup(email: str, background_tasks: BackgroundTasks):
    create_user(email)
    background_tasks.add_task(send_welcome_email, email)   # queued, not called yet
    background_tasks.add_task(write_log, f"signup {email}")
    return {"status": "ok"}    # response goes out first, then the tasks run in order
```

A dependency can queue its own task, and FastAPI merges it with the endpoint's:

```python
from typing import Annotated
from fastapi import BackgroundTasks, Depends

def audit(background_tasks: BackgroundTasks, ua: str = ""):
    background_tasks.add_task(write_log, f"agent {ua}")    # added inside the dependency
    return ua

@app.post("/order")
def place_order(background_tasks: BackgroundTasks, _: Annotated[str, Depends(audit)]):
    background_tasks.add_task(write_log, "order placed")   # added in the endpoint
    return {"ok": True}    # both tasks run, in the order they were added
```

## Interview Q&A
- **When do background tasks actually run?** After the response is sent, on the **same event loop and worker** that handled the request. There is no separate process.
- **Does `add_task` call the function right away?** No. It records the function and its arguments and holds off until the response has gone out.
- **`def` vs `async def` task, does it matter?** Yes. A plain `def` is offloaded to the threadpool, so blocking I/O is safe. An `async def` runs on the loop, so a blocking call inside it stalls every other request.
- **Why not for critical jobs?** No persistence and no retries. If the worker restarts between the response and the task finishing, the task is gone with no record it existed. Payments and order fulfillment belong in a durable queue.
- **`BackgroundTasks` vs Celery in one line?** In-process, zero infra, ephemeral, versus a broker, separate workers, retries, and durability you pay for in ops overhead.

## Gotchas
> [!WARN] **No persistence, no retries.** A crash or a deploy between the response and the task completing **drops it silently**. Never put must-run work here - use a durable queue.

> [!WARN] "Background" oversells it: the task **shares the worker**. A CPU-bound or slow task still eats that worker's capacity, and a blocking `async def` task **stalls the event loop** for every other request on it.

- Tasks run after the response is committed, so they **cannot touch the status code or body**, and an exception inside one never reaches the client. It only surfaces in your server logs.
- They share one list and run **in sequence**, so if an earlier task raises, the ones queued behind it never run. Do not assume they are independent.
- Arguments are captured **by reference** at `add_task` time. Mutate a list or dict you passed before the response flushes and the task sees the mutated version, not the value at queue time.

## Revise next
- [Async endpoints](async-endpoints.md) and `run_in_threadpool`
- [Celery / Redis task queues](../task-processing/celery-architecture.md)
- [Dependency injection](dependency-injection-depends.md) and `Depends`

*Reviewed against FastAPI 0.139 / Pydantic 2.13, July 2026.*
