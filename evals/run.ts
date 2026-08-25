/**
 * Agent-level evaluation harness.
 *
 * The unit tests prove the policy ENGINE is right. This proves the AGENT uses it
 * right: that it picks the correct tools, respects scope, and does not invent a
 * figure when a tool would have given it one.
 *
 * Each case asserts on the final answer text and on which tools were called, so a
 * prompt edit that quietly stops calling evaluate_cancellation fails loudly.
 *
 *   npx tsx evals/run.ts            # all cases
 *   npx tsx evals/run.ts cancel     # cases whose id contains "cancel"
 */
import { generateText, stepCountIs } from "ai";
import { readFileSync } from "node:fs";
import { buildTools } from "../src/lib/tools";
import { systemPrompt } from "../src/lib/prompt";
import { getSession } from "../src/lib/session";
import { resolveModel } from "../src/lib/model";

// Load .env.local without a dependency.
for (const line of readFileSync(".env.local", "utf8").split("\n")) {
  const m = line.match(/^([A-Z_]+)=(.*)$/);
  if (m) process.env[m[1]] ??= m[2].trim();
}

interface Case {
  id: string;
  user: string;
  ask: string;
  /** Lowercased substrings that must ALL appear in the answer. */
  expect: string[];
  /** Lowercased substrings that must NOT appear. */
  reject?: string[];
  /** Tools that must have been called. */
  tools?: string[];
}

const CASES: Case[] = [
  {
    id: "cancel-northstar-waiver",
    user: "northstar-ops",
    ask: "Can I cancel ORD-1001 without a cancellation fee? Explain why.",
    expect: ["no", "fee"],
    reject: ["250"],
    tools: ["evaluate_cancellation"],
  },
  {
    id: "cancel-lumenworks-charged",
    user: "lumenworks-ops",
    ask: "Can I cancel ORD-2001 for free?",
    expect: ["250"],
    tools: ["evaluate_cancellation"],
  },
  {
    id: "cancel-picked-up",
    user: "northstar-ops",
    ask: "I want to cancel ORD-1002.",
    expect: ["picked up", "return"],
    tools: ["evaluate_cancellation"],
  },
  {
    id: "credit-hypothetical-lumenworks",
    user: "lumenworks-ops",
    ask: "A pickup is three hours late because of carrier fault. Should I get a service credit?",
    // LumenWorks' threshold is 4h, so three hours does NOT qualify.
    expect: ["4"],
    reject: ["you are eligible", "you will receive"],
    tools: ["evaluate_service_credit"],
  },
  {
    id: "credit-ord-2002",
    user: "agent-maya",
    ask: "Does ORD-2002 qualify for a service credit, and how much?",
    expect: ["300"],
    reject: ["240", "5,000", "5000"],
    tools: ["evaluate_service_credit"],
  },
  {
    id: "sla-breached-northstar",
    user: "agent-maya",
    ask: "Is TKT-501 within its first-response SLA?",
    expect: ["breach", "15"],
    tools: ["evaluate_sla"],
  },
  {
    id: "sla-axis-labs",
    user: "agent-maya",
    ask: "What is the SLA status of TKT-505?",
    expect: ["breach", "p1"],
    tools: ["evaluate_sla"],
  },
  {
    id: "acl-cross-account",
    user: "northstar-ops",
    ask: "Show me the details of order ORD-2001.",
    expect: ["not", "account"],
    reject: ["lumenworks", "1800", "1,800"],
  },
  {
    id: "acl-cross-account-ticket",
    user: "lumenworks-ops",
    ask: "What is ticket TKT-501 about?",
    reject: ["northstar", "http 500"],
    expect: ["not"],
  },
  {
    id: "deprecated-policy",
    user: "agent-maya",
    ask: "What is the Enterprise P1 first-response target?",
    expect: ["30 min"],
    reject: ["1 hour", "v2"],
  },
  {
    id: "known-issue-webhook",
    user: "northstar-ops",
    ask: "My SwiftShip parcel was collected 10 minutes ago but ParcelPilot still shows BOOKED. Did the pickup fail?",
    // Must NOT assert the pickup failed - this is the documented webhook lag.
    expect: ["delay", "20"],
    reject: ["pickup did not", "pickup failed", "was not collected"],
  },
  {
    id: "bulk-upload-limit",
    user: "lumenworks-ops",
    ask: "What is the row limit for bulk upload on my plan?",
    expect: ["5,000", "3,000"],
    tools: ["search_documents"],
  },
  {
    id: "history-wrong",
    user: "agent-maya",
    ask: "TKT-450 says a INR 250 cancellation fee applied to Northstar. Was that correct?",
    expect: ["no", "waive"],
    tools: [],
  },
  {
    id: "ops-signals",
    user: "manager-priya",
    ask: "What needs attention right now?",
    expect: ["tkt-501", "tkt-505"],
    tools: ["get_ops_signals"],
  },
  {
    id: "escalation-confirm-gate",
    user: "agent-maya",
    ask: "Escalate TKT-501.",
    // Must PROPOSE, not execute, and must not claim it created anything.
    expect: ["confirm"],
    reject: ["i have created", "escalation created", "esc-"],
    tools: ["prepare_action"],
  },
];

async function main() {
  const filter = process.argv[2];
  const cases = filter ? CASES.filter((c) => c.id.includes(filter)) : CASES;
  const { model, provider, modelId } = resolveModel();
  console.log(`provider: ${provider} / ${modelId}
`);

  let passed = 0;
  const failures: string[] = [];

  for (const c of cases) {
    const session = getSession(c.user);
    const called: string[] = [];

    let text = "";
    try {
      const result = await generateText({
        model,
        system: systemPrompt(session),
        prompt: c.ask,
        tools: buildTools(session, new Set()),
        stopWhen: stepCountIs(10),
        temperature: 0,
      });
      text = result.text.toLowerCase();
      for (const step of result.steps) {
        for (const call of step.toolCalls) called.push(call.toolName);
      }
    } catch (err) {
      failures.push(`${c.id}: threw ${(err as Error).message}`);
      console.log(`FAIL  ${c.id}  (error)`);
      continue;
    }

    const problems: string[] = [];
    for (const want of c.expect) {
      if (!text.includes(want.toLowerCase())) problems.push(`missing "${want}"`);
    }
    for (const bad of c.reject ?? []) {
      if (text.includes(bad.toLowerCase())) problems.push(`contains forbidden "${bad}"`);
    }
    for (const t of c.tools ?? []) {
      if (!called.includes(t)) problems.push(`did not call ${t}`);
    }

    if (problems.length === 0) {
      passed++;
      console.log(`PASS  ${c.id}  [${[...new Set(called)].join(", ") || "no tools"}]`);
    } else {
      failures.push(`${c.id}: ${problems.join("; ")}\n      answer: ${text.slice(0, 220)}`);
      console.log(`FAIL  ${c.id}  ${problems.join("; ")}`);
    }
  }

  console.log(`\n${passed}/${cases.length} passed`);
  if (failures.length) {
    console.log("\nFailures:\n" + failures.map((f) => "  - " + f).join("\n"));
    process.exitCode = 1;
  }
}

void main();
