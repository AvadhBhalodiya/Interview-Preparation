---
title: "Path, Query & Body Params"
group: "Requests & Validation"
order: 1
---

# Path, Query & Body Parameters

> FastAPI reads your typed function parameters and works out where each value comes from: a name in the route is a path param, a plain scalar is a query param, and a Pydantic model is the JSON body, all validated and coerced against your annotations.

## What it is
You declare each input as a typed parameter and FastAPI does the rest: it reads the value off the request, coerces it to the annotated type, validates it, and lists it in the OpenAPI schema. No `request.args.get`, no hand-written `int(...)` casts.

It figures out *where* each value comes from using two signals: whether the name appears in the route, and what type you gave it. Path, query, and body are the daily three. Header and Cookie follow the identical pattern when you need them.

> [!KEY] FastAPI resolves each parameter by **name first, then type**: a name matching `{...}` in the route is a **path** param, a Pydantic model (or anything tagged `Body()`) is the **body**, and every remaining scalar falls through to the **query** string.

## Key points
Each parameter kind comes from a different part of the request and is declared with its own marker class:

| Kind | Comes from | FastAPI picks it when | Declare / constrain with | Required by default? |
| --- | --- | --- | --- | --- |
| **Path** | a URL path segment | the name matches **`{name}`** in the route | `Path(gt, ge, lt, le, ...)` | **Always** - it is part of the URL |
| **Query** | the `?key=value` string | it is a scalar whose name is **not** in the route | `Query(min_length, max_length, pattern, ...)` | **Only if it has no default** |
| **Body** | the JSON request body | it is a **Pydantic model**, or a scalar marked `Body()` | `Body(embed, ...)` plus the model's `Field(...)` | Follows each field's default |
| **Header** | HTTP request headers | the scalar is marked **`Header()`** | `Header(convert_underscores, ...)` | Only if it has no default |
| **Cookie** | the `Cookie` request header | the scalar is marked **`Cookie()`** | `Cookie(...)` | Only if it has no default |

- **Path params are always required.** A path param is baked into the URL, so there is no optional one and a default will not create it. The raw string is coerced to your annotation, so a non-integer against `item_id: int` fails with a 422 before the handler ever runs.
- **A query param is optional only if it has a default.** `q: str | None = None` is optional, `q: str` is required. The default alone decides that, which is exactly how people make a param required by accident.
- **One body model = the JSON body itself**, with no wrapper key. Add a **second** body param and FastAPI nests every body value under a key named after its parameter, so the whole payload shape shifts under you.
- **`Path()`, `Query()`, `Body()` hold the constraints and docs**: numeric `gt`/`ge`/`lt`/`le`, string `min_length`/`max_length`/`pattern`, plus `title`, `description`, `examples`, and `alias`. It is `pattern`, not `regex` - the `regex=` keyword was dropped in the Pydantic v2 move.
- **`Header()` converts underscores to hyphens** by default, so a `user_agent` param reads the `User-Agent` header. Pass `convert_underscores=False` to switch that off.

> [!TIP] Prefer `Annotated[int, Path(gt=0)]` over `item_id: int = Path(gt=0)`. With `Annotated` the real default stays in the default slot, so the function is still callable as a plain function, type checkers stay quiet, and you dodge the "non-default argument follows default argument" ordering trap.

## Example
```python
from typing import Annotated
from fastapi import FastAPI, Path, Query, Header
from pydantic import BaseModel

app = FastAPI()

class Item(BaseModel):
    name: str
    price: float

@app.put("/items/{item_id}")
async def update(
    item_id: Annotated[int, Path(gt=0)],                    # path: in the route, must be > 0
    item: Item,                                             # body: the JSON *is* the Item
    q: Annotated[str | None, Query(max_length=50)] = None,  # optional query param (?q=)
    user_agent: Annotated[str | None, Header()] = None,     # reads the User-Agent header
):
    return {"item_id": item_id, "q": q, "ua": user_agent, **item.model_dump()}
```

Force a lone scalar into the body (it would otherwise be a query param), and wrap a single model under a key:

```python
from fastapi import Body

@app.put("/items/{item_id}")
async def patch(
    item_id: int,
    importance: Annotated[int, Body()],       # lands in the JSON body, not the query
    item: Annotated[Item, Body(embed=True)],  # body nests under {"item": {...}}
):
    return {"item_id": item_id, "importance": importance, **item.model_dump()}
```

## Interview Q&A
- **How does FastAPI decide path vs query vs body?** Name in the route means path. A Pydantic model (or anything marked `Body()`) means body. Any leftover scalar falls through to the query string.
- **Optional vs required query param?** A default makes it optional, no default makes it required. `str | None` only says `None` is an *allowed value*, not that the client may omit the param - two different things people constantly conflate.
- **Why prefer `Annotated` over `= Query(...)`?** It keeps the real default where Python expects it, so the function still runs as a plain function, your IDE and type checker stay happy, and there is no parameter-ordering headache.
- **What happens on invalid input?** An automatic 422 with a JSON list of what failed and where. Your handler never runs, so you write none of those checks by hand.
- **How do you put a scalar in the body instead of the query?** Mark it `Annotated[int, Body()]`. Unmarked scalars default to the query string.

## Gotchas
> [!WARN] A scalar with **no default is a required query param**. Drop the `= None` and callers suddenly get 422s for a field you assumed was optional.

> [!WARN] Going from **one body model to two silently rewrites the request shape**: every body value now nests under its parameter name. Want that wrapping with a single model? Ask for it with `Body(embed=True)`. If you did not, you just broke every existing client.

The `str | None` annotation and the default are two independent switches, and mixing them up is the classic accidental 422:

| Declaration | Client may omit it? | Is `None` a valid value? |
| --- | --- | --- |
| `q: str` | **No** (required) | No |
| `q: str = "x"` | **Yes** (optional) | No |
| `q: str \| None = None` | **Yes** (optional) | Yes |
| `q: str \| None` | **No** (required) | Yes - **required-but-nullable** |

- A lone scalar like `importance: int` goes to the **query string, not the body**. Mark it `Annotated[int, Body()]` to land it in the JSON, or lose ten minutes wondering why it keeps arriving as `None`.
- **`Header()` and `Cookie()` are mandatory** for those params. An unmarked scalar is read as a query param, never off the headers or cookies.
- Run into `Query(regex=...)` in older code? It is `pattern=` now, since Pydantic v2.

## Revise next
- [Pydantic models & validation](pydantic-models-validation.md) (`Field`, `field_validator`, `model_validator`)
- [Response models](response-models.md) & `response_model`
- [Dependency injection](dependency-injection-depends.md) (`Depends`)

*Reviewed against FastAPI 0.139 / Pydantic 2.13, July 2026.*
