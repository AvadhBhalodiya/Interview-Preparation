---
title: "Coverage & Good Tests"
group: "Quality & Practice"
order: 3
---

# Test Coverage & What Makes a Good Test

> Coverage measures which lines and branches your tests actually ran, which is great for spotting untested code but silent on whether you asserted anything useful, so a green 100% and a good test suite are not the same thing.

## What it is
**Test coverage** is a measurement, not a verdict. A tool (coverage.py, usually driven through the pytest-cov plugin) watches your code while the suite runs and records which statements and branches got hit. That is the whole job: it reports what ran, never whether what ran was correct.

> [!KEY] Coverage answers "did this line execute?", never "did I check the result?". A line can sit at 100% covered while every assertion about it is missing.

Coverage comes in two strengths, and the weaker one is the default:

| Metric | Question it answers | What it misses |
| --- | --- | --- |
| **Line / statement** (default) | Did this line **run** at all? | Untaken paths - a one-armed `if` looks **fully covered** even when its condition was never false |
| **Branch** (`--cov-branch`) | Did **both directions** out of each decision run? | Very little - it is the **stricter superset** and marks a half-run decision as a *partial* branch |

**A good test** pins down observable behavior and fails for exactly one real reason. If a red failure doesn't tell you what broke, the test isn't earning its seat in the suite.

## Key points
- Measure with **pytest-cov** and turn branch coverage on - the default statements-only number is the weaker one and flatters you:

```bash
pytest --cov=myproj --cov-branch --cov-report=term-missing --cov-fail-under=80
```

What each flag buys you:

| Flag | What it does |
| --- | --- |
| `--cov=myproj` | Measure coverage for the **`myproj` package** |
| `--cov-branch` | Count **branches**, not just lines - the honest number |
| `--cov-report=term-missing` | Print the **exact lines and branches missed**, the part you act on |
| `--cov-fail-under=80` | Fail below 80% - a **regression ratchet**, not a target |

- High coverage is necessary-ish and nowhere near sufficient. It proves a line executed, never that you checked the result. A suite can sit at 100% with tests that assert nothing: every function called once, zero assertions, green as grass, still broken.
- A good test earns its seat by being **FIRST**, structured **Arrange-Act-Assert**, and covering **one behavior**:

| Letter | Principle | In practice |
| --- | --- | --- |
| **F** | Fast | **Milliseconds**, so the suite stays worth running on every save |
| **I** | Isolated | No dependence on **other tests, run order, or shared state** |
| **R** | Repeatable | **Same result every run** - freeze the clock, seed randomness |
| **S** | Self-validating | **Asserts a real outcome**, passes or fails on its own, no eyeballing logs |
| **T** | Timely | Written **with the code**, not bolted on months later |

- **Arrange-Act-Assert** (Given-When-Then is the same idea) keeps one logical behavior per test, so a failure reads straight off the test name and the failing assert.
- Isolate a unit from slow or nondeterministic collaborators (network, clock, DB) with `unittest.mock`. Prefer `autospec=True` or `spec=` so the mock rejects calls the real object would reject.
- Spend the coverage budget on business-critical paths and ugly edges (empty input, boundaries, the error branch). Don't grind for the last few percent, and don't test the standard library or the framework - that code has its own suite.

> [!TIP] Patch a name **where it is looked up, not where it is defined**. If `service.py` did `from api import fetch`, patch `service.fetch`. Patching `api.fetch` misses the reference the code already bound at import.

## Example
```python
import pytest
from unittest.mock import patch

# avoid: high coverage, near-zero value. The line runs, nothing is checked.
def test_process():
    process(data)                          # no assert, so a wrong result still "passes"

# good: behavior plus an edge case, clear Arrange-Act-Assert
def test_discount_caps_at_zero():
    order = Order(total=100)               # Arrange
    apply_discount(order, percent=150)     # Act
    assert order.total == 0                # Assert: a 150% discount can't go negative

# good: pin the error path, not just the happy one
def test_discount_rejects_negative_percent():
    order = Order(total=100)
    with pytest.raises(ValueError):
        apply_discount(order, percent=-10)
```

Isolate the unit from slow or nondeterministic collaborators, then assert the call instead of hitting the network:

```python
# good: isolate the unit from the network, assert the call instead of hitting the internet
@patch("billing.gateway", autospec=True)   # patch where billing looks it up
def test_charge_calls_gateway_once(mock_gateway):
    mock_gateway.charge.return_value = {"status": "ok"}
    charge_customer(customer_id=42, cents=500)
    mock_gateway.charge.assert_called_once_with(customer=42, amount=500)
```

## Interview Q&A
- **What does coverage actually measure?** Which statements ran, and with branch coverage on, which branches ran. It is an execution map, not a correctness proof.
- **Is 100% coverage the goal?** No. It means every line executed at least once, not that every behavior was asserted. Read a low number as "definitely untested here." Don't read a high number as "definitely fine."
- **Line vs branch coverage?** Line asks whether a line ran. Branch asks whether both directions out of each decision ran, so it catches the `if` whose `else` no test ever took. Enable it with `--cov-branch`.
- **What makes a good test?** Deterministic, isolated, fast, asserts observable behavior, one clear reason to fail. FIRST and Arrange-Act-Assert are the shorthand.
- **Where do you patch a dependency?** Where it is looked up. If the module under test did `from x import y`, patch `module_under_test.y`, not `x.y` - the code already bound its own reference at import.

## Gotchas
> [!WARN] Chasing a coverage target quietly rewards the **assertion-free tests** that only pump the number. Review a suite by its assertions, not its percentage.

> [!WARN] A bare `Mock()` or `MagicMock()` answers **any attribute or call** you throw at it, so a typo'd method name still passes. Pin the interface with `spec=` or `autospec=True` and the mock fails the way the real object would.

- **Flaky tests** (real clock, unseeded randomness, network, shared state, order dependence) are worse than no test. Once people learn a red result "isn't real," they stop reading failures. Freeze time, seed randomness, isolate state.
- **Testing implementation details** (private methods, exact internal call order) makes tests snap on safe refactors. Assert the observable outcome instead.
- **Over-mocking**: if a test stubs out everything around and inside the behavior, it only proves the mocks were wired the way you wired them. Mock the boundary, run the real logic.
- **Import-time code counts as covered** just by being imported, no test required. A high number can hide lines that were merely loaded, never exercised.

## Revise next
- [Pytest](pytest-fixtures-parametrize-mock.md) (fixtures, pytest-cov)
- unittest.mock (patch, autospec, spec)
- [TDD](tdd.md)
- [Unit / Integration / E2E](unit-integration-e2e.md)

*Reviewed against the pytest 9.x, coverage.py, and Python unittest.mock docs, July 2026.*
