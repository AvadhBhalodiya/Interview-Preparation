---
title: "Prioritization & Trade-offs"
group: "Story Bank"
order: 5
---

# Prioritization & Trade-offs

> Prioritization questions are not testing whether you can work hard on several things; they are testing whether you can say out loud what you deliberately did not build, why that was the right call at the time, and who you told.

## What it is
This category probes **judgment under constraint**. Any engineer can order a backlog when there is enough time; the interviewer wants the case where two things genuinely both mattered and you cut one. What they are scoring is whether your reasoning was explicit and communicated, or whether you just worked on whatever was loudest.

The trap is answering with a method instead of a decision. "I use MoSCoW" or "I look at impact versus effort" is a framework recital, and it survives exactly one follow-up. The answer they want is a specific fork in the road, the number you used to choose, and what it cost you.

| Frame | Question it answers | When it earns its keep |
| --- | --- | --- |
| **Impact vs effort** | What gives the most value now | Comparable, well-understood items |
| **Cost of delay** | What gets more expensive if it waits | A queue of work with real deadlines |
| **Reversible vs irreversible** | How much analysis this deserves | Schema, contracts, anything public |
| **Compounding vs one-off** | Does this make the next one cheaper | Repeated work, integrations, tooling |

> [!KEY] The senior move is usually **cost of delay plus compounding**, not impact-versus-effort. Work that shortens every future instance of the same job is chronically underpriced, because its payoff lands in someone else's sprint.

## Key points
- **Turn the trade-off into arithmetic before you argue it.** "Four partners at four weeks each is sixteen weeks; one week of shared work plus four one-week integrations is five" is a decision anyone in the room can check. Preference loses to arithmetic.
- **Say what you cut, by name.** The interviewer is listening for a specific de-scope - the config DSL you did not build, the admin UI you dropped - because that is what proves a real trade-off rather than a plan where everything fit.
- **Pull the compounding work forward, but only for the case you have already seen.** Building a generic framework for the second integration is over-engineering; extracting the shared 80% after three is evidence. Say which one you were doing and why.
- **Get the trade-off agreed, not just decided.** A cut you made quietly is a risk you took alone. "I took two options and a recommendation to the CTO and we picked one" makes it a shared decision, which is what seniority means in practice.
- **Revisit the priority when the inputs move.** Sticking to a plan whose premise expired is not discipline. Name the trigger that would have made you re-order the work, and whether it fired.

> [!TIP] Keep a rejected option in the story. "I considered a config-driven mapping DSL and rejected it because we had three partners, not thirty" shows you saw the elegant answer and chose the cheap one on purpose.

## Example
A worked answer for "Tell me about a time you had to make a difficult trade-off, or prioritize between competing work."

```text
Situation: On a fintech platform, every new distribution partner meant
a bespoke integration - a different auth scheme, request signing, their
own sandbox and file formats. Each took roughly four weeks of my time,
and four partners were queued while the roadmap wanted those same weeks
for customer-facing features.

Task: I had one sprint of slack. Start integration number one
immediately, which is what was being asked for, or spend that sprint on
shared groundwork and start a sprint later.

Action: I made the case with queue math rather than an opinion. Four
partners hand-rolled was about sixteen weeks; one shared sprint plus
four short integrations was closer to eight, and the roadmap items
being displaced were not worth eight weeks of engineering. I went
through the two integrations we already had and pulled out only what
had genuinely repeated: an HTTP client carrying the signing and
retry-with-idempotency logic, a mapping layer between their payload
shapes and our internal model, a sandbox contract-test suite, and a
written onboarding checklist. I deliberately did not build the more
satisfying things - a config-driven DSL so a non-engineer could add a
partner, and an admin UI for the field mappings. We had four partners,
not forty. I took it to the CTO as two options with dates attached
rather than as a request, and we agreed to defer one roadmap item by a
sprint.

Result: The next integration took one week end to end instead of four,
and the two after it held the same shape. The trade-off I accepted is
that an unusual partner still needs custom code inside the client -
which happened once, and cost about three extra days. The roadmap item
slipped by exactly the sprint we agreed, and no more.
```

## Interview Q&A
- **"How do you prioritize when everything is urgent?"** Answer with a mechanism, not a framework name: you make the collision visible, price each item by cost of delay, and take the two worst options to whoever owns the outcome. Then give the example immediately, because the abstract answer never scores.
- **"Tell me about a time you had to cut scope."** Testing whether you can say no with a reason. Name the cut item, the evidence it was the right one to drop, and who signed off - a de-scope nobody agreed to is a different, worse story.
- **"Tell me about a technical decision you regret."** Angle it at a trade-off that was defensible then and wrong later, and say what changed. "We had three partners so I skipped the config layer; at twelve it would have been the wrong call" shows calibration rather than hindsight.
- **"When do you build the generic solution versus the specific one?"** Give a threshold you actually use - the third occurrence, or when two implementations already agree on the shape - and admit the failure mode on both sides: premature abstraction, and copy-paste sprawl.
- **"How do you handle a stakeholder who wants everything by the same date?"** Do not answer with heroics. Show the sequencing and the arithmetic, offer options with dates, and let them choose - they own the priority, you own the estimate.
- **"How do you decide between paying down tech debt and shipping features?"** Price the debt in the currency of delay: this is costing four weeks per partner. Debt work that cannot be tied to a number is the debt work that never gets scheduled.

## Gotchas
> [!WARN] Reciting a framework - MoSCoW, RICE, the Eisenhower matrix - as your answer is a common way to sound junior. Interviewers want the one decision you actually made, in specifics; the framework at best explains it in half a sentence.

> [!WARN] A story where you got everything done anyway is not a prioritization story. If nothing was cut and no date moved, you have described good luck or overtime, and the interviewer will re-ask.

- **Do not present the trade-off as costless.** Every real one hurt somewhere. Naming the three extra days the unusual partner cost you makes the whole story credible.
- **Do not confuse urgent with important in the retelling.** Say why the cut item was genuinely lower value, not merely quieter.
- **Do not skip who agreed.** Unilateral prioritization is the failure mode this question screens for, especially in fintech and anything compliance-adjacent.
- **Avoid the infinite-hindsight ending.** "In retrospect I would have built the full framework" undercuts the judgment you just demonstrated unless you can say what evidence would have justified it at the time.

## Revise next
- [Leadership & Ownership](leadership-ownership.md): running parallel work, which is the scheduling half of this skill
- [Stakeholder Communication](stakeholder-communication.md): how the cut gets agreed rather than announced
- [Conflict & Disagreement](conflict-disagreement.md): what to do when the person you are prioritizing against disagrees
- [The STAR Method](star-method.md): keeping the rejected option in the Action beat without running long

*Reviewed against Amazon's Bias for Action and Frugality principles, July 2026.*
