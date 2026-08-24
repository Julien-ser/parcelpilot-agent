/**
 * Proactive issue detection (client problem 1).
 *
 * A reactive chatbot only helps once someone asks. These detectors run over the
 * whole support surface and surface what deserves attention before anyone
 * files a question about it.
 *
 * Every signal is deterministic and carries its own evidence, so an operator can
 * check the reasoning rather than trusting a summary. No model is involved in
 * producing this list - the model is only used to talk about it.
 */
import { ORDERS, TICKETS, SNAPSHOT_MS, accountById, type Ticket } from "./db";
import { productChunks, findClause, toCitation, type Citation } from "./corpus";
import { HOUR, formatIst, humanDuration } from "./time";
import { evaluateSla } from "./policy/sla";
import { evaluateCredit, creditInputsFromOrder } from "./policy/credit";
import { contractWaivesFee } from "./policy/cancellation";

export type SignalSeverity = "critical" | "high" | "medium" | "low";

export interface Signal {
  id: string;
  kind:
    | "sla_breach"
    | "sla_at_risk"
    | "issue_cluster"
    | "multi_account_issue"
    | "silent_failure"
    | "stale_status"
    | "incorrect_history"
    | "security";
  severity: SignalSeverity;
  title: string;
  detail: string;
  /** Ticket / order / account ids this signal is built from. */
  evidence: string[];
  accounts: string[];
  recommended_action: string;
  citations?: Citation[];
}

const SEVERITY_RANK: Record<SignalSeverity, number> = {
  critical: 0,
  high: 1,
  medium: 2,
  low: 3,
};

// --- Known issues parsed from the product operations guide -------------------

export interface KnownIssue {
  id: string;
  title: string;
  status: string;
  body: string;
  resolved: boolean;
}

export function knownIssues(): KnownIssue[] {
  const out: KnownIssue[] = [];
  for (const chunk of productChunks()) {
    const re = /(KI-\d+)\s*-\s*([^\n]+)/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(chunk.text)) !== null) {
      const start = m.index;
      const next = chunk.text.slice(start + m[0].length);
      const body = next.split(/KI-\d+\s*-/)[0].trim();
      const statusMatch = body.match(/Status:\s*([^\n]+)/i);
      const resolved =
        /resolved/i.test(m[2]) || /resolved/i.test(chunk.section) || /Resolved\s+\d/i.test(body);
      out.push({
        id: m[1],
        title: m[2].trim(),
        status: statusMatch ? statusMatch[1].trim() : resolved ? "Resolved" : "Unknown",
        body,
        resolved,
      });
    }
  }
  return out;
}

/**
 * Words that appear across most ParcelPilot support text and therefore carry no
 * discriminating power. Without this, an outage ticket matches a bulk-upload
 * defect purely because both say "shipment".
 */
const GENERIC_TERMS = new Set([
  "shipment", "shipments", "order", "orders", "customer", "customers", "issue",
  "issues", "parcelpilot", "support", "still", "when", "some", "individual",
  "affected", "unaffected", "workaround", "status", "opened", "user", "users",
]);

function signatureTerms(text: string): Set<string> {
  return new Set(
    text
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, " ")
      .split(/\s+/)
      .filter((w) => w.length > 3 && !GENERIC_TERMS.has(w)),
  );
}

/**
 * Match a ticket to a known issue on the issue's TITLE terms, not its body.
 *
 * Body matching is too permissive: KI-208's body mentions "individual shipment
 * creation is unaffected", which made a total-outage ticket look like a
 * bulk-upload report. Requiring two distinctive title terms keeps
 * "Bulk upload fails for 4,200-row CSV" matching KI-208 while excluding
 * unrelated tickets that merely share vocabulary.
 */
export function matchKnownIssue(ticket: Ticket): KnownIssue | null {
  const ticketTerms = signatureTerms(`${ticket.subject} ${ticket.description}`);
  let best: { issue: KnownIssue; score: number } | null = null;

  for (const issue of knownIssues()) {
    // A resolved issue must not be used to explain new incidents (product guide s3).
    if (issue.resolved) continue;
    const titleTerms = signatureTerms(issue.title);
    let hits = 0;
    for (const term of titleTerms) if (ticketTerms.has(term)) hits++;
    if (hits >= 2 && (!best || hits > best.score)) best = { issue, score: hits };
  }
  return best?.issue ?? null;
}

// --- Detectors ---------------------------------------------------------------

function detectSlaSignals(): Signal[] {
  const out: Signal[] = [];
  for (const t of TICKETS) {
    if (t.status !== "open") continue;
    const account = accountById(t.account_id);
    if (!account) continue;
    const d = evaluateSla(t, account, SNAPSHOT_MS);
    const det = d.determination;

    if (det.breached) {
      out.push({
        id: `sla-${t.ticket_id}`,
        kind: "sla_breach",
        severity: det.severity === "P1" ? "critical" : "high",
        title: `${t.ticket_id} (${det.severity}) has breached its first-response target`,
        detail:
          `${account.account_name}: "${t.subject}". Target ${det.target} (${det.target_source}), ` +
          `due ${det.due_at}, now overdue by ${det.overdue_by} at the ${formatIst(SNAPSHOT_MS)} snapshot.`,
        evidence: [t.ticket_id, account.account_id],
        accounts: [account.account_id],
        recommended_action:
          "Escalate immediately and state the breach plainly to the customer, per Support Policy v3 s4.",
        citations: d.citations,
      });
    } else if (det.due_at && det.clock === "wall") {
      // Approaching: more than 75% of a wall-clock target consumed.
      const created = t.created_at ? Date.parse(`${t.created_at.replace(" ", "T")}Z`) : null;
      const due = Date.parse(`${det.due_at.replace(" IST", "").replace(" ", "T")}Z`);
      if (created && due > SNAPSHOT_MS) {
        const consumed = (SNAPSHOT_MS - created) / (due - created);
        if (consumed >= 0.75) {
          out.push({
            id: `sla-risk-${t.ticket_id}`,
            kind: "sla_at_risk",
            severity: det.severity === "P1" ? "high" : "medium",
            title: `${t.ticket_id} (${det.severity}) is approaching its response target`,
            detail: `${Math.round(consumed * 100)}% of the ${det.target} target consumed; due ${det.due_at}.`,
            evidence: [t.ticket_id],
            accounts: [account.account_id],
            recommended_action: "Respond now or hand off before the target lapses.",
          });
        }
      }
    }

    if (/api key|credential|secret|token|exposure|leaked/i.test(`${t.subject} ${t.description}`)) {
      out.push({
        id: `sec-${t.ticket_id}`,
        kind: "security",
        severity: "critical",
        title: `${t.ticket_id} reports possible credential exposure`,
        detail: `${account.account_name}: "${t.subject}". Support Policy v3 s2 classifies suspected credential exposure as P1 regardless of other impact.`,
        evidence: [t.ticket_id],
        accounts: [account.account_id],
        recommended_action:
          "Treat as P1: rotate the exposed key, audit its usage, and confirm revocation with the customer.",
      });
    }
  }
  return out;
}

function detectIssueClusters(): Signal[] {
  const clusters = new Map<string, Ticket[]>();
  for (const t of TICKETS) {
    const issue = matchKnownIssue(t);
    if (!issue) continue;
    const list = clusters.get(issue.id) ?? [];
    list.push(t);
    clusters.set(issue.id, list);
  }

  const issues = knownIssues();
  const out: Signal[] = [];
  for (const [kiId, tickets] of clusters) {
    if (tickets.length < 2) continue;
    const issue = issues.find((i) => i.id === kiId)!;
    const accounts = [...new Set(tickets.map((t) => t.account_id))];
    const multi = accounts.length > 1;
    out.push({
      id: `cluster-${kiId}`,
      kind: multi ? "multi_account_issue" : "issue_cluster",
      severity: multi ? "high" : "medium",
      title: `${tickets.length} tickets match ${kiId} - ${issue.title}${multi ? ` across ${accounts.length} accounts` : ""}`,
      detail:
        `${kiId} is currently "${issue.status}". Tickets: ${tickets.map((t) => t.ticket_id).join(", ")}. ` +
        (multi
          ? "Because more than one account is affected, this is a product-level problem rather than a customer-specific one."
          : "Repeat reports from the same account suggest the workaround is not landing."),
      evidence: tickets.map((t) => t.ticket_id),
      accounts,
      recommended_action: `Link these tickets to ${kiId}, confirm the documented workaround was communicated, and push for an engineering update.`,
    });
  }
  return out;
}

/**
 * Orders that already qualify for a service credit where nobody has filed a
 * ticket. These are the expensive ones: the customer has been let down and does
 * not know it yet, so the first contact will be an angry one.
 */
function detectSilentFailures(): Signal[] {
  const out: Signal[] = [];
  for (const o of ORDERS) {
    const account = accountById(o.account_id);
    if (!account) continue;
    const d = evaluateCredit(creditInputsFromOrder(o, SNAPSHOT_MS), account, SNAPSHOT_MS);
    if (!d.determination.eligible) continue;

    const related = TICKETS.filter(
      (t) => t.account_id === o.account_id && new RegExp(o.order_id, "i").test(`${t.subject} ${t.description}`),
    );
    if (related.length > 0) continue;

    out.push({
      id: `silent-${o.order_id}`,
      kind: "silent_failure",
      severity: "high",
      title: `${o.order_id} qualifies for a service credit but no ticket has been raised`,
      detail:
        `${account.account_name}'s pickup is ${d.determination.delay_hours?.toFixed(1)}h past the window ` +
        `with carrier fault accepted. ${d.summary} The customer has not contacted support about it.`,
      evidence: [o.order_id, account.account_id],
      accounts: [account.account_id],
      recommended_action:
        "Reach out proactively, offer the credit the agreement entitles them to, and confirm a new pickup.",
      citations: d.citations,
    });
  }
  return out;
}

/**
 * Orders still showing BOOKED well past their pickup window. The product guide
 * documents a webhook delay of up to 20 minutes (KI-211), so anything inside
 * that window is deliberately NOT flagged - that would generate exactly the
 * false alarm the guide warns against.
 */
function detectStaleStatuses(): Signal[] {
  const ki211 = knownIssues().find((i) => /webhook/i.test(i.title));
  const delayWindowMs = (() => {
    const m = ki211?.body.match(/up to\s+(\d+)\s*minutes?/i);
    return m ? Number(m[1]) * 60_000 : 20 * 60_000;
  })();

  const out: Signal[] = [];
  for (const o of ORDERS) {
    if (o.status !== "BOOKED" || !o.pickup_window_end) continue;
    const windowEnd = Date.parse(`${o.pickup_window_end.replace(" ", "T")}Z`);
    const overdue = SNAPSHOT_MS - windowEnd;
    if (overdue <= delayWindowMs) continue;

    const account = accountById(o.account_id);
    out.push({
      id: `stale-${o.order_id}`,
      kind: "stale_status",
      severity: overdue > 4 * HOUR ? "high" : "medium",
      title: `${o.order_id} still shows BOOKED, ${humanDuration(overdue)} past its pickup window`,
      detail:
        `${account?.account_name ?? o.account_id}, carrier ${o.carrier}. Window closed ${formatIst(windowEnd)}. ` +
        `This is beyond the ${Math.round(delayWindowMs / 60000)}-minute ${ki211?.id ?? "webhook"} delay window, so it is unlikely to be a stale webhook.`,
      evidence: [o.order_id],
      accounts: [o.account_id],
      recommended_action: "Confirm the physical pickup status with the carrier before contacting the customer.",
    });
  }
  return out;
}

/**
 * Closed tickets whose recorded answer contradicts what current policy says.
 *
 * The dataset README warns that historical resolutions may be wrong. Wrong
 * answers do not stay in the past: agents search old tickets for precedent and
 * repeat them. Each detector below re-derives the correct answer from the
 * current sources and compares.
 */
function detectIncorrectHistory(): Signal[] {
  const out: Signal[] = [];

  for (const t of TICKETS) {
    const resolution = t.historical_resolution;
    if (!resolution) continue;
    const account = accountById(t.account_id);
    if (!account) continue;

    // (a) A cancellation fee was quoted to an account whose agreement waives it.
    if (/cancellation fee/i.test(resolution) && /INR\s*\d/i.test(resolution)) {
      const { waived, clause } = contractWaivesFee(account.account_id);
      if (waived) {
        out.push({
          id: `hist-${t.ticket_id}`,
          kind: "incorrect_history",
          severity: "high",
          title: `${t.ticket_id} recorded an answer that contradicts ${account.account_name}'s agreement`,
          detail:
            `The recorded resolution says: "${resolution}" - but ${account.account_name}'s signed agreement ` +
            `waives the cancellation fee for any BOOKED shipment before pickup, regardless of elapsed time. ` +
            `The customer was very likely charged, or told they would be, in error.`,
          evidence: [t.ticket_id, account.account_id],
          accounts: [account.account_id],
          recommended_action:
            "Review whether a fee was actually charged, refund if so, and correct the ticket so it stops being cited as precedent.",
          citations: clause ? [toCitation(clause)] : undefined,
        });
      }
    }

    // (b) A plan row-limit was quoted that disagrees with the product guide.
    const quoted = resolution.match(/(\d[\d,]*)\s*rows?/i);
    if (quoted) {
      const planClause = findClause(/plan capabilit/i);
      const documented = planClause?.text.match(/up to\s+([\d,]+)\s*rows?/i);
      if (documented) {
        const quotedRows = Number(quoted[1].replace(/,/g, ""));
        const documentedRows = Number(documented[1].replace(/,/g, ""));
        if (quotedRows !== documentedRows) {
          out.push({
            id: `hist-rows-${t.ticket_id}`,
            kind: "incorrect_history",
            severity: "medium",
            title: `${t.ticket_id} quoted a ${quotedRows.toLocaleString()}-row limit that the product guide does not support`,
            detail:
              `The recorded resolution says: "${resolution}" - but the product guide documents a supported limit of ` +
              `${documentedRows.toLocaleString()} rows. The ${quotedRows.toLocaleString()}-row figure is the temporary ` +
              `workaround for a known defect, not a plan entitlement. Repeating it understates what the customer bought.`,
            evidence: [t.ticket_id, account.account_id],
            accounts: [account.account_id],
            recommended_action:
              "Correct the ticket, and describe the limit as a known-issue workaround rather than a plan capability.",
            citations: planClause ? [toCitation(planClause)] : undefined,
          });
        }
      }
    }
  }
  return out;
}

/** Everything, ranked. Callers must already hold the ops capability. */
export function detectSignals(): Signal[] {
  return [
    ...detectSlaSignals(),
    ...detectIssueClusters(),
    ...detectSilentFailures(),
    ...detectStaleStatuses(),
    ...detectIncorrectHistory(),
  ].sort((a, b) => SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity]);
}

export function signalSummary(): Record<SignalSeverity, number> {
  const counts: Record<SignalSeverity, number> = { critical: 0, high: 0, medium: 0, low: 0 };
  for (const s of detectSignals()) counts[s.severity]++;
  return counts;
}
