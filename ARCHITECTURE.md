# Architecture Note

## The premise

The brief says the source base is intentionally imperfect and that a confidently
incorrect answer would reduce adoption. Those two sentences determine the whole design.

If documents disagree, and past answers may be wrong, then the risk is not that the
system fails to find an answer. With six documents totalling ~6 KB, retrieval is
trivial. The risk is that it finds *several* plausible answers and picks the wrong one
fluently. So the engineering effort goes into **deciding which source governs**, and
into making sure the number at the end of that decision was not produced by a language
model.

**The model never computes a figure and never resolves a conflict.** It selects tools
and narrates a trace that code produced. Everything below follows from that.

---

## Agent design

A single agent loop (Vercel AI SDK `streamText`, `stopWhen: stepCountIs(10)`,
`temperature: 0`) with a tool set bound to the caller's session. Two system prompts, one for
customers and one for internal staff, over one shared tool layer.

**Why one agent, not a router or a supervisor/worker graph.** The task space is narrow
and the tools are cheaply distinguishable by description. Multi-agent routing would add
a failure mode (misrouting) and latency to buy separation the tool descriptions already
provide. The two contexts differ in *scope and tone*, not in reasoning, and scope is
enforced below the model anyway. So a second agent would be two prompts pretending to
be an architecture.

**What the system prompt contains: behaviour only.** No fee, threshold, SLA target or
precedence outcome appears in it. Any figure written there would become a fourth source
of truth that nobody updates, and the model would keep reciting it after the policy
changed. The prompt says *how to behave when sources conflict*; the documents say *what
the rules are*.

**Multi-step by construction.** "Can Northstar cancel ORD-1001 without a fee?" runs
`get_order` → resolve account → `evaluate_cancellation`, which internally reads the
agreement and the SOP and returns the trace. The model does not need to be told the
sequence; each tool's description makes the next step obvious.

---

## Tool design

Three categories, as the brief requires, plus the confirmation pair.

**Retrieval**: `search_documents`. BM25 over authority-filtered chunks with query
expansion for domain synonyms ("SLA" never appears in the policy; it says "response
target").

**Structured lookup and calculation**: `get_order`, `get_ticket`, `get_account`,
`list_records`, and the three `evaluate_*` tools. The evaluators are the important ones:
they return a `Decision` object carrying `determination`, `trace`, `citations`,
`conflicts`, `unknowns`, and a `summary` safe to show verbatim.

**State change**: `prepare_action` / `execute_action`, described under Confirmation.

### Why the evaluators exist at all

A capable model *can* do "120 minutes is more than 30 minutes, so charge INR 250". The
problem is that it does this correctly most of the time, and the failures are invisible:
fluent, well cited and wrong. Moving the arithmetic into `evaluate_cancellation` makes
the answer reproducible, unit-testable, and auditable after the fact. The tool
descriptions say "ALWAYS use this instead of calculating yourself", and the returned
trace gives the model something better to do than compute: explain.

This also makes the interesting part of an answer surface automatically. Every trace
step can carry an `overrides` field, so "the SOP would have charged you INR 250, but your
agreement waives it" falls out of the data structure rather than depending on the model
choosing to mention it.

---

## Document handling

### Ingestion

`ingest/build.py` extracts each PDF, splits on numbered section headings, and tags every
chunk with metadata **parsed from the document itself**: `status` (CURRENT / DEPRECATED),
`effective`, `supersedes` / `superseded_by`, and `account_scope`.

Authority tier is derived, not hardcoded: a document carrying an `Account:` header *is*
a signed agreement scoped to one customer, and therefore outranks general policy. Others
are classified from their title. Dropping a new agreement into `data/raw/` scopes and
ranks it correctly with no code change.

One bug worth recording: the first classifier matched on title *and body*, which tiered
both policy documents as customer agreements. Every policy document contains the phrase
"a signed customer agreement may override these defaults" while explaining precedence.
Body matching is seductive and wrong for identity questions.

### Retrieval: why BM25 and not embeddings

The corpus is 23 chunks. A vector index would add a runtime dependency, a second failure
mode, and an opaque ranking, in exchange for recall that lexical search already
achieves here. More importantly it would solve the wrong problem: the difficulty is not
finding relevant passages, it is choosing between passages that are *all* relevant and
mutually contradictory. That is precedence, not similarity. Cosine distance cannot tell
you that a contract beats an SOP.

So retrieval is BM25 with an authority multiplier (agreement 1.6, policy 1.25, product
1.0, historical 0.6) applied after scoring, plus hard metadata filters applied *before*.

**At scale** this same layering holds: chunk embeddings + a cross-encoder reranker
replace BM25 for the candidate set, and the authority layer stays exactly where it is,
as a filter and a re-rank on top, never something the retriever is asked to learn.

### Conflict handling

Precedence is Policy v3 s1's own order: signed agreement → current policy/SOP → current
product docs → historical tickets (context only). It is applied in three places:

1. **Filtered.** DEPRECATED documents are removed from retrieval entirely, reachable
   only via explicit opt-in and always returned with a warning. Superseded policy cannot
   be cited by accident.
2. **Ranked**. The authority multiplier, so a contract clause surfaces above the
   general rule it displaces.
3. **Resolved**. The policy engine consults the contract first and records what it
   displaced in `overrides`, producing a `Conflict` entry.

Historical tickets are never authority. Beyond ignoring them, `signals.ts` actively
re-derives the correct answer for recorded resolutions and flags contradictions. A
wrong answer in a closed ticket is a live liability, because agents search old tickets
for precedent.

---

## Structured data handling

`ingest/build.py` emits typed records; `db.ts` types them; **`access.ts` is the only
module the tools may read through**, and every accessor takes a `Session`.

Access control is a data-layer property, not a prompt instruction:

- **Row scoping.** A customer's every query is filtered to their `account_id` before
  returning. Asking for `ORD-2001` by id as a Northstar customer returns a structured
  refusal.
- **Field redaction.** `historical_resolution` and `assigned_to` are stripped for
  customers. Historical resolutions are stripped specifically *because* they may be
  wrong; showing a customer a previous incorrect answer causes active harm.
- **Non-disclosure in refusals**. The refusal for a forbidden order does not name the
  owning account. A refusal that says "that belongs to LumenWorks" is itself a leak.
- **Document scoping**. Contract chunks carry `account_scope` and are unreachable
  outside it, so LumenWorks cannot retrieve Northstar's negotiated terms.

The tests call these accessors the way a jailbroken model would, asking directly for
another account's records by id, because that is the actual threat model. No prompt
injection can widen scope, since scope is not something the model can express.

---

## Time and the business calendar

The dataset snapshot, `2026-08-16 11:00 Asia/Kolkata`, **is a Sunday**. This is load-bearing:

- Northstar's P1 target is "15 minutes, **24x7**", the clock ran through the weekend,
  and TKT-501 is breached by 15 minutes.
- LumenWorks' agreement states "**No weekend or after-hours support coverage**", their
  business-hours clock has not started, so TKT-502's due time is Monday, not Sunday.

A single "minutes since created" implementation gets one of these wrong. So targets are
parsed into `{value, unit, clock}` where clock is `wall | business_hours | business_days`,
and elapsed time is measured against each target's own clock.

The parser treats a target written without the word "business" as wall-clock, because
the documents say "business hours" whenever they mean it. That is an interpretation, and
it is stated in the README and surfaced in the UI rather than buried.

---

## Confirmation before actions

Two phases. `prepare_action` validates authorisation, builds a field-by-field preview,
and returns an **HMAC-signed token**, changing nothing. `execute_action` is refused
unless that token appears in the confirmed set, which is populated only from the user's
click in the UI and passed in the request body. `buildTools` closes over it, so the model
has no way to add to it.

A signed token rather than a server-side pending-actions map because this runs on
serverless functions: two requests in one conversation may hit different instances, so
in-memory state is not a gate. The signature lets a cold instance verify it authored
this exact proposal and that the payload was not altered in between. Tokens expire after
30 minutes.

Role gating sits in the same layer: customers cannot issue credits or mutate tickets,
and an agent cannot approve a credit above the SOP's INR 1,000 manager-approval
threshold, only a manager can.

---

## Trade-offs

**Policy logic is code, provenance is data.** Fee and credit *rules* are TypeScript;
the numbers, thresholds and SLA targets are parsed from the documents at runtime. A
fully data-driven rule engine (DSL or LLM-extracted rule objects) would handle a novel
clause without a deploy, but at this corpus size it would be more machinery than the
problem justifies, and harder to test. The current split keeps every branch citing the
clause it implements. Change the SOP's numbers and the answers change; change its
*structure* and a test fails loudly. The scale path is offline LLM extraction into a
schema-validated, human-reviewed rules file.

**Severity is classified deterministically, and shown.** Keyword rules derived from
Policy v3 s2, with the model able to override given a documented reason. Because
classification is genuinely judgement-shaped, `evaluate_sla` returns targets for *all
three* severities, so a misclassification is visible in the response rather than
silently load-bearing.

**In-memory audit log.** Executed actions are recorded in memory and lost on restart.
Real deployment needs a database table; this was not worth building for a mocked action
tool, and it is the first thing I would add.

**No auth.** The identity switcher is a mock roster. The session object is shaped the
way a verified JWT claim set would be, so the swap is a single module.

**Business calendar has no holidays.** `CALENDAR.holidays` exists and is empty. Indian
public holidays would materially change due times and belong in a config the support
team owns.

---

## What I would change first at 1,000x

1. **Postgres + pgvector** for records and chunks; the authority layer moves to a SQL
   filter and stays identical in shape.
2. **Retrieval becomes hybrid**, BM25 + embeddings + cross-encoder rerank, once the
   corpus is large enough that lexical recall actually fails.
3. **Row-level security in the database**, so scoping survives a bug in application code
   rather than depending on every accessor being called correctly.
4. **Offline LLM clause extraction** into schema-validated rule objects with a human
   review step on the diff, replacing the hand-written rule branches.
5. **Durable action log + real ticketing integration**, with idempotency keys.
