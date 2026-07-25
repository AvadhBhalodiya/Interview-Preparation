---
title: "Pytest"
group: "Test Types & Tools"
order: 2
---

# Pytest: Fixtures, `parametrize`, Mocking

> Pytest runs on plain `assert` and three workhorses: fixtures inject setup and teardown by argument name, `@pytest.mark.parametrize` runs one test body across many inputs, and `unittest.mock` swaps real dependencies for fakes you can interrogate.

## What it is
**Pytest** is the default-choice test framework for Python. You write ordinary `assert` statements and it rewrites them under the hood into readable failure output, so there is no `self.assertEqual` ceremony to memorise. Discovery is **convention over configuration**: files named `test_*.py` (or `*_test.py`), functions prefixed `test_`, and `Test*` classes that have no `__init__`.

> [!KEY] Fixtures **inject** dependencies by argument name, `parametrize` **multiplies** one test body into many reported cases, and mocks **stand in** for real collaborators. Every question here reduces to one idea: isolate the unit under test from what it talks to.

Three features carry most of the weight in real suites and most of the interview questions:

| Mechanism | What it does | Lifecycle / core rule |
| --- | --- | --- |
| **Fixture** | Supplies setup + teardown by argument-name injection | setup → `yield` value → test runs → teardown (**reverse order**) |
| **`parametrize`** | Runs one test body across many input rows | N `(input, expected)` rows → **N independently reported** cases |
| **Mock / `patch`** | Swaps a real dependency (HTTP, clock, DB) for a fake | replace dep → run code → **assert how it was called** |

## Key points
- **Fixtures are dependency injection.** A `@pytest.fixture` function's name becomes something you list as a test argument. Pytest matches by name and hands back whatever the fixture returns or yields. A fixture can itself request other fixtures, so they compose into a small dependency graph rather than a pile of shared helpers.
- **Use `yield` for teardown.** Code before the `yield` is setup, code after it is cleanup, and pytest tears fixtures down in **reverse order** of setup. Cleanup runs even when the test fails, but not if the setup raised before reaching `yield`, so keep fixture setup lean.
- **Scope trades speed for isolation.** A wider scope builds the fixture once and shares it, which is faster but lets state bleed between tests. Default to `function` and widen only for genuinely expensive, read-only resources.

| Scope | Rebuilt once per | Reach for it when |
| --- | --- | --- |
| `function` (**default**) | **each test function** | almost always - fresh state, no bleed |
| `class` | test class | shared setup across one `Test*` class |
| `module` | test file | one build for every test in a `.py` |
| `package` | package directory | shared across a package of test files |
| `session` | **the whole run** | expensive, **read-only** things: DB engine, HTTP client |

- **`conftest.py` shares fixtures.** Drop a fixture there and pytest auto-discovers it for every test in that directory and below, no import required. `autouse=True` runs a fixture without being requested, which is convenient and easy to overuse, so reserve it for cross-cutting setup like a clock freeze.
- **`parametrize` expands one test into many.** `@pytest.mark.parametrize("n, expected", [(2, 4), (3, 9)])` produces a separate test item per row, each with its own id and its own pass/fail, so one bad input cannot mask the others. Stack two decorators to get the **cartesian product** of their rows.
- **Mocks record, `patch` swaps.** `Mock`/`MagicMock` fabricate attributes on demand and remember every call. `patch()` replaces a real object with one of them for the duration of a test. You program the response two ways:

| Set on the mock | It then... |
| --- | --- |
| `return_value = x` | hands back the **same fixed `x`** on every call |
| `side_effect = fn` | **calls `fn(*args)`** and returns its result |
| `side_effect = Err` | **raises** that exception when called |
| `side_effect = [a, b]` | **yields `a` then `b`** across successive calls |

> [!TIP] Prefer `pytest-mock`'s `mocker` fixture over nesting `with patch(...)` blocks. It registers each patch and undoes them all at teardown, so a patch never leaks into the next test.

- **Patch where the name is looked up, not where it is defined.** This is the rule people get wrong most. The target depends on how the code under test imported the dependency:

| The module under test did | Patch this target |
| --- | --- |
| `import requests` then calls `requests.get()` | `myapp.services.requests.get` (same module object) |
| `from requests import get` then calls `get()` | **`myapp.services.get`** - its own binding, not `requests.get` |

- Add **`autospec=True`** (or `spec=`) so the fake mirrors the real signature and rejects any call that would not work against the real object.
- **pytest 9 nuance.** Parametrized values are now compared with **`==`** (falling back to `is`), so passing mutable params such as lists no longer forces pytest to rebuild a parametrized fixture on every row. A small change, but the sort of version detail that signals you keep current.

## Example
```python
import pytest

@pytest.fixture
def client():
    c = make_client()
    yield c              # test runs here; everything below is teardown
    c.close()            # runs even if the test fails, as long as setup succeeded

@pytest.mark.parametrize("n, expected", [(2, 4), (3, 9), (0, 0)])
def test_square(n, expected):
    assert square(n) == expected     # 3 items: test_square[2-4], [3-9], [0-0]
```

Isolate the unit from the network by patching the name `myapp.services` actually looks up, and drive the two branches with `return_value` and `side_effect`:

```python
from unittest.mock import patch

def test_fetch_uses_api(client):
    with patch("myapp.services.requests.get", autospec=True) as mock_get:
        mock_get.return_value.json.return_value = {"ok": True}
        assert fetch(client) == {"ok": True}
        mock_get.assert_called_once()

def test_fetch_propagates_timeout(client):
    with patch("myapp.services.requests.get", side_effect=TimeoutError):
        with pytest.raises(TimeoutError):     # side_effect raises when called
            fetch(client)
```

## Interview Q&A
- **What is a fixture, and why prefer it over `setUp`/`tearDown`?** A function that supplies a dependency by argument-name injection. `yield` gives teardown for free, fixtures compose and carry scopes, and each test requests only what it needs instead of inheriting one shared setup blob.
- **What does `parametrize` actually do?** It expands a single test function into N separate test items, one per row, each reported and failing on its own.
- **Where do you patch a dependency?** At the lookup site. Patch the name in the module that calls it, because that module already bound its own reference at import time.
- **How do you share fixtures across files?** Put them in `conftest.py`. Pytest loads it automatically for that directory tree with no import.
- **`return_value` vs `side_effect`?** `return_value` is the fixed value a mock hands back, while `side_effect` runs a function, raises an exception, or iterates a sequence across successive calls.

## Gotchas
> [!WARN] **Patch where the name is looked up, not where it is defined.** `patch("requests.get")` when your code did `from requests import get` leaves the real call running, and your assertion then passes for the wrong reason. Green does not mean covered here.

> [!WARN] A **bare `Mock` accepts anything**. `mock.typoed_method()` never raises, so a misspelled call sails straight through a green test. Bind the fake to the real interface with **`autospec=True`** or `spec=`.

- **Wide-scoped mutable fixtures leak.** A `session` fixture returns a dict, one test stuffs a key into it, and a test three files away starts failing depending on run order. Widen scope only for read-only or expensive resources.
- **Over-mocking tests your fakes, not your code.** Mock at the boundary such as network, clock, or filesystem, and let the unit under test run for real.
- **Coverage is not correctness.** 100% line coverage means every line executed, not that anything was asserted. Enable branch coverage (`--cov-branch`) and confirm the tests actually check outcomes.
- **Teardown is skipped if setup raised.** Code after `yield` only runs when the code before it finished, so a fixture that blows up during setup leaves nothing to clean up.

## Revise next
- [**Unit / Integration / E2E**](unit-integration-e2e.md): the test pyramid, and which collaborators each layer fakes versus runs for real.
- [**Coverage and what makes a good test**](test-coverage-good-tests.md): line versus branch coverage, and why an executed line is not an asserted one.
- **Mocking pitfalls and test doubles**: dummy, stub, spy, mock, and fake, and picking the lightest one that proves the behaviour.

*Reviewed against pytest 9, July 2026.*
