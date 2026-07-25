---
title: "OpenAPI / Swagger Docs"
group: "Docs & Framework Choice"
order: 7
---

# Auto OpenAPI / Swagger Docs

> FastAPI turns your type hints and Pydantic models into a standards-compliant OpenAPI 3.1 schema at `/openapi.json`, then serves two live UIs off it: interactive Swagger UI at `/docs` and read-only ReDoc at `/redoc`.

## What it is
FastAPI introspects every path operation - its type hints, request and response models, parameter metadata, `response_model`, and status code - and assembles the OpenAPI 3.1 document for you at `/openapi.json`. You never write that document by hand.

> [!KEY] Your **annotations are the contract**. The same hints and models that already validate requests and serialize responses are what generate `/openapi.json`, so the docs are only ever as good as the handlers behind them. `/docs` and `/redoc` just **render** that one file, generating nothing themselves.

Everything in a path operation feeds that single document:

| Source in your handler | What it adds to `/openapi.json` |
| --- | --- |
| Function **type hints** | parameter and return types, and whether each param is required |
| **Pydantic models** | full JSON Schema for request and response **bodies**, nested fields and all |
| `Path()` / `Query()` / `Body()` | per-param **title, description, constraints** (`ge`, `max_length`) and examples |
| `response_model` + status code | the **success** response shape and its HTTP code |
| `tags`, `summary`, docstring | **grouping and human docs**: bucket, short label, long Markdown description |
| `responses={...}` | extra **error** response shapes (404, 409, ...) beyond the 200 |

## Key points
Swagger UI and ReDoc are just two renderings of the same `/openapi.json`, so pick by audience:

| Endpoint | What it serves | Interactive | Reach for it when |
| --- | --- | --- | --- |
| `/openapi.json` | the **machine-readable** OpenAPI 3.1 spec | no | feeding client generators or contract tests |
| `/docs` | **Swagger UI** over the spec | **yes** - fires real requests | poking the API by hand while developing |
| `/redoc` | **ReDoc** over the spec | no - **read-only** | handing a clean reference to API consumers |

- **OpenAPI 3.1 by default** since FastAPI 0.99. Because 3.1 is built on **JSON Schema**, Pydantic v2's generated schema drops straight into the spec, examples and all. Under the older 3.0 output those examples had to be translated first.
- **App-wide metadata** goes on the constructor: `title`, `version`, `description`, `summary`, `contact`, `license_info`, `terms_of_service`. `description` and `summary` render as **Markdown** at the top of the docs.
- **Per-route knobs** live on the decorator: `tags` to bucket it, `summary` for the short label, the **docstring** for the long description, `response_description`, and `deprecated=True` to strike it through without removing it. `openapi_tags` on the app then adds a blurb under each tag heading.
- **Document the failures**, not just the 200: `responses={404: {"model": Error}}` tells clients what an error body looks like. Leave it out and the spec pretends only the happy path exists.
- **Security schemes register themselves**: declare `OAuth2PasswordBearer`, an API-key header, anything subclassing `SecurityBase`, and Swagger UI grows an Authorize button plus a padlock on each protected route.
- **Toggle the endpoints** with `docs_url`, `redoc_url`, and `openapi_url` - each takes a new path (to move it) or `None` (to switch it off).

There are three ways to attach examples, and only one gives the try-it-out dropdown:

| Mechanism | Where it lives | Shows up as |
| --- | --- | --- |
| `json_schema_extra={"examples": [...]}` | on the **Pydantic model** | a whole-payload example in the schema |
| `Field(examples=[...])` | on a **single field** | that field's example in the schema |
| `openapi_examples={...}` | on `Body()` / `Query()` / `Path()` | the **labeled dropdown** in try-it-out (each entry has its own `summary`, `description`, `value`) |

> [!TIP] Treat `/openapi.json` as a **contract**. Point a client generator (TypeScript, Go) at it or wire it into a contract test, and your frontend and backend cannot drift apart without something failing loudly.

## Example
One endpoint wired up with app metadata, a typed error response, and a model example:

```python
from fastapi import FastAPI, HTTPException
from pydantic import BaseModel

class Order(BaseModel):
    id: int
    total: float
    # whole-payload example -> shows in the schema and both UIs
    model_config = {"json_schema_extra": {"examples": [{"id": 1, "total": 42.0}]}}

class Error(BaseModel):
    detail: str                               # matches FastAPI's default error body

app = FastAPI(
    title="Orders API",
    version="1.0.0",
    summary="Create and read orders.",        # one-liner atop the docs
    description="Internal service for the orders team.",   # Markdown
)

@app.get(
    "/orders/{order_id}",
    response_model=Order,                     # describes the 200 body
    tags=["orders"],                          # buckets it in the UI
    summary="Get one order",                  # short label
    responses={404: {"model": Error, "description": "No order with that id"}},
)
def get_order(order_id: int):
    """Look up a single order by its **id**."""   # docstring -> long description
    if order_id != 1:
        raise HTTPException(status_code=404, detail="not found")
    return Order(id=1, total=42.0)

# Swagger UI: /docs   ReDoc: /redoc   raw spec: /openapi.json
```

## Interview Q&A
- **Where do the docs come from?** Introspection. FastAPI reads your type hints, Pydantic models, and decorator metadata into an OpenAPI 3.1 schema, and the UIs just render it. Nothing is written by hand.
- **What is served, and where?** `/openapi.json` is the machine-readable spec, `/docs` is Swagger UI (interactive), and `/redoc` is ReDoc (read-only). All three are on by default, live, with no build step.
- **How do you group and label endpoints?** `tags` on each route buckets them, `openapi_tags` on the app describes each bucket, `summary` is the short label, and the docstring is the long description.
- **How do you get the Authorize button?** Declare a security-scheme dependency like `OAuth2PasswordBearer`. Anything inheriting from `SecurityBase` registers in the spec, and Swagger UI draws the auth UI for it.
- **How do you turn docs off in production?** `docs_url=None` and `redoc_url=None` hide the two UIs. `openapi_url=None` removes the spec too, which takes both UIs down with it. Just remember that is obscurity, not access control.

## Gotchas
> [!WARN] `openapi_url=None` also takes down `/docs` and `/redoc`, because both fetch the spec at runtime. And hiding any of them is **obscurity, not security** - the routes still exist and still respond, so put real auth on the endpoints.

> [!WARN] Swagger UI's "Try it out" fires real requests at your **running server**, not a sandbox. On a shared or production box those are live reads and writes, so watch what you send.

- Return a bare `dict` or a raw `Response` with no `response_model` or return-type hint and FastAPI has nothing to describe the body with, so it lands in the spec as **unspecified** - an invisible field to anyone generating a client off your schema.
- Model and field examples populate the **schema**, but only `openapi_examples` produces the **multi-example dropdown** in try-it-out. Added examples to your model and don't see the dropdown? That is why.
- Want the raw spec for internal tooling but no public UI? Do the opposite of a full blackout: keep `openapi_url` and set only `docs_url` and `redoc_url` to `None`.

## Revise next
- **[Response models](response-models.md)** - `response_model`, `response_model_exclude_none`, and filtering which fields go out.
- **[Pydantic v2 models & validation](pydantic-models-validation.md)** - `Field`, `field_validator`, `ConfigDict`, and how `model_json_schema()` becomes the spec.
- **[Path/Query/Body parameters](path-query-body-parameters.md)** - the metadata and constraints (`ge`, `max_length`, `title`) that surface in the schema.

*Reviewed against FastAPI 0.139 / Pydantic 2.13, July 2026.*
