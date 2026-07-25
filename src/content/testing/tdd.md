---
title: "TDD"
group: "Quality & Practice"
order: 4
---

# TDD (Concept + When It's Useful)

> Test-Driven Development is the discipline of writing a failing test first, then the smallest code that makes it pass, then refactoring with the test holding you steady: the **Red-Green-Refactor** loop, repeated in tiny steps.

## What it is
TDD is a **design discipline that happens to leave tests behind**. You write a failing test describing the next behavior, make it pass with the simplest thing that works, then refactor. The test is a spec you write *before* the code, not a check you bolt on after.

> [!KEY] The test is the first *consumer* of your code, so you feel a clumsy interface before you commit to it. Tests are the by-product, better design is the point.

The loop is three phases, repeated in tiny steps of a minute or two each:

| Phase | What you do | The rule that makes it work |
| --- | --- | --- |
| **Red** | Write one failing test for the next small behavior | It has to fail first. A test that passes before the code exists asserts **nothing** |
| **Green** | Write the **minimal** code that passes, nothing more | A hardcoded `return` is allowed. The *next* test is what forces real logic |
| **Refactor** | Tidy the code and tests while everything stays **green** | Change structure, not behavior. The passing test is what lets you clean up safely |

Then loop back to Red for the next behavior. Kent Beck's heuristic: if getting from red to green drags, the step was too big, so shrink it. TDD is a practice, not a religion - plenty of solid code ships test-after or with none. The interview-worthy skill is knowing *when* test-first earns its keep and when it doesn't.

## Key points
- **Red, green, refactor - and refactor is the step people quietly drop.** Green means it works, refactor means it's clean, and the passing test is exactly what lets you clean up without holding your breath. Skip it and you just pile up tested mess.
- **Minimal green is not a slogan.** Write the least code that passes, even when it looks too dumb to be real. `return "hello-world"` is a legitimate first step, and the *next* test forces the real implementation. You generalize only when a test demands it, never on spec. That's what keeps TDD from turning into speculative over-engineering.
- **pytest keeps the loop cheap.** You write plain `assert`, and pytest's assertion rewriting prints the actual and expected values on failure, so you skip hand-written comparison messages. Fast, legible red is what makes the rhythm bearable instead of a chore.
- **Coverage comes for free, and that's the trap.** Every line exists because some test demanded it, so line coverage trends high by construction. But coverage only proves a line *ran*, not that you asserted anything worthwhile about it. Treat the number as a smoke detector, not a grade.
- **A slow suite kills TDD.** The loop only works at sub-second speed. The moment a unit test spins up a real database or hits the network, the cycle is dead, and that's what mocking and dependency injection are for (see the example).

Where test-first earns its keep, and where it gets in the way:

| Best fit | Poor fit |
| --- | --- |
| Pure functions, algorithms, parsers - anything with a **clear input/output contract** | Spikes and prototypes, where the **design is still unknown** |
| **Bug fixes**: reproduce as a failing test, fix to green, keep it as a permanent regression guard | Churny UI, where the test gets **rewritten every ten minutes** |

> [!TIP] pytest 9 turns a common silent failure loud: a test that `return`s a value instead of using `assert` is now an **error**, not just a warning, so a test that forgot to assert can no longer pass green by accident.

## Example
```python
# Cycle 1 -----------------------------------------------------------
# RED: the test comes first. slugify doesn't exist yet, so collection fails.
def test_slugify_lowercases_and_hyphenates():
    assert slugify("Hello World") == "hello-world"

# GREEN: the least code that passes. Resist reaching for regex yet.
def slugify(s):
    return s.lower().replace(" ", "-")


# Cycle 2 -----------------------------------------------------------
# RED: a new behavior the current code gets wrong ("--hello---world--").
def test_slugify_collapses_and_strips_whitespace():
    assert slugify("  Hello   World  ") == "hello-world"

# GREEN: now the naive replace() isn't enough, so generalize, but only now.
import re

def slugify(s):
    return re.sub(r"\s+", "-", s.strip().lower())

# REFACTOR: behavior is settled, so fold the cases into one data-driven test.
import pytest

@pytest.mark.parametrize("raw, expected", [
    ("Hello World",       "hello-world"),
    ("  Hello   World  ", "hello-world"),
    ("already-a-slug",    "already-a-slug"),
])
def test_slugify(raw, expected):
    assert slugify(raw) == expected
```

```python
# TDD when a dependency is in the way (DB, HTTP, clock, email).
# Keep the unit loop fast by isolating the collaborator instead of calling it.
from unittest.mock import patch

# app/services.py does:  from app.notifications import send_email
def test_welcome_email_is_addressed_to_the_user():
    # Patch where the name is LOOKED UP (services), not where it's defined
    # (notifications). autospec=True makes the double honor send_email's real
    # signature, so a renamed/dropped arg fails loudly instead of passing silently.
    with patch("app.services.send_email", autospec=True) as send:
        greet_new_user(User(name="Ada", email="ada@x.com"))
        send.assert_called_once_with("ada@x.com", subject="Welcome, Ada")
```

## Interview Q&A
- **Walk me through the TDD cycle.** One failing test for the next behavior (red), the minimal code that makes it pass (green), then refactor code and tests while everything stays green. Repeat in small steps measured in minutes, not hours.
- **Why write the test first?** It forces you to name the behavior and design the interface before the implementation biases you. You get a testable design and a runnable spec, rather than tests added afterward that just echo whatever the code happens to do.
- **Doesn't test-first give you 100% coverage, so you can drop other testing?** Coverage rides along because every line was demanded by a test, but it only proves a line executed, never that the assertion was any good. TDD complements exploratory, property, and integration tests. It doesn't replace them. You still have to test the cases you never thought to imagine.
- **How do you TDD code that talks to a database or an API?** Push the I/O to the edges and inject or patch the collaborator so the unit loop stays fast, typically `unittest.mock`'s `patch` with `autospec=True`, asserting via `assert_called_once_with`. Then exercise the real integration in a separate, slower suite.
- **When would you not use TDD?** Spikes, prototypes, fast-moving UI, anywhere the design is still shifting. Learn the shape first, then TDD the part you decide to keep.

## Gotchas
> [!WARN] **Skipping refactor is the classic failure.** Green-green-green with no cleanup gives you a passing suite wrapped around a mess. The tests were meant to buy you the safety to refactor, so spend it.

> [!WARN] **Test the behavior, not the implementation.** Over-mock and assert on every internal call and your tests shatter on the next refactor, which defeats the whole point. Mock at real seams (I/O, external services) and assert on outcomes.

- Chasing the coverage number backfires. 100% line coverage with weak assertions is worse than 80% with sharp ones, because it looks safe and isn't. Turn on branch coverage (`--cov-branch`, or `coverage run --branch`) so an `if` that never went both ways surfaces as a partial branch, and read the report instead of the percentage.
- Test-first on an unstable design just churns tests. If you're rewriting the test every ten minutes because you don't know the shape yet, stop and spike.
- "Write all the tests up front" is not TDD. It's tiny interleaved loops. A wall of tests before any code is just a slower waterfall.

## Revise next
- [Coverage & good tests](test-coverage-good-tests.md) (line vs branch, what a percentage can't tell you)
- [Pytest](pytest-fixtures-parametrize-mock.md) (fixtures, `parametrize`, `pytest.raises`)
- BDD & refactoring

*Reviewed against pytest 9.x, Python unittest.mock, and coverage.py docs, July 2026.*
