---
title: "Response Models"
group: "Requests & Validation"
order: 3
---

# Response Models (`response_model`)

> `response_model` (or a `-> Model` return type) tells FastAPI the exact shape an endpoint sends back, and whatever you return gets pushed through that model first, so a full DB row can go in and only the declared fields come out.

## What it is
- A **response model** is just a Pydantic model describing what comes out of an endpoint. The part worth internalizing: FastAPI serializes *that model*, not the object you handed it, so your return value is **coerced into the model first**.
- **Two ways to declare it.** A `-> UserOut` return annotation is what you reach for most, and your editor and mypy check it for free. `response_model=UserOut` on the decorator does the same job, and you use it when what you return **isn't actually that type** - a dict, a raw ORM row, or a union. Set both and `response_model` is the one that runs.

> [!KEY] FastAPI serializes the **model, not the object you returned**. A full DB row can go in, get validated, and only the **declared fields** come back out.

Every return value walks the same pipeline before it reaches the client:

1. **Validate** against the model. A wrong shape here is a **500** and gets logged, not the 422 you would see for a bad request.
2. **Filter** out every field the model doesn't declare. This is where a stray `password` or `is_admin` quietly disappears.
3. **Serialize** what is left to JSON through Pydantic v2's Rust core.
4. **Send** that body back to the client.

## Key points
- **Filtering is a security feature, not a convenience.** Only fields declared on the model make it out. A `password`, `hashed_password`, or internal `is_admin` riding on the returned object is dropped before it leaves the process. That is why you can hand back a full ORM row without leaking half of it.

> [!TIP] Write one test that asserts a known secret like `password` is absent from the JSON body. It is the cheapest guard against a future field silently joining the output model.

One declaration, plus a few decorator flags, covers almost every shaping need:

| Goal | Put this on the route | What it does |
| --- | --- | --- |
| Filter + validate output | `response_model=Model` **or** `-> Model` | Coerces the return into the model, **drops undeclared fields**, validates, and documents it in OpenAPI |
| Separate input vs output | base model + input subclass, return the **base** | Secrets live only on the input subclass, so the output **can't** carry them - one source of truth |
| Return one of several types | `response_model=None` | **Disables** the pipeline so a `Response \| dict` union isn't coerced into a model |
| Set the HTTP status | `status_code=201` | Sits **on the decorator**, next to the model |
| Drop fields nobody set | `response_model_exclude_unset=True` | Omits fields the loader **never touched** |
| Drop nulls | `response_model_exclude_none=True` | Omits fields whose value is **`None`** |
| Drop values still at their default | `response_model_exclude_defaults=True` | Omits fields **equal to** their default, even if explicitly set |

- **Returning a raw ORM object** works only when the model is told to read attributes off it instead of expecting a dict: `model_config = ConfigDict(from_attributes=True)`, the v2 spelling of the old `orm_mode`. With SQLModel the schema and the table are the same class, so you never think about it. A plain SQLAlchemy row feeding a `BaseModel` **does** need the config, and forgetting it is a very common 500.

## Example
```python
from fastapi import FastAPI
from pydantic import BaseModel, ConfigDict

app = FastAPI()

class UserBase(BaseModel):
    username: str
    email: str

class UserIn(UserBase):          # the input model adds a password
    password: str

# The return annotation both filters the output and type-checks in your editor.
# We hand back a UserIn (which has a password), but the declared return type is
# UserBase, so FastAPI strips password before it serializes anything.
@app.post("/users", status_code=201)
def create(user: UserIn) -> UserBase:
    return user                  # note: password is gone, it isn't a UserBase field
```

When the thing you return isn't the model's type, declare `response_model=` and let the model read attributes off the object:

```python
# a raw ORM row, a dict, or a union - none of them is literally a UserOut
class UserOut(UserBase):
    model_config = ConfigDict(from_attributes=True)   # v2 name for orm_mode
    id: int

@app.get("/users/{user_id}", response_model=UserOut, response_model_exclude_none=True)
def get_user(user_id: int):
    return repo.get(user_id)     # a SQLAlchemy row; from_attributes lets FastAPI
                                 # read id/username/email off it and drop the rest
```

## Interview Q&A
- **What does `response_model` actually do?** Four jobs off one declaration: it **validates** your return value, **filters** it down to the model's fields, **serializes** it to JSON via Pydantic v2's Rust core, and **documents** the response in OpenAPI.
- **How do you keep something like `password` out of the response?** Leave it off the output model. Return the object that still carries it and FastAPI drops any attribute the model doesn't declare. Don't hand-delete fields. You will forget one eventually.
- **`response_model=` vs `-> Model`, when do you use each?** The **annotation** for the common case where the return really is that type (and you get editor checks with it), **`response_model=`** when the real return type differs from the one you want to document. Set both and `response_model` takes priority.
- **`exclude_unset` vs `exclude_defaults`?** `exclude_unset` asks **"was this field provided at all?"** while `exclude_defaults` asks **"is the value still equal to its default?"** A field explicitly set to its default value survives the first and disappears under the second.
- **Why does returning my SQLAlchemy row 500?** The model can't build itself from a plain object that isn't a dict. Add **`from_attributes=True`** so it reads the attributes off the row.

## Gotchas
> [!WARN] **No response model means no filtering, full stop.** Return a model that happens to carry a secret and the secret ships in full. Anywhere sensitive data is in play, shape the output type on purpose instead of echoing back the request model.

> [!WARN] **`exclude_unset` keys off what was set at construction, not the value right now.** If your loader explicitly assigns a field its default, that counts as set and it stays. Assigning an attribute after the object is built marks it set too. When you mean "equal to the default," reach for `exclude_defaults`.

- Returning a raw `Response`, `JSONResponse`, or `RedirectResponse` **skips the whole pipeline**: no validation, no filtering, nothing in the docs. If an endpoint can return one of several types, set `response_model=None` so FastAPI doesn't try to turn a `Response | dict` into a model and choke.
- `response_model_include`/`response_model_exclude` reads as a handy shortcut, but the OpenAPI schema still advertises the **full** model, so your generated docs describe a shape you aren't actually sending. Fine for a throwaway internal route. For anything a client generates code against, write a real class.
- The filter runs a full validate-and-serialize pass over whatever you hand back. It is Rust-fast, but it **isn't free**: return 50k rows and you are re-validating 50k rows. Keep it in mind on a hot endpoint.

## Revise next
- [Pydantic models & validation](pydantic-models-validation.md) (v2 `model_dump`, `ConfigDict`)
- [Request body](path-query-body-parameters.md), and the `UserIn` side of this input/output split
- [OpenAPI / Swagger docs](openapi-swagger-docs.md)

*Reviewed against FastAPI 0.139 / Pydantic 2.13, July 2026.*
