---
title: "Conflict & Disagreement"
group: "Story Bank"
order: 3
---

# Conflict & Disagreement

> A conflict question is not looking for a fight you won; it is checking whether you can hold a technical position with evidence, change your mind when the evidence moves, and commit fully to a decision that went against you.

## What it is
Interviewers ask this because disagreement is the default state of a team with more than three engineers, and because it separates two failure modes they both need to screen out: the person who avoids conflict until the bad decision has shipped, and the person who cannot let go after the call is made. The competency is sometimes labelled **"have backbone, then disagree and commit"**, and both halves are scored.

The trap is picking a story where you were obviously right and the other person was obviously foolish. It reads as score-settling, and it gives no evidence about how you behave when you are the one who is wrong - which is the case they actually care about, because it is more common.

| What the story shows | Reads as | Score |
| --- | --- | --- |
| You escalated early with data, then committed | Backbone plus judgment | Strongest |
| You were wrong, said so, and adopted their approach | Ego separated from ideas | Strong |
| You were right, but only said so afterwards | Conflict-avoidant | Weak |
| You "won" and the other person is the villain | Score-settling | Disqualifying |

> [!KEY] The most valuable conflict story is one where you **lost the argument and it worked out**. It proves you can be overruled without going quiet or sandbagging, which is the exact behaviour a team lead is trying to predict.

## Key points
- **Disagree about the decision, never about the person.** Say what you argued, not what they were like. The moment your story contains a character assessment - "he was territorial about that service" - the interviewer stops evaluating the disagreement and starts evaluating you.
- **Bring the disagreement into a shared frame.** Two engineers trading opinions is stalemate; two engineers looking at the same numbers is a decision. Count the affected endpoints, time the query, estimate the rework - whatever converts "I think" into something both of you can check.
- **State the cost of being wrong on each side.** Most technical disagreements dissolve once you separate reversible from irreversible. A schema change on a production ledger and a naming convention deserve different amounts of fight, and knowing which is which is the seniority signal.
- **Name the moment you committed.** Interviewers listen for a clean handover: the decision was made, and here is how I supported it - the migration I wrote, the review I did, the fact that I did not relitigate it in the retro.
- **Time-box the argument yourself.** "We agreed we would decide by Thursday, and if we still disagreed we would take both options to the CTO" shows you can drive a disagreement to a close instead of letting it soak up a sprint.

> [!TIP] Have a small story ready for "a time you disagreed and were wrong". Interviewers ask it as a follow-up, and reaching for it instantly says more about you than the story itself does.

## Example
A worked answer for "Tell me about a time you disagreed with a colleague or your manager."

```text
Situation: An external VAPT came back two weeks before a release. Among
the findings were several broken object-level authorization issues: an
authenticated user could pass another tenant's object id and get the
record back.

Task: I owned the remediation. Our tech lead wanted the reported
endpoints patched individually so the date held; I wanted the fix at
the permission layer, because patching twelve endpoints left the same
bug class everywhere the testers had not reached.

Action: Instead of arguing in standup I spent half a day getting the
missing number. About 40 endpoints fetched objects by id, 12 were in
the report, so roughly 28 had the same weakness and no ticket. I wrote
it up on one page: the count, both options, and what the re-test would
find. I also had to concede his real point - the structural fix could
not be reviewed properly in two weeks on a regulated product. So I
proposed a split rather than my original position: patch the 12 now
exactly as he wanted and ship on the date, then land an object-level
permission check in the DRF layer next sprint, with a test that fails
any view missing it. We took that to the CTO together, and I wrote the
patches for his half first, before starting mine.

Result: All critical and high findings closed before the re-test, and
the date held. The permission layer landed the next sprint, and the
following re-test found nothing of that class. What I got wrong was
treating the deadline as negotiable; his constraint was harder than
mine. What I got right was refusing to close the finding without
killing the class.
```

## Interview Q&A
- **"Tell me about a time you disagreed with your manager."** Testing whether you can push back upward without becoming a problem. Angle it at how you made your case - written, with evidence, in their frame - and end on the commitment, whichever way it went.
- **"Describe a conflict with a teammate and how you resolved it."** They are screening for blame. Keep every sentence about the technical position, mention what you learned about their constraints, and never characterise the person.
- **"Tell me about a time you were wrong."** The highest-value question in this category. Answer directly - "I was, and here is the evidence that changed my mind" - because the speed with which you concede is itself the data point.
- **"What do you do when you disagree with a decision that has already been made?"** They want "disagree and commit" in your own words. Say you argue before the decision and execute after it, and give a concrete example of code you wrote to support an approach you had argued against.
- **"How do you handle a code review where the reviewer is wrong?"** A miniature of the whole category. Ask a question rather than assert, move to a call after two round trips, and let the shared standard - a benchmark, the style guide, a doc - settle it instead of seniority.
- **"Have you ever had to escalate a disagreement?"** Escalation is a tool, not a failure. Describe the time-box you set, that you went with the other person rather than behind them, and that you brought both options fairly stated.

## Gotchas
> [!WARN] Never make the other person the villain. The interviewer has only your account, so the only character being assessed is yours - and someone who describes a former colleague as territorial or incompetent in an interview will do it again about them.

> [!WARN] "I explained my reasoning and eventually they came around" with no mechanism is an empty answer. What changed their mind? A benchmark, a count, a prototype, a customer complaint? Without the mechanism it sounds like you outlasted them.

- **A story with no cost is not a conflict.** If nothing was at stake - a date, money, a security finding - it is a preference, and it does not test anything.
- **Do not choose a stale or trivial conflict.** Tabs versus spaces, or a disagreement from five years ago, both suggest you have not operated at a level where real decisions land on you.
- **Watch for hedging language.** "There was a bit of tension" makes the interviewer dig for what you are softening. State the disagreement plainly in one sentence and spend your time on the resolution.
- **Do not skip the commit.** Half of the candidates who tell a good conflict story stop at the decision. The part that scores is what you did in the two weeks after.

## Revise next
- [Leadership & Ownership](leadership-ownership.md): influencing without authority, which is the same skill before the conflict
- [Failure & Learning](failure-and-learning.md): the register to use when the disagreement was one you lost badly
- [Stakeholder Communication](stakeholder-communication.md): making the case in writing, in the other side's terms
- [RBAC vs ABAC](../security/rbac-vs-abac.md): the technical ground under the worked example, for when they drill into the permission layer

*Reviewed against Amazon's "Have Backbone; Disagree and Commit" principle, July 2026.*
