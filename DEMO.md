# Demo Video Script, about 5 minutes

Two tabs: the app at https://parcelpilot-agent-theta.vercel.app and the repo.
Speak to the decisions, not the code. They can read code.

Each answer takes roughly 10 to 20 seconds to stream. Ask, talk over the tool trace while
it runs, then read the answer.

---

## 0:00 to 0:30. The premise

> "ParcelPilot's data pack is deliberately broken. Documents contradict each other, one
> policy is deprecated, contracts override the general rules, and two closed tickets
> contain answers that are simply wrong.
>
> So the risk isn't that a chatbot can't find an answer. There are only six documents.
> The risk is that it finds several plausible answers and picks the wrong one fluently.
> That drove every decision here.
>
> The main one: the model never produces a number and never resolves a conflict. A
> deterministic rule engine does that, and hands the model a trace to explain."

Point at the precedence ladder on the empty state.

> "That's the product in four lines. Signed agreement wins, then current policy, then
> product docs. Past ticket resolutions are context only, and may be wrong."

---

## 0:30 to 1:15. Architecture

Four layers, about twelve seconds each.

1. **Offline ingestion.** Python parses the PDFs into chunks tagged with authority
   metadata read from the documents themselves. A document with an `Account:` header is
   a signed agreement, so it outranks general policy. Drop in a new contract and it is
   scoped and ranked with no code change.
2. **Scoped data layer.** Every read takes a session and filters by account before
   returning. It is the only path the tools can use.
3. **Policy engine and retrieval.** Three evaluators return a determination plus a rule
   trace. Retrieval is BM25 with an authority boost.
4. **Agent.** Picks tools, narrates the trace, escalates when the engine says it cannot
   be sure.

> "Worth saying: no vector database. The corpus is 23 chunks. Embeddings would be a
> costume. The hard part isn't finding relevant text, it's choosing between passages that
> are all relevant and contradict each other. Cosine distance can't tell you a contract
> beats an SOP."

---

## 1:15 to 2:30. Demo 1, the example question

As **Ravi Menon** of Northstar. Type:

> **Can I cancel ORD-1001 without a cancellation fee? Explain why.**

While it runs, point at the tool trace. Expand it and read the `displaces` line.

> "No fee. The interesting part is why. This was booked two hours ago, and the SOP says
> anything past thirty minutes costs 250 rupees. But Northstar's signed agreement waives
> the fee entirely before pickup, so the contract wins.
>
> The system says that out loud: here's what the default would have been, here's what
> overrode it. That contrast is the most useful sentence in a support answer, and it
> falls out of the data structure rather than depending on the model's mood."

Switch to **Sara Iyer** of LumenWorks:

> **Can I cancel ORD-2001 for free?**

> "Same engine, different contract, and LumenWorks is charged. Their agreement says no
> waiver applies. Note the trap: their contract contains the phrase cancellation-fee
> waiver, but it's a denial. Keyword matching gets this exactly backwards."

---

## 2:30 to 3:10. Demo 2, access control

Still as **Sara Iyer**:

> **What is ticket TKT-501 about?**

> "That's Northstar's outage. She gets nothing. And the refusal doesn't say whose it is,
> because a refusal that names the other customer is itself a leak.
>
> This is enforced in the data layer, not the prompt. Scope is bound to the tools when
> they're constructed, so it isn't a parameter the model can set. There's no phrasing
> that widens it. The tests call these accessors the way a jailbroken model would, asking
> directly by id, because that's the real threat model."

---

## 3:10 to 3:50. Demo 3, SLA and the Sunday

Switch to **Maya** on the support team:

> **Is TKT-501 within its first-response SLA?**

> "Breached by fifteen minutes. Three things had to go right for that number.
>
> It used policy v3, not the deprecated v2 sitting in the same folder. v2 would have said
> one hour and reported no breach. It used Northstar's contractual fifteen-minute target,
> not the thirty-minute plan default. And it ran a 24x7 clock.
>
> That last one matters more than it looks. The dataset snapshot is a Sunday."

Then:

> **Is TKT-502 within SLA?**

> "Same day, and this clock hasn't started at all, because LumenWorks' agreement says no
> weekend or after-hours coverage. Its deadline is Monday. One 'minutes since created'
> implementation gets one of these two wrong, so every target carries its own clock type."

---

## 3:50 to 4:35. Demo 4, proactive detection and the action gate

Click **Operations**.

> "A reactive chatbot only helps once someone asks. This runs the same evaluators across
> every record. Two breached P1s, a credential exposure nobody has triaged for two hours,
> and my favourite: ORD-2002 is owed 300 rupees and there's no ticket. The customer has
> been let down and doesn't know yet. Every other signal is work already in the queue.
> That one finds work that isn't.
>
> It also flags past answers that were wrong, both planted errors, including a fee
> charged to a customer whose contract waives it. Agents cite old tickets as precedent,
> so a wrong answer in a closed ticket is a live liability.
>
> And it deliberately doesn't fire on orders inside the known webhook delay window,
> because the product guide warns against exactly that false alarm."

Scroll to the assumptions block.

> "The Sunday reasoning is stated on the page rather than buried."

Back to chat as Maya:

> **Escalate TKT-501.**

> "It proposes, it doesn't act. Field by field, with the justification. Nothing happens
> until I click Confirm. That gate is server side: the action is an HMAC-signed token and
> execute is refused unless the token came back from a real user click. Signed rather than
> stored, because on serverless the follow-up request may hit a different instance."

Click **Confirm**, show the reference id.

---

## 4:35 to 5:00. Close

> "What I'd build next, in order. An answer-level eval harness in CI: the engine has 86
> tests, but a prompt change can silently regress tool selection, which I hit during this
> build. Then a durable audit log with a manager approval queue. Then drafted customer
> replies instead of answers, which turns this from a lookup aid into throughput.
>
> And the metric I'd judge it on isn't deflection rate. Deflection rewards answering
> confidently, which is the exact failure mode here. It's the share of drafted replies an
> agent sends without changing the substance. That's the only number that gets worse when
> the system is confidently wrong."

---

## Pre-flight

- [ ] Do NOT run `npm run eval` first. It spends a real share of the daily quota.
- [ ] Load both pages once so they are warm.
- [ ] Walk the six questions once before recording. Model wording varies.
- [ ] Switching identity clears the chat automatically.
