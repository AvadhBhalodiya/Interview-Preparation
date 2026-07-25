---
title: "Pydantic v1 vs v2"
group: "Requests & Validation"
order: 2
---

# Pydantic Models & Validation (v1 vs v2)

> A Pydantic `BaseModel` turns type hints into runtime validation and coercion. v2 rewrote the core in Rust and renamed most of the public API (`model_dump`, `model_validate`, `field_validator`, `ConfigDict`, `pattern=`, `from_attributes`), while leaving the old v1 API reachable under the `pydantic.v1` namespace for migration.

## What it is
- Pydantic lets you declare a schema as a typed class, hand it untrusted input (a dict, a JSON string, an ORM row), and get back either an instance coerced to your annotated types or a `ValidationError`. That is the exact machinery FastAPI runs on every request body and response model.
- v2 landed in mid-2023 as a near-total rewrite. The validation core moved into `pydantic-core`, a compiled Rust library, so it is far faster than v1 (Pydantic's own numbers put it at 5-50x, depending on the model). The Python API was renamed in the same release, and that rename is what most interview questions circle around.
- Anything current runs on v2. FastAPI added v2 support in 0.100 (July 2023) and 0.139 is no exception. So when you spot `.dict()` or an inner `class Config` in a codebase, you are looking at v1-era code coasting on v2's deprecation shims.

> [!KEY] v2 kept the **mental model** (hints in, validated model out) and only rewrote the **surface**: every model method gained a **`model_` prefix** so the library can never collide with a field you named `dict`, `json`, or `copy`. That one rule explains most of the new names.

The full v1 -> v2 cheat sheet you are expected to recall:

| v1 | v2 |
| --- | --- |
| `m.dict()` | **`m.model_dump()`** |
| `m.json()` | **`m.model_dump_json()`** (one Rust pass) |
| `Model.parse_obj(d)` | **`Model.model_validate(d)`** |
| `Model.parse_raw(s)` | **`Model.model_validate_json(s)`** |
| `Model.construct()` | **`Model.model_construct()`** (skips validation) |
| `class Config:` | **`model_config = ConfigDict(...)`** |
| `orm_mode = True` | **`from_attributes=True`** |
| `allow_population_by_field_name` | **`populate_by_name=True`** |
| `@validator("x")` | **`@field_validator("x")`** + `@classmethod` |
| `@root_validator` | **`@model_validator`** (modes: before, after, wrap) |
| `Field(regex=...)` | **`Field(pattern=...)`** |
| `Field(const=v)` | **removed** - use `Literal[v]` |
| `@property` (not serialized) | **`@computed_field`** + `@property` (serialized) |
| `Optional[x]` implied `= None` | **`Optional[x]` is required** - add `= None` |
| `BaseSettings` (in `pydantic`) | **`pydantic-settings`** (separate package) |

## Key points
- The renames are not churn. The `model_` prefix keeps framework methods from clashing with your field names, so the rule is mechanical once you see it.
- Keep the two directions straight. **`model_validate()`** / **`model_validate_json()`** take raw input and hand back a checked model. **`model_dump()`** / **`model_dump_json()`** run the other way, turning a model into a plain dict or a JSON string for the wire.
- Validators split by scope. Field validators run per field, model validators run once on the finished instance, so cross-field rules (password matches confirm, end after start) belong there:

| Decorator | Scope | Signature | Sees | Use for |
| --- | --- | --- | --- | --- |
| **`@field_validator("x")`** | **one field** | `@classmethod`, `(cls, v)` | coerced value (defaults to `after`) | per-field cleanup, format checks |
| **`@model_validator(mode="after")`** | **whole model** | instance method, `(self)` | every typed field via `self` | cross-field invariants |

- Modes control timing. `before` sees the **raw input** (reshape a messy payload first), `after` sees **coerced, typed values**, and `wrap` gets **both** and calls the inner validator itself.
- Put constraints in `Annotated`. The idiomatic v2 form is `Annotated[str, Field(min_length=1)]`, not `x: str = Field(min_length=1)` - the assignment form reads like a default while the field is still required. Keep `default`, `default_factory`, and `alias` on the assignment side so type checkers stay happy.
- The FastAPI tie-in is direct. Declare a `BaseModel` parameter and the framework reads the JSON body, coerces, validates, and on a bad payload returns a **422** with a field-level error list, all Pydantic v2 underneath. Give the route a `response_model` and it runs `model_dump()` for you on the way out.

> [!TIP] Reach for **`model_dump_json()`** over `json.dumps(m.model_dump())`. It is a single Rust pass and it serializes types stdlib `json` chokes on, like `datetime`, `UUID`, and `Decimal`.

## Example
```python
from typing import Annotated
from pydantic import BaseModel, ConfigDict, Field, computed_field, field_validator, model_validator

class User(BaseModel):
    model_config = ConfigDict(from_attributes=True)   # was: class Config: orm_mode = True

    name: Annotated[str, Field(min_length=1)]
    email: Annotated[str, Field(pattern=r".+@.+")]    # was: regex=
    age: int | None = None                            # without "= None" this is REQUIRED in v2

    @field_validator("name")     # was: @validator("name"); decorator on top, classmethod under
    @classmethod
    def strip_name(cls, v: str) -> str:
        return v.strip()

    @model_validator(mode="after")   # whole-model check; instance method, sees typed fields
    def non_negative_age(self) -> "User":
        if self.age is not None and self.age < 0:
            raise ValueError("age must be non-negative")
        return self

    @computed_field   # serialized like a real field; a manual hack in v1
    @property
    def is_adult(self) -> bool:
        return self.age is not None and self.age >= 18

u = User.model_validate({"name": " Ann ", "email": "a@b.co"})  # was: User.parse_obj(...)
u.model_dump()        # {"name": "Ann", "email": "a@b.co", "age": None, "is_adult": False}
u.model_dump_json()   # was: u.json()
```

## Interview Q&A
- **What actually changed from v1 to v2?** Two things. The validation core became a compiled Rust library (`pydantic-core`), and nearly every method gained a `model_` prefix (`model_dump`, `model_validate`, `model_construct`), with `field_validator` and `ConfigDict` alongside. Same mental model, new surface.
- **How do you read from an ORM object in v2?** Set `model_config = ConfigDict(from_attributes=True)`, then call `Model.model_validate(orm_row)`. That replaces v1's `orm_mode` plus `from_orm()`.
- **What replaced `@validator` and `@root_validator`?** `@field_validator` for a single field (with `@classmethod`) and `@model_validator` for the whole model (modes: `before`, `after`, `wrap`). The old decorators still import, but they warn.
- **Is `x: int | None` optional in v2?** No, it is required and nullable. The caller must send the field, and `None` is just one allowed value. Add `= None` to make it optional. This is the one real behavior change (not a rename) that bites people mid-migration.
- **When would you reach for `model_construct()`?** To build a model and skip validation, say re-wrapping DB rows you already trust on a hot path. It is faster but will happily hold invalid data, so only point it at input you have already validated.

## Gotchas
> [!WARN] The optional/required flip is the classic upgrade bug. `Optional[x]` or `x | None` with **no default is required** in v2, so right after upgrading you get "Field required" 422s on fields that used to fall back to `None`. Add the `= None`.

> [!WARN] **`model_construct()` skips all validation and coercion.** It is a performance escape hatch, not a safe constructor. Feed it untrusted input and you get a model full of invalid data with no error raised.

- The deprecated surface still runs, it just warns. `.dict()`, `.json()`, `.parse_obj()`, and the inner `class Config` all work with a deprecation warning. A couple of things were removed outright: `Field(const=...)` (use `Literal[...]`) and `allow_mutation` (use `Field(frozen=True)`). Do not build new code on any of it.
- `BaseSettings` is not in `pydantic` anymore. Run `pip install pydantic-settings` and import from `pydantic_settings`. The import error reads like a typo, which is why it catches people out.
- Coercion is lax by default, so the string `"123"` sails through as an `int`. If you want that to fail, turn on strict mode at the level you need: `Field(strict=True)`, `ConfigDict(strict=True)`, or `model_validate(..., strict=True)`.
- Do not hand-roll email or URL checks. Pydantic ships `EmailStr` (via `pip install "pydantic[email]"`), `HttpUrl`, and friends, all better tested than the throwaway `.+@.+` regex above.

## Revise next
- [Path/Query/Body parameters](path-query-body-parameters.md) and [`response_model`](response-models.md)
- [Dependency injection](dependency-injection-depends.md) (`Depends`)
- App startup/shutdown via the `lifespan` context manager (replaces `@app.on_event`)

*Reviewed against FastAPI 0.139 / Pydantic 2.13, July 2026.*
