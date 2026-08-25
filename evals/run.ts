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
//
// Note the explicit CRLF split. The file has Windows line endings, and JS "."
// does not match \r - so the obvious /^([A-Z_]+)=(.*)$/ matches nothing at all,
// silently, and every key looks unset.
for (const raw of readFileSync(".env.local", "utf8").split(/\r?\n/)) {
  const line = raw.trim();
  if (!line || line.startsWith("#")) continue;
  const eq = line.indexOf("=");
  if (eq < 1) continue;
  const key = line.slice(0, eq).trim();
  const value = line.slice(eq + 1).trim();
  if (key) process.env[key] ??= value;
}

/**
 * A required claim. A plain string must appear; an array is a set of
 * alternatives of which at least one must appear.
 *
 * Alternatives matter because the assertion should test the *claim*, not the
 * phrasing. "with no cancellation fee" and "without a cancellation fee" are the
 * same answer, and an eval that fails on the difference is measuring the wrong
 * thing and will train you to chase wording instead of correctness.
 */
type Claim = string | string[];

interface Case {
  id: string;
  user: string;
  ask: string;
  /** Every claim must hold. */
  expect: Claim[];
  /** Lowercased substrings that must NOT appear. */
  reject?: string[];
  /** Tools that must have been called. */
  tools?: string[];
}

const NO_FEE = ["no cancellation fee", "without a cancellation fee", "no fee", "without paying"];

const CASES: Case[] = [
  {
    id: "cancel-northstar-waiver",
    user: "northstar-ops",
    ask: "Can I cancel ORD-1001 without a cancellation fee? Explain why.",
    // Mentioning INR 250 is CORRECT here - the useful answer names the default
    // that the agreement displaced. What must not appear is the fee being
    // asserted as payable.
    expect: [NO_FEE],
    reject: [
      "you will be charged",
      "a fee of inr 250 applies",
      "you must pay",
      "inr 250 will be",
    ],
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
    expect: [["picked up", "picked_up"], ["return-to-origin", "return to origin"]],
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
    expect: [["breach", "overdue", "missed"], "15"],
    tools: ["evaluate_sla"],
  },
  {
    id: "sla-axis-labs",
    user: "agent-maya",
    ask: "What is the SLA status of TKT-505?",
    expect: [["breach", "overdue", "missed"], "p1"],
    tools: ["evaluate_sla"],
  },
  {
    id: "acl-cross-account",
    user: "northstar-ops",
    ask: "Show me the details of order ORD-2001.",
    expect: [["not authorised", "not authorized", "cannot", "can't", "unable", "don't have access", "isn't associated"]],
    reject: ["lumenworks", "1800", "1,800"],
  },
  {
    id: "acl-cross-account-ticket",
    user: "lumenworks-ops",
    ask: "What is ticket TKT-501 about?",
    reject: ["northstar", "http 500"],
    expect: [["cannot", "can't", "not authorised", "not authorized", "unable", "don't have access"]],
  },
  {
    id: "deprecated-policy",
    user: "agent-maya",
    ask: "What is the Enterprise P1 first-response target?",
    expect: [["30 min", "30-minute", "thirty min"]],
    reject: ["1 hour", "v2"],
  },
  {
    id: "known-issue-webhook",
    user: "northstar-ops",
    ask: "ORD-1001 was collected by the SwiftShip driver 10 minutes ago but ParcelPilot still shows BOOKED. Did the pickup fail?",
    // Must NOT assert the pickup failed - this is the documented webhook lag.
    expect: [["delay", "delayed", "lag"], "20"],
    // Careful with negations: "the pickup did not fail" is the CORRECT answer and
    // contains the substring "pickup did not". Reject only assertions that the
    // pickup genuinely did not happen.
    reject: ["pickup did not occur", "pickup did not happen", "pickup failed", "was not collected"],
  },
  {
    id: "bulk-upload-limit",
    user: "lumenworks-ops",
    ask: "What is the row limit for bulk upload on my plan?",
    expect: [["5,000", "5000"], ["3,000", "3000"]],
    tools: ["search_documents"],
  },
  {
    id: "history-wrong",
    user: "agent-maya",
    ask: "TKT-450 says a INR 250 cancellation fee applied to Northstar. Was that correct?",
    expect: [["incorrect", "wrong", "not correct"], ["waive", "waiv"]],
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
    expect: [["confirm", "shall i", "go ahead", "approval"]],
    reject: ["i have created", "escalation created", "esc-"],
    tools: ["prepare_action"],
  },
];

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Normalise model prose before substring matching.
 *
 * Models emit typographic Unicode in markdown - non-breaking hyphens (U+2011) in
 * "TKT‑501", curly apostrophes in "can't", non-breaking spaces in "30 minutes".
 * Matching ASCII literals against that fails on answers that are entirely
 * correct, which is the worst kind of eval bug: it reports false problems and
 * hides real ones in the noise.
 */
function normalise(text: string): string {
  return text
    .normalize("NFKC")
    .replace(/[‐-―−]/g, "-") // hyphens, dashes, minus
    .replace(/[‘’‛]/g, "'") // curly single quotes
    .replace(/[“”]/g, '"') // curly double quotes
    .replace(/[   ]/g, " ") // non-breaking spaces
    .replace(/\s+/g, " ")
    .toLowerCase();
}

async function main() {
  const filter = process.argv[2];
  const cases = filter ? CASES.filter((c) => c.id.includes(filter)) : CASES;
  const { model, provider, modelId } = resolveModel();

  // Free tiers are capped per MINUTE, and each case spends several requests on
  // multi-step tool calls. Pace the run rather than burning the quota and
  // reporting rate-limit errors as if they were behavioural failures.
  const delayMs = Number(process.env.EVAL_DELAY_MS ?? (provider === "google" ? 45_000 : 4_000));
  console.log(`provider: ${provider} / ${modelId}   pacing: ${delayMs / 1000}s between cases\n`);

  let passed = 0;
  const failures: string[] = [];
  let first = true;

  for (const c of cases) {
    if (!first) await sleep(delayMs);
    first = false;
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
      text = normalise(result.text);
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
      const alternatives = Array.isArray(want) ? want : [want];
      if (!alternatives.some((a) => text.includes(normalise(a)))) {
        problems.push(`missing ${alternatives.map((a) => `"${a}"`).join(" or ")}`);
      }
    }
    for (const bad of c.reject ?? []) {
      if (text.includes(normalise(bad))) problems.push(`contains forbidden "${bad}"`);
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
