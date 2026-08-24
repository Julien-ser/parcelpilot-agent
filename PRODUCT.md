# Product Note

## Which client problem I chose

**Both — but Trust and Reliability (problem 2) is the one I built the system around,
and Proactive Issue Detection (problem 1) is the one I built a surface for.**

That is not hedging. Problem 2 is not a feature you can add next to the others; it is a
property of how the system is put together, and retrofitting it means rewriting the
answer path. Problem 1 is a surface, and it turned out to be nearly free once the
policy engine existed — the detectors are the same evaluators pointed at every record
instead of one.

### Problem 2: trust, addressed structurally

Four decisions, in the order they matter:

1. **The model cannot produce a figure.** Every fee, credit and SLA number comes from a
   tested pure function. The class of failure where an agent confidently invents INR 250
   is not mitigated here, it is unreachable.
2. **Precedence is enforced in the data layer.** Deprecated documents are filtered out
   of retrieval; contract clauses outrank policy by construction. The model is not asked
   to remember which policy is current.
3. **Every answer carries a rule trace with an `overrides` field.** The most useful
   sentence in a support answer is usually "the default would have been X, but your
   agreement says Y" — that now falls out of the data structure rather than depending on
   the model's mood.
4. **Uncertainty is a first-class return value.** The SOP says do not promise a credit
   when fault is unknown; `evaluate_credit` returns `confidence: needs_verification` with
   the specific missing field, and the agent escalates rather than guessing.

The sharpest expression of this is the **incorrect-history detector**. The dataset warns
that past resolutions may be wrong. Wrong answers do not stay in the past — agents search
old tickets for precedent and repeat them. So the system re-derives the correct answer
for each recorded resolution and flags the contradictions. It finds both planted errors:
a cancellation fee quoted to an account whose contract waives it, and a 3,000-row
"plan limit" that is really a known-issue workaround. Neither is discoverable by asking
a question, which is exactly why it belongs in the proactive surface.

### Problem 1: the ops dashboard

`/ops` ranks signals across all accounts at the snapshot: SLA breaches, at-risk tickets,
recurring product issues, multi-account incidents, credential exposure, stale order
statuses, incorrect past guidance, and **orders that already qualify for a credit where
nobody has complained**.

That last detector is the one I would demo. ORD-2002 is 4.5 hours past its pickup window
with carrier fault accepted and INR 300 owed under LumenWorks' agreement — and there is
no ticket. The customer has been let down and does not know it yet. Every other signal
describes work already in the queue; this one finds work that is not.

Two detectors deliberately refuse to fire:

- Orders inside the KI-211 webhook window (20 minutes) are **not** flagged as stale,
  because the product guide explicitly warns against telling a customer a pickup did not
  happen when the webhook is merely late. A detector that generates the exact false alarm
  the documentation warns about is worse than no detector.
- Resolved known issues (KI-176) never match new incidents, per the guide's instruction.

The dashboard is deterministic end to end — no model output — so an operator can check
any number against the evidence chips rather than trusting a summary.

---

## What I would build next, in priority order

1. **Answer-level evaluation harness.** ~60 golden questions with expected
   determinations, run in CI on every prompt and model change. Right now the *engine* is
   tested but the *agent* is not, so a prompt edit can regress tool selection silently.
   This is the highest-value missing piece and it is missing because of time, not doubt.

2. **Durable audit log with an approval queue.** Executed actions currently live in
   memory. Every state change should be a database row with actor, justification, the
   trace that produced it, and the confirming click — plus a manager queue for credits
   above the SOP threshold, so approval is a workflow rather than a role check.

3. **Drafted replies instead of answers.** The agent answers the person asking. For an
   internal user the more valuable output is a customer-ready draft with the citations
   attached, that an agent edits and sends. That converts the tool from a lookup aid into
   throughput.

4. **Contract ingestion as a reviewed pipeline.** Today a new agreement is scoped and
   tiered automatically, but its *clauses* are matched by hand-written rules. Offline LLM
   extraction into schema-validated rule objects, with a human approving the diff, makes
   onboarding a new enterprise contract a review task rather than an engineering task.
   This is what makes the system sellable to a company with 200 negotiated agreements.

5. **Signal feedback loop.** Let operators dismiss a signal with a reason, and track
   precision per detector. Without this, a proactive surface degrades into noise and gets
   ignored within a month — which is the normal fate of alerting dashboards.

6. **Month-to-date credit balances.** Northstar's INR 5,000 aggregate cap cannot be
   enforced because the dataset has no ledger. Today it is surfaced as a caution; it
   should be a running total that blocks the action.

---

## What I intentionally left out

- **Vector retrieval.** 23 chunks. Embeddings would be a costume, not an improvement —
  reasoning in the architecture note.
- **Real authentication.** The identity switcher is a mock roster shaped like a JWT claim
  set. Building real auth would demonstrate nothing the assessment is asking about, and
  it is the part most likely to be replaced by whatever ParcelPilot already runs.
- **Multi-agent orchestration.** One agent with well-described tools beats a router that
  can misroute. Revisit when the tool count outgrows a single context.
- **Streaming the ops dashboard / websockets.** The dataset is a fixed snapshot; live
  updates would be theatre.
- **Conversation persistence.** Chats are in-memory per session. Real, but not what is
  being evaluated.
- **A holiday calendar.** The hook exists and is empty; the correct list is an
  operational input, not something I should invent.

---

## The one metric

**Percentage of answers an agent sends without editing the substance.**

Measured by drafting replies (item 3 above) and diffing sent text against the draft:
formatting edits do not count, changed facts, figures or entitlements do.

Why this one over the obvious candidates:

- *Deflection rate* rewards the system for answering confidently, which is precisely the
  failure mode ParcelPilot is worried about. A confidently wrong answer scores well on
  deflection right up until it produces a refund dispute.
- *CSAT* is too slow and too noisy to steer a weekly release.
- *Resolution time* improves when the agent is fast and wrong.

Unedited-send rate is the only one that degrades when the system is confidently wrong,
because a support agent who does not trust the output rewrites it — and the rewrite is
the signal. It also tracks the thing that actually determines adoption: whether the
20-person ops team reaches for this tool or works around it.

I would pair it with one guardrail metric — **escalation precision**, the share of
escalations a human agrees were necessary — to catch the degenerate strategy of escalating
everything to keep the primary metric clean.
