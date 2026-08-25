/**
 * SLA engine: severity classification and first-response breach calculation.
 *
 * Severity is classified deterministically from the Support Policy v3 s2
 * definitions. The model may override the classification by passing `severity`
 * explicitly, but the *targets and the arithmetic* are always computed here, and
 * the response always reports targets for all three severities so a
 * misclassification is visible rather than silently load-bearing.
 *
 * The clock matters as much as the number. The dataset snapshot is a Sunday, so
 * a "24x7" target has been running all weekend while a "business hours" target
 * has not started at all.
 */
import { toCitation, findClause } from "../corpus";
import { formatIst, humanDuration, isWeekend, nextWorkingInstant, possessive } from "../time";
import type { Account, Ticket } from "../db";
import { decision, type Decision, type RuleStep } from "./types";
import {
  describeTarget,
  dueAt,
  elapsedAgainst,
  noWeekendCoverage,
  policyTargets,
  resolveTarget,
  type Severity,
  type Target,
} from "./targets";

export interface SlaOutcome {
  severity: Severity;
  severity_source: "auto" | "caller";
  target: string | null;
  target_source: "contract" | "policy" | null;
  clock: string | null;
  created_at: string | null;
  due_at: string | null;
  elapsed: string | null;
  breached: boolean;
  overdue_by: string | null;
  /** Targets for every severity, so a wrong classification is auditable. */
  all_targets: Record<string, string>;
}

/**
 * Keyword rules derived from Support Policy v3 s2. Ordered: the first match wins,
 * so P1's "no workaround / total outage / security" signals beat P2's.
 */
const P1_PATTERNS: RegExp[] = [
  /\b(all|every)\b[^.]*\b(fail|failing|down|unable|broken)/i,
  /complete (production )?outage/i,
  /production outage/i,
  /\bapi key\b|\bcredential\b|\bsecret\b|\btoken\b/i,
  /security incident|breach|exposure|exposed|leaked/i,
  /cannot create any|no shipments? can be created/i,
];

const P2_PATTERNS: RegExp[] = [
  /\bfails?\b|\bfailing\b|\berror\b|\bdegraded\b|\bunavailable\b|\bnot working\b|\btimeout\b/i,
  /major feature/i,
];

const P3_PATTERNS: RegExp[] = [
  /\bhow do\b|\bhow can\b|\bhow to\b/i,
  /\bchange\b[^.]*\b(contact|email|address|setting)/i,
  /\bquestion\b|\brequest\b|\bconfigure\b|\bconfiguration\b/i,
];

export function classifySeverity(text: string): { severity: Severity; matched: string } {
  for (const re of P1_PATTERNS) {
    const m = text.match(re);
    if (m) return { severity: "P1", matched: m[0].trim() };
  }
  // A stated workaround is the policy's own dividing line between P1 and P2.
  for (const re of P3_PATTERNS) {
    const m = text.match(re);
    if (m) return { severity: "P3", matched: m[0].trim() };
  }
  for (const re of P2_PATTERNS) {
    const m = text.match(re);
    if (m) return { severity: "P2", matched: m[0].trim() };
  }
  return { severity: "P3", matched: "no critical or degradation signal found" };
}

function targetLabel(t: Target | null): string {
  return t ? describeTarget(t) : "not specified";
}

export function evaluateSla(
  ticket: Ticket,
  account: Account,
  nowMs: number,
  severityOverride?: Severity,
): Decision<SlaOutcome> {
  const trace: RuleStep[] = [];

  // --- Step 1: severity -----------------------------------------------------
  const haystack = `${ticket.subject} ${ticket.description}`;
  const auto = classifySeverity(haystack);
  const severity = severityOverride ?? auto.severity;
  const severityDefs = findClause(/severity definition/i);
  const severityCitation = severityDefs ? toCitation(severityDefs) : undefined;

  trace.push({
    rule: "Support Policy v3 s2 - severity definitions",
    outcome: severityOverride
      ? `Severity ${severity} supplied by the caller (automatic classification suggested ${auto.severity}).`
      : `Classified as ${severity} on the signal "${auto.matched}".`,
    citation: severityCitation,
  });

  // --- Step 2: which target governs? ----------------------------------------
  const { target, displaced } = resolveTarget(account.account_id, account.plan, severity);
  const allTargets: Record<string, string> = {};
  for (const sev of ["P1", "P2", "P3"] as Severity[]) {
    const r = resolveTarget(account.account_id, account.plan, sev);
    allTargets[sev] = targetLabel(r.target);
  }

  const citations = [severityCitation, target?.citation, displaced?.citation].filter(
    Boolean,
  ) as never[];

  if (!target) {
    return decision<SlaOutcome>({
      determination: {
        severity,
        severity_source: severityOverride ? "caller" : "auto",
        target: null,
        target_source: null,
        clock: null,
        created_at: ticket.created_at,
        due_at: null,
        elapsed: null,
        breached: false,
        overdue_by: null,
        all_targets: allTargets,
      },
      confidence: "needs_verification",
      trace,
      citations,
      unknowns: [{ field: "response target", why: "No target found for this plan or account." }],
      summary: `No first-response target could be resolved for ${account.account_name} at ${severity}.`,
    });
  }

  if (target.source === "contract") {
    trace.push({
      rule: "signed agreement - support terms",
      outcome: `${possessive(account.account_name)} agreement sets the ${severity} first-response target at ${describeTarget(target)}.`,
      citation: target.citation,
      overrides: displaced
        ? `Support Policy v3 default for ${account.plan} of ${describeTarget(displaced)}`
        : undefined,
    });
  } else {
    trace.push({
      rule: "Support Policy v3 s3 - default targets",
      outcome: `No agreement term applies, so the ${account.plan} plan default of ${describeTarget(target)} governs.`,
      citation: target.citation,
    });
  }

  // --- Step 3: the clock ----------------------------------------------------
  const createdMs = ticket.created_at
    ? Date.parse(`${ticket.created_at.replace(" ", "T")}Z`)
    : null;

  if (createdMs === null) {
    return decision<SlaOutcome>({
      determination: {
        severity,
        severity_source: severityOverride ? "caller" : "auto",
        target: describeTarget(target),
        target_source: target.source,
        clock: target.clock,
        created_at: null,
        due_at: null,
        elapsed: null,
        breached: false,
        overdue_by: null,
        all_targets: allTargets,
      },
      confidence: "needs_verification",
      trace,
      citations,
      unknowns: [{ field: "created_at", why: "Ticket has no creation timestamp." }],
      summary: `${ticket.ticket_id} has no creation time, so its SLA cannot be evaluated.`,
    });
  }

  const weekendClause = noWeekendCoverage(account.account_id);
  if (target.clock !== "wall" && isWeekend(nowMs)) {
    const resumesAt = nextWorkingInstant(nowMs);
    trace.push({
      rule: weekendClause.yes ? "signed agreement - coverage window" : "business calendar",
      outcome: weekendClause.yes
        ? `${possessive(account.account_name)} agreement excludes weekend and after-hours coverage, and the snapshot (${formatIst(nowMs)}) is a Sunday, so the response clock is paused until ${formatIst(resumesAt)}.`
        : `The target is measured in business time and the snapshot (${formatIst(nowMs)}) falls on a weekend, so the clock is paused until ${formatIst(resumesAt)}.`,
      citation: weekendClause.citation,
    });
  }

  const due = dueAt(target, createdMs);
  const elapsed = elapsedAgainst(target, createdMs, nowMs);
  const breached = nowMs > due;
  const overdueBy = breached ? nowMs - due : 0;

  trace.push({
    rule: "first-response calculation",
    outcome:
      `Created ${formatIst(createdMs)}; target ${describeTarget(target)}; due ${formatIst(due)}. ` +
      `At the snapshot (${formatIst(nowMs)}) ${humanDuration(elapsed)} of ${target.clock === "wall" ? "elapsed" : "business"} time has passed. ` +
      (breached ? `BREACHED by ${humanDuration(overdueBy)}.` : `Within target.`),
    citation: target.citation,
  });

  // Policy v3 s4 requires that a breach be stated plainly, not softened.
  const escalationClause = findClause(/escalation/i);
  if (breached && escalationClause) {
    trace.push({
      rule: "Support Policy v3 s4 - escalation",
      outcome:
        "The policy requires the breach to be stated clearly and escalation recommended rather than hiding uncertainty.",
      citation: toCitation(escalationClause),
    });
  }

  return decision<SlaOutcome>({
    determination: {
      severity,
      severity_source: severityOverride ? "caller" : "auto",
      target: describeTarget(target),
      target_source: target.source,
      clock: target.clock,
      created_at: formatIst(createdMs),
      due_at: formatIst(due),
      elapsed: humanDuration(elapsed),
      breached,
      overdue_by: breached ? humanDuration(overdueBy) : null,
      all_targets: allTargets,
    },
    trace,
    citations,
    conflicts:
      target.source === "contract" && displaced
        ? [
            {
              kind: "contract_overrides_policy",
              summary: `${possessive(account.account_name)} agreement sets ${describeTarget(target)} for ${severity}, replacing the ${account.plan} default of ${describeTarget(displaced)}.`,
              winner: target.citation,
              loser: displaced.citation,
            },
          ]
        : [],
    summary: breached
      ? `${ticket.ticket_id} (${severity}) has BREACHED its ${describeTarget(target)} first-response target by ${humanDuration(overdueBy)}. It was due ${formatIst(due)}.`
      : `${ticket.ticket_id} (${severity}) is within its ${describeTarget(target)} first-response target, due ${formatIst(due)}.`,
  });
}

export { policyTargets };
