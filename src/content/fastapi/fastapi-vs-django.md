---
title: "FastAPI vs Django"
group: "Docs & Framework Choice"
order: 8
---

# FastAPI vs Django: When to Pick Which

> FastAPI is a lean, async, type-driven API framework built on Starlette and Pydantic where you bring your own ORM, auth, and admin, while Django ships all of that in the box. Lean toward FastAPI for high-throughput or ML/LLM-serving APIs, and toward Django/DRF when you want a full web app delivered fast.

## What it is
- **FastAPI** is a thin async layer over two libraries. Starlette gives it the ASGI server, routing, and websockets. Pydantic v2 does validation and serialization. FastAPI's own contribution is the typed path operations, dependency injection (`Depends`), and automatic OpenAPI docs on top. Everything past that is your call.
- **Django** takes the opposite bet: one mature, opinionated framework where the ORM, migrations, admin, auth, templates, and forms ship together and expect to be used together. For JSON APIs you add **Django REST Framework (DRF)** on top.

> [!KEY] FastAPI is **a small typed core you assemble around** (bring your own ORM, auth, admin). Django is **a full framework you fit into** (batteries included). Almost every other difference follows from that one bet.

At a glance, the two split on nearly every axis:

| Aspect | FastAPI | Django (+ DRF) |
| --- | --- | --- |
| Type | **async** ASGI micro-framework | **batteries-included** full framework |
| Core | Starlette + **Pydantic v2** | self-contained, **no core deps** |
| Ships with | routing, validation, DI, **auto docs** | **ORM, migrations, admin, auth, templates** |
| Data layer | **BYO ORM** (SQLAlchemy / SQLModel), Alembic | **built-in ORM** + migrations |
| API docs | **auto OpenAPI** (Swagger, ReDoc) | DRF serializers + **drf-spectacular** |
| Async | **async-first**, day one | **partial**: async views/ORM, sync admin |
| Best for | **async APIs, microservices, ML/LLM serving** | **full web apps, CRUD, admin, content sites** |

> [!TIP] Both can cross over - FastAPI serves templates and static files, Django runs async views - so pick by the **defaults you get for free**, not by what is merely possible.

## Key points
- **Built-in scope is the whole story.** Django hands you the ORM, migrations, admin, and auth already wired up, so you learn its way and go. FastAPI gives you routing, validation, DI, and docs, then steps back: you pick the ORM (SQLAlchemy or SQLModel), migrations (usually Alembic), and auth, then glue them yourself. More freedom, more decisions you now own.
- **Async: FastAPI starts where Django is catching up.** Starlette is ASGI-native, so FastAPI has been async since day one. Django's async is real but partial - async views and the `a`-prefixed ORM methods (`acreate`, `asave`, `afirst`, `async for`) exist, but transactions and the admin still run sync-only.
- **Validation and docs are free in FastAPI, hand-wired in DRF.** FastAPI reads your type hints, validates the body with Pydantic v2, and serves OpenAPI at `/docs` (Swagger) and `/redoc` (ReDoc), none of which you write. DRF reaches the same place with explicit serializers plus drf-spectacular: more boilerplate, more control.
- **Faster, with an asterisk.** On IO-bound JSON, FastAPI lands near the top of the Python frameworks on TechEmpower, not far off the raw Starlette/Uvicorn stack it runs on. Much of that is Pydantic v2, whose validation core is compiled Rust and runs roughly 5-50x faster than v1. Django trades raw throughput for structure and batteries.
- **Pick FastAPI** for a high-throughput async API, a microservice, or model/LLM serving where you want a small typed surface with nothing you did not ask for. **Pick Django/DRF** for a whole web app in a hurry: a free admin, fast CRUD over messy relational data, and a deep ecosystem where most decisions are already made.

## Example
```python
# FastAPI: the type hints ARE the schema - validation, JSON parsing, and /docs come free
from fastapi import FastAPI, Depends
from pydantic import BaseModel, Field, field_validator

app = FastAPI()

class Item(BaseModel):
    name: str
    price: float = Field(gt=0)              # constraint surfaces in the OpenAPI schema

    @field_validator("name")                # Pydantic v2 name (was @validator in v1)
    @classmethod
    def not_blank(cls, v: str) -> str:
        if not v.strip():
            raise ValueError("name is required")
        return v

def get_db():                               # a dependency, injected by Depends
    ...

@app.post("/items")
def create(item: Item, db=Depends(get_db)) -> Item:
    return item                             # body validated by Pydantic, response shape -> /docs
```

Django + DRF reaches the same endpoint through more moving parts, but the ORM, admin, and migrations come along for free:

```python
# Django + DRF: model + serializer + viewset + router + settings, but the batteries are included
class ItemSerializer(serializers.ModelSerializer):
    class Meta:
        model = Item                        # a django.db.models.Model
        fields = ["name", "price"]

class ItemViewSet(viewsets.ModelViewSet):   # full CRUD from one class
    queryset = Item.objects.all()
    serializer_class = ItemSerializer
# router.register("items", ItemViewSet) wires the URLs and DRF renders the browsable API
```

## Interview Q&A
- **When would you reach for FastAPI over Django?** High-throughput async APIs, microservices, or ML/LLM serving, where you want a minimal typed stack that documents itself and you do not need templates or an admin.
- **And Django over FastAPI?** When you want a full web app quickly and the built-ins are the point: ORM, migrations, admin, auth, and templates in the box, especially over complex relational data with heavy CRUD.
- **Is FastAPI just the better choice because it is faster?** It is faster on IO-bound JSON, and benchmarks back that up, but they only measure framework overhead. For a full app Django's built-ins usually win on time-to-ship, and for CPU-bound work your architecture and DB access patterns set the latency, not the framework.
- **Can Django do async, and can FastAPI do a full app?** Both, with caveats. Django's async is real but partial (no async transactions, sync admin). FastAPI can serve templates and static files because it is Starlette underneath, and third-party admins exist, but you still assemble the ORM, auth, and admin yourself. They just start from opposite defaults.

## Gotchas
> [!WARN] Know whether each endpoint is `def` or `async def`. FastAPI runs a plain `def` in a threadpool, but a **blocking call inside an `async def`** (a sync DB driver, `time.sleep`, `requests.get`) stalls the event loop for **every request that worker is handling**. It is the most common FastAPI performance bug and stays silent until real load.

> [!WARN] Django's async is real but full of holes. The views and ORM methods are there, but **transactions and the admin still run sync-only**, so touching sync ORM code from an `async def` view raises `SynchronousOnlyOperation`. Do not assume the whole stack is async just because the view is.

- **"FastAPI is faster" is a line about IO-bound benchmarks.** For CPU-bound work or a real app, your database access patterns and overall architecture dwarf whatever the framework costs you.
- **Minimalism has a price.** You own the ORM, migrations, auth, and admin, and the glue holding them together is real code you write, test, and maintain. It is easy to lowball when you scope the project.
- **"FastAPI is API-only" is overstated but not wrong.** It can serve HTML and static files (Starlette underneath), and third-party admin panels like SQLAdmin and Starlette-Admin exist. But nothing matches Django's batteries-included admin, so for a full web app with an admin, Django is the shorter path.

## Revise next
- **[Async endpoints and the event loop](async-endpoints.md)**: why FastAPI is fast, and how one blocking call kills it.
- **ASGI vs WSGI**, and running Uvicorn workers under Gunicorn.
- **[Pydantic v2 models, validators, and serialization](pydantic-models-validation.md)** (`model_validate`, `model_dump`, `field_validator`, `model_validator`, `ConfigDict`), FastAPI's real workhorse.
- **FastAPI [`Depends`](dependency-injection-depends.md), [`BackgroundTasks`](background-tasks.md), and `lifespan`** for DI, deferred work, and startup/shutdown resources.
- **[Django's request/response cycle](../django/mtv-request-response-cycle.md) and [DRF serializers](../drf/serializers.md).**

*Reviewed against FastAPI 0.139 / Pydantic 2.13, July 2026.*
