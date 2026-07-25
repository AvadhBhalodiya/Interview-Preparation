---
title: "Failure & Learning"
group: "Story Bank"
order: 4
---

# Failure & Learning

> The failure question is a trust test rather than a competence test: an engineer who can name a real mistake, own it without deflecting, and point at the specific guardrail they built afterwards is telling you exactly how they will behave the next time production breaks.

## What it is
The interviewer is looking for three things in order - **did you cause it, did you own it, did the system change**. Most candidates answer only the third, and only in the abstract ("I learned to communicate better"), which produces no evidence at all.

The classic trap is the disguised humblebrag: "I care too much about quality", or a failure that was really someone else's. It is transparent, and it costs you more than a genuine mistake would, because the question stops being about the incident and starts being about whether you are being straight.

> [!KEY] Pick a failure where **you were the proximate cause** and the blast radius was real. A story where the outage was the vendor's fault answers a different question than the one you were asked.

| Story you could pick | What it signals | Verdict |
| --- | --- | --- |
| You shipped the change that broke production | Ownership, and you survived the aftermath | Best |
| You misread a requirement and built the wrong thing | Judgment, communication gap you closed | Good |
| A vendor or a colleague broke it, you cleaned up | Firefighting, but you dodged the question | Weak |
| "I take on too much work" | Rehearsed non-answer | Costly |

## Key points
- **Own the decision, not just the outcome.** "The migration locked the table" is passive. "I wrote a migration that took an exclusive lock and I ran it at 2pm" is ownership, and it is the sentence the whole answer hangs on.
- **Separate blameless from blame-free.** A good post-incident review does not punish the person, but you should still be able to say precisely what you did wrong. Candidates who hide behind "the process failed" sound like they would do the same on your team.
- **The learning must be a mechanism, not a feeling.** "I learned to be more careful" is worthless because it does not survive a busy week. A lock check in CI, a migration review checklist, and a deploy window are things that keep working when you are tired.
- **Give the recovery its own beat.** How you behaved during the incident is half the evidence: how fast you noticed, whether you rolled back before diagnosing, who you told and when. Detection and communication times are numbers too.
- **Show the durable result.** The strongest close is proof the class of failure did not recur - a clean quarter, an uptime figure, the same migration pattern shipped safely fifty times since.

> [!TIP] Rehearse saying "that was my mistake" as a complete sentence, with no clause after it. The instinct to append "but the staging data was different" is exactly what interviewers are listening for.

## Example
A worked answer for "Tell me about a time you failed, or made a mistake at work."

> [!WARN] Unlike the other notes in this section, this story is **illustrative, not yours** - it is a plausible incident written to show the shape of a good failure answer, not something drawn from your history. Replace it with a real mistake of your own before you use it. Interviewers probe failure stories harder than any other kind ("what did the rollback look like?", "what did your lead say?"), and a borrowed story collapses on the second follow-up. Keep the structure: own it in the first sentence, no blame, concrete cost, and a durable fix that outlived the incident.

```text
Situation: On a fintech platform, the transactions table was the hot
path for everything - payments, reconciliation, the dashboard - and it
had grown to tens of millions of rows.

Task: I needed an index on two columns to support a reporting filter. I
wrote the migration, it passed review, and I deployed it mid-afternoon
with the feature.

Action: The mistake was mine and it was basic. I used a plain CREATE
INDEX in a Django migration, which takes a lock that blocks writes, and
on a table that size it ran about eight minutes. Writes queued behind
it, payment status updates started failing, and the API returned 5xx.
It passed review and staging because staging held about 50,000 rows,
where the same migration finishes instantly. I saw the error-rate alert
roughly 90 seconds in. I did not diagnose first - I cancelled the
statement, confirmed writes drained, and posted in the incident channel
that it was my migration, before anyone asked. I reran it that night as
CREATE INDEX CONCURRENTLY with atomic = False. Then I wrote the part I
actually cared about: a CI check that fails any migration with an
unannotated lock-taking operation, and a rule that schema changes go
out in a low-traffic window, separate from application code.

Result: Eight minutes of failed writes, roughly 400 errored requests.
Nothing was lost, since client retries reconciled, but it was a
customer-facing outage I caused. That CI check has blocked the pattern
several times since, twice on my own branches, and the platform held
99.9% uptime across the following year with no repeat of that class.
What I would still change: staging had nothing like production's data
volume, and I should have raised that long before it bit me.
```

## Interview Q&A
- **"Tell me about a time you failed."** Answer with the mistake in the first sentence, no throat-clearing. They are timing how long it takes you to say the bad part, and a fast, specific admission buys credibility for the rest of the interview.
- **"Tell me about a production incident you caused."** Narrower and harder. They want the timeline: what broke, when you knew, what you did first, who you told. Say that you stabilised before diagnosing - that ordering is the experienced instinct.
- **"What is the biggest mistake you have made in your career?"** Testing calibration. Something too small reads as evasive, something catastrophic invites doubt; a real customer-facing outage you caused and closed out is the right size.
- **"What did you learn?"** Refuse the abstract answer. Name the artifact - the CI check, the checklist, the deploy window - and then say how you know it works, ideally that it has caught something since.
- **"How do you handle being blamed for something?"** They are probing for defensiveness. Distinguish taking responsibility from accepting an inaccurate account: you can say "the migration was mine" and still correct the record on what it did.
- **"Tell me about a time you received difficult feedback."** Adjacent question, same underlying trait. Give the feedback verbatim if you can, say what you changed within the next month, and name who told you.

## Gotchas
> [!WARN] The disguised strength - "my failure is that I am a perfectionist" - is scored as a non-answer, and it can end the interview's goodwill in one sentence. Interviewers have heard it hundreds of times and read it as either no self-awareness or unwillingness to be straight.

> [!WARN] Watch the "but". "It was my mistake, but the staging environment was misconfigured" deletes the first clause. Put context before the admission or leave it out; never after.

- **Do not pick a failure with no consequence.** If nothing broke and nobody was affected, you are describing a near-miss, and the interviewer will ask again with less patience.
- **Do not blame the process while standing inside it.** "We had no migration checklist" is only acceptable if the next sentence is "so I wrote one".
- **Do not stop at the fix.** The failed migration is not the story. The CI check that makes the class of failure impossible is the story.
- **Do not over-apologise.** Two sentences of ownership, then move to what changed. Extended contrition reads as fragility, and interviewers wonder how you would handle a real outage review.

## Revise next
- [Leadership & Ownership](leadership-ownership.md): the same instinct before anything breaks
- [Conflict & Disagreement](conflict-disagreement.md): the story to reach for when the mistake was insisting on something
- [The STAR Method](star-method.md): why the learning belongs in the Result beat, not appended after it
- [Django migrations](../django/migrations.md) and [locking](../databases/locking-optimistic-pessimistic.md): the technical ground under the worked example

*Reviewed against Amazon's Learn and Be Curious principle and standard post-incident review practice, July 2026.*
