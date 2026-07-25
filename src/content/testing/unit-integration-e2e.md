---
title: "Unit / Integration / E2E"
group: "Test Types & Tools"
order: 1
---

# Unit vs Integration vs E2E Tests

> Three test levels that trade speed for realism: unit exercises one piece with its collaborators faked, integration runs real components together against a real DB or API, and E2E drives the whole system like a user would - so write a lot of the first and only a few of the last.

## What it is
The three names describe **scope** - how much of the real system one test actually exercises - not which library you reach for, so all three can be plain pytest. The trade never changes: the more real collaborators a test touches, the more real bugs it can catch and the slower and less deterministic it gets. **Unit** sits at the cheap, narrow end and **E2E** at the expensive, broad end, with **integration** in between.

> [!KEY] Push every check down to the **cheapest level that can still catch that class of bug**. Healthy suites form a **pyramid**: a wide base of fast unit tests, a thin band of integration, and a few E2E on top.

The three levels, compared across what actually differs between them:

| Level | Scope: what actually runs | Speed | Count | What a red test points at |
| --- | --- | --- | --- | --- |
| **Unit** | One function or class, **collaborators faked** | **Milliseconds** | **Thousands** (wide base) | One unit's logic - names the **exact place** |
| **Integration** | **Two+ real pieces** wired together: real DB, cache, HTTP | Medium - **real I/O** | **Some** | **Wiring**: dropped field, unrun migration, silent rollback |
| **E2E** | The **whole system**, driven like a user (browser or full API flow) | **Slow, flakiest** | **A few** journeys | Something in the journey - but **not where** |

Flip that shape into **mostly E2E with barely any unit** and you get the **ice-cream cone**: a slow, flaky suite the team re-runs "just to be sure" and eventually stops trusting red.

## Key points
- **Push each check to the cheapest level that can catch it.** A serializer that drops a field is an integration bug, so do not chase it with a browser test. Pure validation logic is a unit bug, so do not spin up Postgres for it.
- **Keep the fast loop fast:** tag the slow tests with marks and run `-m "not integration and not e2e"` on every push, then the full suite nightly or before merge. Fast tests give quick, precise feedback and slow tests give confidence.
- **Fake collaborators at the unit level** with `unittest.mock` (`patch`, `MagicMock`) or pytest's built-in `monkeypatch` fixture, so network, DB, and clock stay out and the test is deterministic.
- **"Integration" is an overloaded word:** to one team it means two modules plus a real DB, to another it means five services over the network. Agree on the scope before arguing about it in review.
- **Cousins you will hear named** sit orthogonal to the pyramid - a regression test can live at any level:

| Kind | Question it answers |
| --- | --- |
| **Smoke** | Did the deploy even **come up**? |
| **Contract** | Do two services still **agree on the payload shape**? |
| **Regression** | Is a **previously fixed bug** still fixed? |

> [!TIP] Register every mark in `pyproject.toml` and run with `--strict-markers`. A typo like `@pytest.mark.integraton` then fails hard instead of silently becoming a new, never-selected mark that quietly drops the test from CI.

## Example
One theme at three levels - a faked-out unit test, an integration test against a real DB, and a browser E2E, each tagged so CI can select it:

```python
# unit: one function, the price service faked out. no network, runs in ms.
def test_cart_total_applies_discount(monkeypatch):
    monkeypatch.setattr(pricing, "lookup", lambda sku: 100)   # fake the collaborator
    assert cart_total(["A", "B"], discount=0.10) == 180       # 200 - 10%

# integration: real app + real test Postgres, nothing mocked at the boundary
@pytest.mark.integration
def test_create_order_persists_row(client, db_session):
    resp = client.post("/orders", json={"sku": "A", "qty": 2})
    assert resp.status_code == 201
    assert db_session.query(Order).count() == 1

# e2e: drive the running app like a user (Playwright sync API)
@pytest.mark.e2e
def test_checkout_flow(page):
    page.goto("https://staging.example.com")
    page.get_by_role("button", name="Add to cart").click()
    page.get_by_role("link", name="Checkout").click()
    expect(page.get_by_text("Order confirmed")).to_be_visible()
```

Register the marks so they never warn and typos fail loudly:

```toml
# pyproject.toml - register marks so they don't warn, and turn typos into hard errors
[tool.pytest.ini_options]
addopts = ["--strict-markers"]
markers = [
    "integration: touches a real DB or external service",
    "e2e: drives the full running app",
]
```

## Interview Q&A
- **Unit vs integration vs E2E?** Unit runs one piece with its dependencies faked. Integration runs real components together (real DB/API). E2E drives the whole system through a user-visible flow. The dividing line is how much real stuff executes, not the tool.
- **What is the test pyramid, and why that shape?** Many fast unit tests, fewer integration, a few E2E. Fast tests give quick, precise feedback. Slow tests give confidence. You want most of your feedback fast and pinpointed, with just enough slow tests to prove the pieces actually connect.
- **The "ice-cream cone" anti-pattern?** The pyramid flipped: mostly E2E, barely any unit. It limps along until the suite gets slow and flaky, people start re-running "just to be sure," and eventually stop trusting red. Avoid it.
- **Why not test everything with E2E?** It's slow, non-deterministic (network, timing, real browsers), and when it fails it rarely tells you *where*. A failed unit test names the function. A failed E2E just says "something, somewhere."
- **A unit test is green but prod broke - how?** A passing unit test only proves your code matches your *mocks*. If the mock encodes a wrong assumption about the real dependency, the test stays green while production breaks. Closing that gap is the whole reason integration tests exist.

## Gotchas
> [!WARN] `unittest.mock`'s number-one footgun: **patch the name where it is looked up, not where it is defined.** If `orders.py` does `from pricing import lookup`, you patch `"orders.lookup"`, not `"pricing.lookup"` - patching the source module leaves the already-imported name untouched.

> [!WARN] A **fully mocked unit test can pass while the real integration is broken** - the mock is *your* guess at the dependency, not its behavior. Use `autospec=True` (or `spec=`) so the double matches the real signature, then a renamed method fails loudly instead of quietly returning another `Mock`.

- **Over-relying on E2E is the classic failure mode** - the ice-cream cone again. It feels thorough, but you are buying slow, flaky coverage you could get faster and more precisely one level down. Reserve E2E for a few critical journeys.
- **Coverage is not confidence.** coverage.py reports which lines *ran*, not whether you *asserted* anything about them, so you can hit 100% with tests that check nothing. Chase meaningful assertions and branch coverage (`--cov-branch`), not the headline percentage.

## Revise next
- [Pytest](pytest-fixtures-parametrize-mock.md) - fixtures, marks, parametrize (writing the tests)
- [Coverage & good tests](test-coverage-good-tests.md) (what the number does and doesn't tell you)
- [CI/CD pipelines](../devops/cicd-pipelines.md) (fast tests per push, the slow band nightly)

*Reviewed against pytest 9.x, unittest.mock, and coverage.py 7.15 docs, July 2026.*
