---
title: "Dependency Injection"
group: "Dependencies & Async"
order: 4
---

# Dependency Injection (`Depends`)

> `Depends` runs a callable and injects whatever it returns into your endpoint - that's how you share a DB session, auth, or pagination across routes without repeating the wiring, with results cached per request and `yield` handling setup and teardown.

## What it is
- Instead of building a DB session or re-checking the auth token at the top of every handler, you declare `param: Annotated[Thing, Depends(callable)]` and let FastAPI call the callable and hand you the result. The handler says what it needs, FastAPI works out how to get it.
- Dependencies can depend on other dependencies. FastAPI walks that tree once per request, resolves each piece, and injects it where you asked. Those same declarations also feed the OpenAPI schema, so a required header or query param shows up in the interactive docs on its own.

> [!KEY] **Inversion of control**: the handler names the type it needs and FastAPI owns the wiring - constructing, caching, and tearing down the value. You depend on the result, never on how it was built.

## Key points
Everything `Depends` gives you, in one place:

| Capability | What it does |
| --- | --- |
| **Sub-dependencies** | A dependency can itself take `Depends` params. FastAPI resolves the **whole tree once per request** and injects each result. |
| **Per-request caching** | A dependency reached from several places runs **once per request** by default, so every call site gets the same value. `use_cache=False` forces a fresh call. |
| **Class dependencies** | `Depends(MyClass)` runs `__init__` and injects the **instance**. With a matching type hint, `Depends()` with no argument infers the class. |
| **`yield` teardown** | Code before `yield` is setup, the yielded value is injected, the `finally` block is **teardown**. Stacked deps tear down **LIFO**. |
| **Path / router / global deps** | Attach at one route, on `APIRouter(dependencies=[...])`, or on `FastAPI(dependencies=[...])`. These run for their **side effect only** (auth, rate limit) and the return value is discarded. |

- Reach for the `Annotated[Session, Depends(get_db)]` form, then hoist it into an alias like `DBSession = Annotated[Session, Depends(get_db)]` and reuse that across routes.
- Pass the function, do not call it. `Depends(get_db)` is correct. `Depends(get_db())` evaluates `get_db()` once at import time, which is never what you want.
- In tests, swap any dependency with `app.dependency_overrides[get_db] = fake_db`. It applies everywhere the real one is used, sub-dependencies included. Reset with `app.dependency_overrides.clear()` between tests.

Since FastAPI 0.121 a `yield` dependency chooses when its teardown fires via `scope`:

| `scope` | Teardown runs | Reach for it when |
| --- | --- | --- |
| `"request"` (**default**) | **After** the response is sent | Ordinary cleanup: closing a session, releasing a connection |
| `"function"` | **Before** the response, right after the handler returns | Cleanup that must be able to **fail the request**, like a commit that should surface as a 500 |

## Example
```python
from typing import Annotated
from fastapi import Depends, FastAPI, Header, HTTPException
from sqlalchemy.orm import Session

app = FastAPI()

def get_db():                              # yield dependency: setup + teardown
    db = SessionLocal()
    try:
        yield db                           # injected here; close() runs after the response
    finally:
        db.close()

DBSession = Annotated[Session, Depends(get_db)]   # reusable alias

def get_current_user(db: DBSession, authorization: Annotated[str, Header()] = ""):
    user = lookup(db, authorization)       # one dependency leaning on another
    if not user:
        raise HTTPException(status_code=401, detail="invalid token")
    return user

@app.get("/me")
def me(user: Annotated[User, Depends(get_current_user)]):
    return user                            # get_db resolved once, cached, torn down after
```

A class is a dependency too - `Depends()` with no argument infers it from the type hint:

```python
class Pagination:                          # __init__ params are validated like query params
    def __init__(self, skip: int = 0, limit: int = 100):
        self.skip, self.limit = skip, limit

@app.get("/items")
def list_items(page: Annotated[Pagination, Depends()]):   # Depends() infers Pagination
    return items[page.skip : page.skip + page.limit]
```

## Interview Q&A
- **What does `Depends` actually buy you?** Reuse, mostly. Write the DB session, current-user lookup, or pagination params once and inject them wherever you need them, and because they are ordinary parameters they get validated and documented like everything else.
- **Why `yield` instead of `return`?** Because you need teardown. Open the session, `yield` it, close it in `finally`. When several `yield` dependencies are stacked, their exit blocks run in reverse (LIFO) order, same as nested context managers.
- **Does a shared dependency run twice in one request?** No, it is cached per request by default, so both call sites get the same value. Pass `use_cache=False` if you actually want a fresh call.
- **When does `yield` teardown run relative to the response?** After it by default (`scope="request"`). Switch to `scope="function"` when the cleanup has to be able to fail the request.
- **How do you replace a dependency in a test?** `app.dependency_overrides[real] = fake`, then clear it afterward so it does not leak into the next test.

## Gotchas
> [!WARN] Catch an exception in a `yield` dependency and forget to re-raise it, and FastAPI never learns it happened - nothing is logged and the client just gets a bare 500. Re-raise the original, or raise a fresh `HTTPException` in its place.

> [!WARN] A sync (`def`) dependency runs in the same bounded threadpool as your sync endpoints (AnyIO's, around 40 threads). One doing slow blocking I/O holds a thread for the whole call, so enough concurrent requests drain the pool and leave the rest queued. On a hot path, back it with an async library and mark the dependency `async`.

- Per-request caching means a dependency with side effects fires once, not once per place you inject it. Counting on it running every time is a real bug, so pass `use_cache=False` when you actually need that.
- Scopes have to nest by lifetime. A `scope="request"` dependency cannot sit on top of a `scope="function"` one, since the shorter-lived sub-dependency is torn down before the parent that still needs it. FastAPI validates this and errors, so keep a sub-dependency at least as long-lived as whatever depends on it.

## Revise next
- **[Async endpoints](async-endpoints.md)** - when to use `async def` vs `def` and how the threadpool fits in.
- **[Response models](response-models.md)** - shaping and filtering output with `response_model`.
- **Auth via dependencies** - the OAuth2 password flow and JWT built as `Depends`.

*Reviewed against FastAPI 0.139 / Pydantic 2.13, July 2026.*
