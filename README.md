# ParcelPilot AI Support Agent

An AI support system for ParcelPilot, a B2B logistics platform. It serves two user
contexts over one shared tool layer: a **customer-facing agent** scoped to a single
account, and an **internal support/operations agent** with a proactive issue dashboard.

**The core idea:** the language model never produces a figure or a precedence decision.
Fees, credits, SLA targets and breach states are computed by a deterministic policy
engine that returns a rule trace naming which clause won and which it displaced. The
model selects tools and explains the trace. That is what makes a confidently wrong
answer structurally hard rather than merely discouraged.

---

## Quick start

```bash
npm install
python -m pip install -r ingest/requirements.txt   # pdfplumber, pandas, openpyxl
python ingest/build.py                              # data pack -> src/data/*.json
cp .env.example .env.local                          # then add one free model API key
npm run dev                                         # http://localhost:3000
```

`ingest/build.py` only needs re-running when the documents in `data/raw/` change; its
output is committed, so `npm run dev` works on a clean checkout without Python.

### Environment

Set **one** model provider. They are tried in the order listed.

| Variable | Notes |
|---|---|
| `GOOGLE_GENERATIVE_AI_API_KEY` | [AI Studio](https://aistudio.google.com/apikey) — free tier, no card. Recommended for a hosted demo. Model via `GOOGLE_MODEL` (default `gemini-2.5-flash`). |
| `GROQ_API_KEY` | [Groq](https://console.groq.com/keys) — free tier, no card. Model via `GROQ_MODEL` (default `llama-3.3-70b-versatile`). |
| `OPENROUTER_API_KEY` | Model via `OPENROUTER_MODEL` (default `anthropic/claude-haiku-4.5`). Note: OpenRouter's free tier is capped at **50 requests/day** with no credit balance, which a deployed demo exhausts quickly. |
| `ACTION_SIGNING_SECRET` | HMAC key for action confirmation tokens. Set it in production. |

The agent's behaviour lives in the tools and the policy engine, not in any one
vendor, so the provider is a swap in `src/lib/model.ts`. Any model with reliable
tool calling works.

### Tests

```bash
npm test          # 77 tests: policy engine, access control, signals, retrieval
npm run build     # typecheck + production build
```

The policy tests are the interesting ones. They assert the answers this data pack was
designed to catch people out on — see [Known traps](#known-traps-in-the-data-pack).

---

## What it does

### Two user contexts, one tool layer

Switch identity from the header. The same question returns different data because
scope is enforced in the data layer, not requested by the model.

| Identity | Role | Scope |
|---|---|---|
| Ravi Menon — Northstar | customer | ACCT-001 only, internal fields stripped |
| Sara Iyer — LumenWorks | customer | ACCT-002 only |
| Dev Shah — Beacon Retail | customer | ACCT-003 only |
| Maya — ParcelPilot Support | support agent | all accounts, cannot approve large credits |
| Priya Mehta — Support Manager | manager | all accounts, may approve credits above the SOP threshold |

### Tools

| Tool | Kind | Purpose |
|---|---|---|
| `search_documents` | retrieval | BM25 over authority-ranked, scope-filtered chunks |
| `get_order` / `get_ticket` / `get_account` / `list_records` | structured | Scoped record lookup |
| `evaluate_cancellation` | calculation | Cancellability + fee, with precedence trace |
| `evaluate_service_credit` | calculation | Credit eligibility + amount, real or hypothetical |
| `evaluate_sla` | calculation | Severity, target, due time, breach — on the correct clock |
| `get_ops_signals` | structured | Internal only: ranked proactive signals |
| `prepare_action` | state change | Proposes an action, changes nothing |
| `execute_action` | state change | Executes, only after the user confirms |

### The confirmation gate

`prepare_action` returns an HMAC-signed token and a preview of exactly what will
change. `execute_action` is refused unless that token is in the set the **user**
confirmed by clicking Confirm in the UI. The model cannot add to that set. A signed
token rather than server-side state, because this deploys to serverless functions
where consecutive requests may hit different instances.

---

## Known traps in the data pack

The source base is deliberately imperfect. These are the conflicts the system resolves,
each covered by a test:

| # | Trap | Naive answer | Correct answer |
|---|---|---|---|
| 1 | **ORD-1001** cancelled 120 min after booking | INR 250 fee (SOP: fee after 30 min) | **No fee** — Northstar's agreement waives it regardless of elapsed time |
| 2 | **TKT-450** closed with "INR 250 fee applied" | Repeat it as precedent | It was **wrong** — flagged as incorrect historical guidance |
| 3 | **TKT-451** closed with "Growth supports 3,000 rows" | Repeat it | Wrong — the guide says **5,000**; 3,000 is the KI-208 *workaround* |
| 4 | **ORD-2002** credit amount | INR 240 (SOP: 10% of 2,400) | **INR 300** — LumenWorks' fixed amount at a 4h threshold |
| 5 | Northstar's "INR 5,000" | Treat as the credit amount | It is a **monthly aggregate cap**, not a credit |
| 6 | **TKT-501** Northstar P1 | Not breached (v2 says 1 hour) | **Breached by 15 min** — v3 + contract give a 15-min 24x7 target |
| 7 | **TKT-505** API key exposure | A support question | **P1** under v3, breached by 2h, and nobody has flagged it |
| 8 | **TKT-504** SwiftShip still BOOKED | Tell the customer pickup failed | It is **KI-211** webhook lag (up to 20 min) — do not say pickup failed |
| 9 | **Snapshot is a Sunday** | Run every SLA clock at wall time | LumenWorks has *no weekend coverage*; their business-hours clock has not started |
| 10 | Policy v2 in the corpus | Retrieve and cite it | **Excluded** from retrieval unless explicitly requested, and warned |

Trap 9 is the easiest to miss. `2026-08-16` is a Sunday, so a "24x7" target has been
running all weekend while a "business hours" target has not started at all. The two
kinds of target cannot share an implementation.

---

## Architecture

```
data/raw/                     the supplied pack, unmodified
   |
   v
ingest/build.py               PDFs -> authority-tagged chunks; xlsx -> typed records
   |
   v
src/data/*.json               committed artifacts (no Python at runtime)
   |
   +--> corpus.ts   authority tiers, account scoping, lifecycle filtering
   +--> access.ts   THE access-control choke point; every read takes a Session
   |
   v
policy/  cancellation | credit | sla | targets     deterministic, traced, tested
retrieval.ts  BM25 + authority boost
signals.ts    proactive detectors
   |
   v
tools.ts      bound to a Session at construction
   |
   v
api/chat      streamText, multi-step, temperature 0
   |
   v
UI            chat + live tool trace + confirmation cards + /ops dashboard
```

Full reasoning, trade-offs and what I would do differently at scale:
**[ARCHITECTURE.md](./ARCHITECTURE.md)**

Product decisions, the client problem I chose, what I left out and the metric I would
judge this on: **[PRODUCT.md](./PRODUCT.md)**

---

## Stated assumptions

The brief invites assumptions. These are the ones that change answers:

- **"Now" is the dataset snapshot**, 2026-08-16 11:00 Asia/Kolkata, never the real clock.
- **Business hours are Mon–Fri 09:00–18:00 IST.** Public holidays are not modelled.
- **A target without the word "business" is wall-clock.** The documents write
  "business hours" whenever they mean it, so the omission carries meaning.
- **"N business days" means end of the Nth working day**, which is how support teams quote it.
- **Historical ticket resolutions are never authority**, per the README sheet and Policy v3 s1.
- Month-to-date credit totals are not in the dataset, so Northstar's INR 5,000 aggregate cap
  is surfaced as a caution rather than enforced as a running balance.

---

## AI tool usage

Built with **Claude Code** (Claude Opus), used heavily and deliberately.

How it was used: I gave it the data pack and the brief, and worked with it
interactively — it read every source document and workbook row up front, enumerated the
planted conflicts, and I directed the architecture from there (deterministic engine over
model arithmetic, precedence as a data-layer property, access control at the tool
boundary rather than in the prompt). It wrote the ingestion pipeline, the policy engine,
the tools and the UI; I reviewed and redirected as it went.

Two bugs it caught and fixed during the build are worth naming, because they are the
kind that ship silently: a document classifier that tiered the *policy* documents as
customer agreements (the word "agreement" appears in their body text while describing
precedence), and a ticket-to-known-issue matcher loose enough to group a total outage
with a bulk-upload defect because both mentioned "shipment".

The test suite was written alongside the engine, asserting hand-derived answers from the
source documents rather than whatever the code happened to return.
