/**
 * Cancellation engine.
 *
 * Governing sources, in precedence order:
 *   1. the account's signed agreement (may waive the fee outright)
 *   2. Cancellation & Service Credit SOP v4 s1 (status rules + free window + fee)
 *
 * The fee amount and the free window are read out of the SOP text rather than
 * written into code, so re-issuing the SOP with different numbers changes the
 * answer without a deploy.
 */
import { contractChunks, findClause, toCitation, type Chunk } from "../corpus";
import { MINUTE, formatIst, humanDuration } from "../time";
import type { Account, Order } from "../db";
import { decision, parseInr, type Decision, type RuleStep } from "./types";

export interface CancellationOutcome {
  cancellable: boolean;
  fee_inr: number | null;
  /** Present when the parcel is already collected. */
  alternative_workflow?: string;
  order_status: string;
  minutes_since_booking: number | null;
  fee_waived_by_contract: boolean;
}

const SOP_CANCELLATION = /order cancellation/i;

/** Read "no fee within 30 minutes" and "INR 250" out of the SOP clause. */
function sopParameters(clause: Chunk | undefined) {
  const text = clause?.text ?? "";
  const windowMatch = text.match(/no fee within\s+(\d+)\s*minutes?/i);
  const freeWindowMinutes = windowMatch ? Number(windowMatch[1]) : null;
  const fee = parseInr(text, /after\s+\d+\s*minutes?,\s*charge\s*INR\s*[\d,]+/i);
  return { freeWindowMinutes, fee };
}

/**
 * Does this account's agreement waive the cancellation fee?
 *
 * Both supplied agreements mention the phrase "cancellation fee", and one of
 * them mentions it only to DENY a waiver ("No special cancellation-fee waiver
 * applies"). Negations are therefore checked first; a naive substring match on
 * "no cancellation fee" gets LumenWorks exactly backwards.
 */
export function contractWaivesFee(accountId: string): { waived: boolean; clause?: Chunk } {
  const clause = contractChunks(accountId).find((c) => /cancellation/i.test(c.section));
  if (!clause) return { waived: false };

  const text = clause.text;
  const deniesWaiver =
    /no special[^.]*waiver/i.test(text) ||
    /\bno waiver\b/i.test(text) ||
    /use the current[^.]*SOP/i.test(text);
  if (deniesWaiver) return { waived: false, clause };

  const grantsWaiver =
    /with no cancellation fee/i.test(text) ||
    /without[^.]*cancellation fee/i.test(text) ||
    /cancellation fee[^.]*waived/i.test(text);

  return { waived: grantsWaiver, clause };
}

export function evaluateCancellation(
  order: Order,
  account: Account,
  nowMs: number,
): Decision<CancellationOutcome> {
  const trace: RuleStep[] = [];
  const sopClause = findClause(SOP_CANCELLATION);
  const { freeWindowMinutes, fee: sopFee } = sopParameters(sopClause);
  const sopCitation = sopClause ? toCitation(sopClause) : undefined;

  const status = String(order.status).toUpperCase();
  const bookedAt = order.booked_at;
  const requestedAt = order.cancellation_requested_at;

  const base = {
    order_status: status,
    minutes_since_booking: null as number | null,
    fee_waived_by_contract: false,
  };

  // --- Terminal statuses: decided by the SOP regardless of contract ---------
  if (status === "DELIVERED") {
    trace.push({
      rule: "SOP v4 s1 - order status",
      outcome: "DELIVERED shipments cannot be cancelled.",
      citation: sopCitation,
    });
    return decision<CancellationOutcome>({
      determination: { ...base, cancellable: false, fee_inr: null },
      trace,
      citations: sopCitation ? [sopCitation] : [],
      summary: `${order.order_id} has already been delivered and cannot be cancelled.`,
    });
  }

  if (status === "PICKED_UP") {
    trace.push({
      rule: "SOP v4 s1 - order status",
      outcome:
        "PICKED_UP shipments must not be cancelled; the return-to-origin workflow applies instead.",
      citation: sopCitation,
    });
    return decision<CancellationOutcome>({
      determination: {
        ...base,
        cancellable: false,
        fee_inr: null,
        alternative_workflow: "return-to-origin",
      },
      trace,
      citations: sopCitation ? [sopCitation] : [],
      summary: `${order.order_id} has already been picked up, so it cannot be cancelled. The return-to-origin workflow is the correct route if the parcel needs to come back.`,
    });
  }

  if (status === "DRAFT") {
    trace.push({
      rule: "SOP v4 s1 - order status",
      outcome: "DRAFT orders may be cancelled with no fee.",
      citation: sopCitation,
    });
    return decision<CancellationOutcome>({
      determination: { ...base, cancellable: true, fee_inr: 0 },
      trace,
      citations: sopCitation ? [sopCitation] : [],
      summary: `${order.order_id} is still a draft and can be cancelled at no charge.`,
    });
  }

  // --- BOOKED, not yet picked up -------------------------------------------
  const bookedMs = bookedAt ? Date.parse(`${bookedAt.replace(" ", "T")}Z`) : null;
  const requestedMs = requestedAt ? Date.parse(`${requestedAt.replace(" ", "T")}Z`) : null;
  const referenceMs = requestedMs ?? nowMs;
  const elapsedMs = bookedMs !== null ? referenceMs - bookedMs : null;
  const elapsedMinutes = elapsedMs !== null ? Math.round(elapsedMs / MINUTE) : null;

  trace.push({
    rule: "SOP v4 s1 - order status",
    outcome: `Status is ${status} and the parcel has not been picked up, so cancellation is permitted. Fee depends on timing and contract terms.`,
    citation: sopCitation,
  });

  // Precedence step 1: does a signed agreement displace the fee rule?
  const { waived, clause: contractClause } = contractWaivesFee(account.account_id);
  const contractCitation = contractClause ? toCitation(contractClause) : undefined;

  if (waived && contractCitation) {
    trace.push({
      rule: "signed agreement - cancellation terms",
      outcome: `${account.account_name}'s agreement waives the cancellation fee for any BOOKED shipment before pickup, regardless of elapsed time.`,
      citation: contractCitation,
      overrides: `SOP v4 s1 default fee of INR ${sopFee ?? "?"} after ${freeWindowMinutes ?? "?"} minutes`,
    });
    return decision<CancellationOutcome>({
      determination: {
        ...base,
        cancellable: true,
        fee_inr: 0,
        minutes_since_booking: elapsedMinutes,
        fee_waived_by_contract: true,
      },
      trace,
      citations: [contractCitation, ...(sopCitation ? [sopCitation] : [])],
      conflicts: [
        {
          kind: "contract_overrides_policy",
          summary: `The SOP default would charge INR ${sopFee ?? "?"} after ${freeWindowMinutes ?? "?"} minutes, but ${account.account_name}'s signed agreement waives it.`,
          winner: contractCitation,
          loser: sopCitation,
        },
      ],
      summary:
        `${order.order_id} can be cancelled with no cancellation fee` +
        (elapsedMinutes !== null ? ` even though it was booked ${humanDuration(elapsedMs!)} ago` : "") +
        `, because ${account.account_name}'s agreement waives the fee before pickup.`,
    });
  }

  if (contractClause && contractCitation) {
    trace.push({
      rule: "signed agreement - cancellation terms",
      outcome: `${account.account_name}'s agreement does not waive the cancellation fee; the current SOP applies.`,
      citation: contractCitation,
    });
  }

  // Precedence step 2: the SOP's timing rule.
  if (elapsedMinutes === null || freeWindowMinutes === null) {
    return decision<CancellationOutcome>({
      determination: {
        ...base,
        cancellable: true,
        fee_inr: null,
        minutes_since_booking: elapsedMinutes,
      },
      confidence: "needs_verification",
      trace,
      citations: [sopCitation, contractCitation].filter(Boolean) as never[],
      unknowns: [
        {
          field: "booking time",
          why: "The booking timestamp or the SOP free-cancellation window could not be determined, so the fee cannot be stated with confidence.",
        },
      ],
      summary: `${order.order_id} appears cancellable, but the fee cannot be confirmed without the booking time. Please verify before promising an outcome.`,
    });
  }

  const withinFreeWindow = elapsedMinutes <= freeWindowMinutes;
  const fee = withinFreeWindow ? 0 : (sopFee ?? null);

  trace.push({
    rule: "SOP v4 s1 - free cancellation window",
    outcome: withinFreeWindow
      ? `Cancellation was requested ${elapsedMinutes} minutes after booking, within the ${freeWindowMinutes}-minute free window, so no fee applies.`
      : `Cancellation was requested ${elapsedMinutes} minutes after booking, beyond the ${freeWindowMinutes}-minute free window, so INR ${sopFee} applies.`,
    citation: sopCitation,
  });

  const when = requestedMs ? ` (requested ${formatIst(requestedMs)})` : "";
  return decision<CancellationOutcome>({
    determination: {
      ...base,
      cancellable: true,
      fee_inr: fee,
      minutes_since_booking: elapsedMinutes,
    },
    trace,
    citations: [sopCitation, contractCitation].filter(Boolean) as never[],
    summary: withinFreeWindow
      ? `${order.order_id} can be cancelled with no fee - the request came ${elapsedMinutes} minutes after booking, inside the ${freeWindowMinutes}-minute free window${when}.`
      : `${order.order_id} can be cancelled, but a fee of INR ${sopFee} applies because the request came ${elapsedMinutes} minutes after booking${when}.`,
  });
}
