# Demo Video Script (~5 minutes)

Recording notes: full screen, browser only. Two tabs — the app and the repo. Have the
identity switcher visible. Speak to the *decisions*, not the code; they can read code.

---

## 0:00–0:35 — The premise

> "ParcelPilot's data pack is deliberately broken. Documents contradict each other, one
> policy is deprecated, contracts override the general rules, and two closed tickets
> contain answers that are simply wrong.
>
> So the risk here isn't that a chatbot can't find an answer — there are only six
> documents. The risk is that it finds *several* plausible answers and picks the wrong
> one fluently. That's the whole problem, and it drove every decision I made.
>
> The core one: **the model never produces a number and never resolves a conflict.**
> A deterministic rule engine does that, and hands the model a trace to explain."

---

## 0:35–1:25 — Architecture (one slide or the README diagram)

Walk the four layers, ~12 seconds each:

1. **Offline ingestion** — Python parses the PDFs into chunks tagged with authority
   metadata read *from the documents themselves*. A document with an `Account:` header
   is a signed agreement, so it outranks general policy. Drop in a new contract and it's
   scoped and ranked with no code change.
2. **Scoped data layer** — every read takes a session and filters by account *before*
   returning. This is the only path the tools can use.
3. **Policy engine + retrieval** — three evaluators (cancellation, credit, SLA) return a
   determination plus a rule trace. Retrieval is BM25 with an authority boost.
4. **Agent** — picks tools, narrates the trace, escalates when the engine says it can't
   be sure.

> "Worth saying explicitly: I didn't use a vector database. The corpus is 23 chunks.
> Embeddings would be a costume. The hard part isn't finding relevant text — it's
> choosing between passages that are all relevant and contradict each other. Cosine
> distance can't tell you a contract beats an SOP. So the effort went into precedence."

---

## 1:25–2:35 — Demo 1: the example question, and why it's a trap

Signed in as **Ravi Menon — Northstar**. Ask:

> **"Can I cancel ORD-1001 without a cancellation fee? Explain why."**

While it runs, point at the tool trace:

> "You can watch it work — it looks up the order, resolves the account, then calls the
> cancellation engine."

Expand the `evaluate_cancellation` trace and read the `overrides` line aloud.

> "The answer is **no fee** — and the interesting part is *why*. This was booked two
> hours ago. The SOP says anything past 30 minutes costs INR 250. But Northstar's signed
> agreement waives the fee entirely before pickup, so the contract wins.
>
> The system says that out loud: here's what the default would have been, here's what
> overrode it. That contrast is usually the most useful sentence in a support answer, and
> it falls out of the data structure rather than depending on the model's mood."

Then, to show it isn't hardcoded, switch to **Sara Iyer — LumenWorks** and ask:

> **"Can I cancel ORD-2001 for free?"**

> "Same engine, different contract — and LumenWorks *is* charged INR 250, because their
> agreement explicitly says no waiver applies. Note the parsing trap there: their contract
> contains the phrase 'cancellation-fee waiver', but it's a denial. Matching on keywords
> gets this exactly backwards."

---

## 2:35–3:20 — Demo 2: access control

Still as **Sara Iyer — LumenWorks**:

> **"What is ticket TKT-501 about?"**

> "That's Northstar's outage. She gets nothing — and notice the refusal doesn't say
> *whose* it is, because a refusal that names the other customer is itself a leak.
>
> This is enforced in the data layer, not the prompt. Scope is bound to the tools when
> they're constructed, so it isn't a parameter the model can set. There's no phrasing
> that widens it. The tests call these accessors the way a jailbroken model would —
> asking directly by id — because that's the real threat model."

Switch to **Maya — ParcelPilot Support**, ask the same question, show the full record
including the internal fields customers never see.

---

## 3:20–4:05 — Demo 3: SLA, and the Sunday

As **Maya**:

> **"Is TKT-501 within its first-response SLA?"**

> "Breached, by fifteen minutes. Three things had to go right for that number.
>
> It used policy **v3**, not the deprecated v2 sitting in the same folder — v2 would have
> said one hour and reported no breach. It used Northstar's contractual fifteen-minute
> target, not the thirty-minute plan default. And it ran a **24x7** clock.
>
> That last one matters more than it looks. **The dataset snapshot is a Sunday.**"

Then ask about **TKT-502** (LumenWorks):

> "Same day, and this one's clock hasn't started at all — because LumenWorks' agreement
> says 'no weekend or after-hours coverage'. Its deadline is Monday. A single
> 'minutes since created' implementation gets one of these two wrong, so targets carry
> their own clock type."

---

## 4:05–4:40 — Demo 4: proactive detection + the confirmation gate

Open **/ops**:

> "A reactive chatbot only helps once someone asks. This runs the same evaluators across
> every record. Two breached P1s, a credential exposure nobody's triaged for two hours —
> and my favourite: **ORD-2002 is owed INR 300 and there's no ticket.** The customer has
> been let down and doesn't know yet. Every other signal is work already in the queue;
> that one finds work that isn't.
>
> It also flags **past answers that were wrong** — both planted errors, including a fee
> charged to a customer whose contract waives it. Agents cite old tickets as precedent,
> so a wrong answer in a closed ticket is a live liability.
>
> And it deliberately *doesn't* fire on orders inside the known webhook-delay window,
> because the product guide warns against exactly that false alarm."

Back to chat as Maya:

> **"Escalate TKT-501."**

> "It proposes — it doesn't act. Field by field, with the justification. Nothing happens
> until I click Confirm. That gate is server-side: the action is an HMAC-signed token, and
> execute is refused unless the token came back from a real user click. Signed rather than
> stored, because on serverless the follow-up request may hit a different instance."

Click **Confirm**, show the reference id.

---

## 4:40–5:00 — Close

> "What I'd build next, in order: an answer-level eval harness in CI — the engine is
> covered by 77 tests, but a prompt change can silently regress tool *selection*. Then a
> durable audit log with a manager approval queue. Then drafted customer replies instead
> of answers, which is what turns this from a lookup aid into throughput.
>
> And the metric I'd judge it on isn't deflection rate — deflection rewards answering
> confidently, which is the exact failure mode here. It's **the share of drafted replies
> an agent sends without changing the substance.** That's the only number that gets worse
> when the system is confidently wrong."

---

## Pre-flight checklist

- [ ] `npm run build && npm test` — 77 passing
- [ ] OpenRouter account has credits (free tier caps at 50 requests/day)
- [ ] Hosted URL loads, both pages
- [ ] Walk every demo question once before recording — model output varies
- [ ] Reset the chat between identity switches (the switcher does this automatically)
