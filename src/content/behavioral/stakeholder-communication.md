---
title: "Stakeholder Communication"
group: "Story Bank"
order: 6
---

# Stakeholder Communication

> Stakeholder questions are testing translation, not politeness: whether you can hear a request for a feature, find the problem underneath it, and give a non-technical decision-maker enough of the trade-off to choose well without needing to understand your stack.

## What it is
The competency here is **working out what someone actually needs when what they gave you is a solution**. Users and executives rarely describe problems - they describe the fix they imagined, because it is easier to ask for a bulk-export button than to explain a workflow. Build exactly what was asked and you get a feature nobody uses; the shortfall shows up as adoption and support load, not as a bug.

The trap is answering this question with tone. "I always keep stakeholders in the loop and communicate clearly" describes an intention. The evidence is specific: what you asked, what you found that they had not said, and what you built instead.

| They said | Often means | How you find out |
| --- | --- | --- |
| "Add a bulk export button" | "I am re-keying data across screens" | Watch someone do the job for an hour |
| "It is slow" | One screen at one time of day is slow | Ask which action, and when it last happened |
| "Can we have it by Friday" | Something external is fixed to Friday | Ask what happens on Friday |
| "The team hates the new flow" | Two steps changed order and broke muscle memory | Ask for the last time it annoyed them |

> [!KEY] The highest-leverage move in this category is **watching the work happen** instead of collecting requirements. An hour of observation routinely relocates the problem entirely, and it is a concrete action you can put in an answer.

## Key points
- **Ask for the problem behind the request, once, without being difficult.** "What are you doing today that this would replace?" gets you there faster than a requirements meeting, and it keeps you out of the argument about whether their solution is good.
- **Agree the metric before you build, not after.** "Median time to complete a case" fixed up front turns a subjective review into an arithmetic one, and gives you the number your story ends on. A metric chosen afterwards always looks selected to flatter.
- **Translate into their currency: time, money, risk, or date.** A CXO does not need to know the endpoint fires 40 queries; they need "this screen costs your ops team two hours a day, and here is what we would trade to get it back".
- **Demo instead of reporting.** A ten-minute walkthrough of working software surfaces misunderstandings that four weeks of status updates hide. Weekly, same day, even when the week went badly - especially then.
- **Put decisions in writing and make them cheap to reverse.** A short written summary after every call, with the decision and the assumption it rests on, ends the "I thought we agreed" conversation and gives you an audit trail, which in a regulated product is not optional.
- **Say the bad news early and specifically.** "This will slip a week, here is why, here are two options" spends far less credibility than a surprise on the deadline. Stakeholders forgive slips; they do not forgive late slips.

> [!TIP] Take one hour of a domain expert's time before writing any code and just watch. It feels like an hour you do not have, and it is the cheapest requirements work available.

## Example
A worked answer for "Tell me about a time you worked with a non-technical stakeholder."

```text
Situation: A client's operations team used an internal CRM we
maintained to process customer cases. Their director had asked for a
bulk-export button, and their volume was generating a heavy stream of
repetitive support tickets into our queue.

Task: I was the backend owner with one sprint. Build the export button
as specified, or work out why they wanted it.

Action: I asked to sit with two agents and watch a normal morning. A
single case took six screens, and they were copying reference numbers
between two of them by hand, then exporting to a spreadsheet to check
what they had already done - because the status did not distinguish
"waiting on customer" from "waiting on us". The export was a workaround
for a status problem. So I came back with a one-page proposal in their
terms: the median case took about eleven minutes, roughly four of them
re-keying and checking. Instead of the button I proposed three things -
collapse the six screens into one, in the order they actually work;
split the status into the states they were tracking by hand; and add a
bulk action for the one operation they genuinely repeated. I agreed the
metric with the director up front: median time to close a case. Then I
demoed every Friday to the same two agents, which caught a wrong field
order in week one when it was cheap. I did not get it all right - I
deprioritised a daily email digest they wanted and had to add it later.

Result: Median case time fell about 40%, eleven minutes to under seven,
measured over a month. The status split also removed the top three
reasons people contacted us, and support tickets dropped around 70%
over the next quarter - most of that from the clearer states rather
than the redesign. The export button stayed on the backlog and was
never asked for again.
```

## Interview Q&A
- **"Tell me about a time you had to explain something technical to a non-technical audience."** Testing translation, not simplification. Give the sentence you actually said, in their currency - hours, risk, cost - and note what you left out on purpose.
- **"Describe a time a stakeholder asked for the wrong thing."** Careful with the framing: they asked for a solution, not a wrong thing. Show how you found the underlying problem and how you got them to choose the alternative rather than overruling them.
- **"How do you gather requirements?"** Answer with actions, not process names. Watch the work, ask what it replaces, agree a metric, demo weekly. Then give the example that proves each one happened.
- **"Tell me about a time you had to deliver bad news."** They are checking timing and specificity. Early, with two options and a recommendation, in writing after the call - and say what the stakeholder chose.
- **"How do you handle a stakeholder who keeps changing their mind?"** Reframe as an artifact problem: written decisions after every call, a demo cadence that catches drift in a week, and a scope change that visibly moves a date. Do not describe them as difficult.
- **"How do you know your work actually helped?"** Name the metric you fixed before starting, how you measured it, and be honest about attribution - "most of the ticket drop came from the status change, not the redesign" is more credible than claiming all of it.

## Gotchas
> [!WARN] Building exactly what was asked, then defending it because it was asked for, is the failure this whole category exists to detect. It reads as ticket-taking, and at senior level it is the wrong answer even when the spec was signed off.

> [!WARN] Never describe a stakeholder as non-technical in a way that sounds dismissive. "They did not really understand what they were asking for" tells the interviewer how you will talk about their product manager.

- **An update is not a demo.** A written status can be true every week right up to the week the thing does not work. Ten minutes of clicking through it cannot.
- **Do not claim every improvement in the story.** Splitting the credit between two changes - and admitting which one probably did the heavy lifting - makes both numbers believable.
- **Do not skip the disagreement.** A story where the stakeholder immediately loved your alternative sounds smoothed over. The email digest you got wrong is what makes the rest sound real.
- **Do not let the answer become a process lecture.** Two sentences of method, then straight into what you saw when you sat down next to the person doing the job.

## Revise next
- [Prioritization & Trade-offs](prioritization-tradeoffs.md): the same conversation when the answer has to be no
- [Leadership & Ownership](leadership-ownership.md): the weekly reporting format, applied to several stakeholders at once
- [Conflict & Disagreement](conflict-disagreement.md): when the stakeholder holds their original request
- [The STAR Method](star-method.md): choosing which of these numbers opens the answer

*Reviewed against Amazon's Customer Obsession and Earn Trust principles, July 2026.*
