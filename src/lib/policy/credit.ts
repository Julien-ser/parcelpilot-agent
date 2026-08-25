/**
 * Failed-pickup service credit engine.
 *
 * Governing sources, in precedence order:
 *   1. the account's signed agreement (may replace the delay threshold, the
 *      credit amount, or impose an aggregate cap)
 *   2. Cancellation & Service Credit SOP v4 s2/s3
 *
 * Careful parsing matters here. Northstar's agreement mentions "INR 5,000" as a
 * MONTHLY AGGREGATE CAP while LumenWorks' mentions "INR 300" as a FIXED CREDIT.
 * Reading the cap as the credit amount would overpay by 16x, so each figure is
 * matched by the phrase that qualifies it, never by proximity to "INR".
 */
import { contractChunks, findClause, toCitation, type Chunk } from "../corpus";
import { HOUR, formatIst, humanDuration, possessive } from "../time";
import type { Account, Order } from "../db";
import { decision, parseInr, type Decision, type RuleStep } from "./types";

export interface CreditOutcome {
  eligible: boolean;
  amount_inr: number | null;
  delay_hours: number | null;
  threshold_hours: number | null;
  /** Aggregate monthly ceiling from the agreement, if any. */
  monthly_cap_inr: number | null;
  requires_manager_approval: boolean;
}

export interface CreditInputs {
  /** Hours past the end of the scheduled pickup window. */
  delayHours: number | null;
  shipmentFeeInr: number | null;
  /** null means "not established" - the SOP forbids promising a credit then. */
  carrierFault: boolean | null;
  customerFault: boolean | null;
  orderId?: string;
}

interface SopParams {
  thresholdHours: number | null;
  capAmount: number | null;
  percent: number | null;
  approvalAbove: number | null;
  creditClause?: Chunk;
  approvalClause?: Chunk;
}

function sopParameters(): SopParams {
  const creditClause = findClause(/failed-pickup service credit/i);
  const approvalClause = findClause(/approval and uncertainty/i);
  const text = creditClause?.text ?? "";

  const thresholdMatch = text.match(/more than\s+(\d+)\s*hours?\s+past/i);
  const amountMatch = text.match(/lower of\s+INR\s*([\d,]+)\s*or\s*(\d+(?:\.\d+)?)\s*%/i);
  const approvalMatch = (approvalClause?.text ?? "").match(
    /credit above\s+INR\s*([\d,]+)\s*requires manager approval/i,
  );

  return {
    thresholdHours: thresholdMatch ? Number(thresholdMatch[1]) : null,
    capAmount: amountMatch ? Number(amountMatch[1].replace(/,/g, "")) : null,
    percent: amountMatch ? Number(amountMatch[2]) : null,
    approvalAbove: approvalMatch ? Number(approvalMatch[1].replace(/,/g, "")) : null,
    creditClause,
    approvalClause,
  };
}

interface ContractCreditTerms {
  thresholdHours: number | null;
  fixedAmount: number | null;
  monthlyCap: number | null;
  clause?: Chunk;
}

export function contractCreditTerms(accountId: string): ContractCreditTerms {
  const clause = contractChunks(accountId).find((c) => /credit/i.test(c.section));
  if (!clause) return { thresholdHours: null, fixedAmount: null, monthlyCap: null };
  const text = clause.text;

  const threshold = text.match(/more than\s+(\d+)\s*hours?\s+past/i);
  // "a fixed INR 300 service credit" - the word "fixed" is what makes it an amount.
  const fixed = text.match(/fixed\s+INR\s*([\d,]+)/i);
  // "capped at INR 5,000" - a ceiling, emphatically not the credit itself.
  const cap = text.match(/capped at\s+INR\s*([\d,]+)/i);

  return {
    thresholdHours: threshold ? Number(threshold[1]) : null,
    fixedAmount: fixed ? Number(fixed[1].replace(/,/g, "")) : null,
    monthlyCap: cap ? Number(cap[1].replace(/,/g, "")) : null,
    clause,
  };
}

export function evaluateCredit(
  inputs: CreditInputs,
  account: Account,
  _nowMs: number,
): Decision<CreditOutcome> {
  const trace: RuleStep[] = [];
  const sop = sopParameters();
  const sopCitation = sop.creditClause ? toCitation(sop.creditClause) : undefined;
  const approvalCitation = sop.approvalClause ? toCitation(sop.approvalClause) : undefined;

  const contract = contractCreditTerms(account.account_id);
  const contractCitation = contract.clause ? toCitation(contract.clause) : undefined;

  const citations = [contractCitation, sopCitation, approvalCitation].filter(Boolean) as never[];

  const base: CreditOutcome = {
    eligible: false,
    amount_inr: null,
    delay_hours: inputs.delayHours,
    threshold_hours: null,
    monthly_cap_inr: contract.monthlyCap,
    requires_manager_approval: false,
  };

  // --- Step 1: which delay threshold governs? -------------------------------
  const thresholdHours = contract.thresholdHours ?? sop.thresholdHours;
  base.threshold_hours = thresholdHours;

  if (contract.thresholdHours !== null && contractCitation) {
    trace.push({
      rule: "signed agreement - failed-pickup credits",
      outcome: `${possessive(account.account_name)} agreement sets the delay threshold at ${contract.thresholdHours} hours past the pickup window.`,
      citation: contractCitation,
      overrides: `SOP v4 s2 default threshold of ${sop.thresholdHours} hours`,
    });
  } else if (sopCitation) {
    trace.push({
      rule: "SOP v4 s2 - default threshold",
      outcome: `No agreement term replaces the threshold, so the default of ${sop.thresholdHours} hours past the pickup window applies.`,
      citation: sopCitation,
    });
  }

  // --- Step 2: the SOP forbids guessing about fault -------------------------
  if (inputs.carrierFault === null || inputs.customerFault === null) {
    trace.push({
      rule: "SOP v4 s3 - uncertainty",
      outcome:
        "Carrier fault or customer fault is not established. The SOP explicitly forbids promising a credit in this state.",
      citation: approvalCitation,
    });
    return decision<CreditOutcome>({
      determination: base,
      confidence: "needs_verification",
      trace,
      citations,
      unknowns: [
        {
          field: inputs.carrierFault === null ? "carrier_fault" : "customer_fault",
          why: "Not recorded on the order. The SOP requires verification before a credit is promised.",
        },
      ],
      summary:
        "I cannot confirm a service credit because fault has not been established. This needs a human to verify carrier and customer fault before anything is promised.",
    });
  }

  // --- Step 3: eligibility conditions ---------------------------------------
  const delayHours = inputs.delayHours;
  if (delayHours === null || thresholdHours === null) {
    return decision<CreditOutcome>({
      determination: base,
      confidence: "needs_verification",
      trace,
      citations,
      unknowns: [
        { field: "pickup delay", why: "The pickup window or actual pickup time is missing." },
      ],
      summary: "I cannot confirm a service credit without the pickup timing. Please verify.",
    });
  }

  const failures: string[] = [];
  if (delayHours <= thresholdHours) {
    failures.push(
      `the pickup was ${delayHours.toFixed(2)}h past the window, which does not exceed the ${thresholdHours}h threshold`,
    );
  }
  if (!inputs.carrierFault) failures.push("the carrier is not recorded as being at fault");
  if (inputs.customerFault) failures.push("the order is flagged as customer-caused");

  if (failures.length > 0) {
    trace.push({
      rule: "SOP v4 s2 - eligibility conditions",
      outcome: `Not eligible: ${failures.join("; ")}.`,
      citation: contract.thresholdHours !== null ? contractCitation : sopCitation,
    });
    return decision<CreditOutcome>({
      determination: base,
      trace,
      citations,
      summary: `No service credit applies${inputs.orderId ? ` to ${inputs.orderId}` : ""} because ${failures.join(", and ")}.`,
    });
  }

  // --- Step 4: amount -------------------------------------------------------
  let amount: number | null;
  if (contract.fixedAmount !== null && contractCitation) {
    amount = contract.fixedAmount;
    const wouldHaveBeen =
      sop.capAmount !== null && sop.percent !== null && inputs.shipmentFeeInr !== null
        ? Math.min(sop.capAmount, (sop.percent / 100) * inputs.shipmentFeeInr)
        : null;
    trace.push({
      rule: "signed agreement - fixed credit amount",
      outcome: `${possessive(account.account_name)} agreement sets a fixed credit of INR ${amount}.`,
      citation: contractCitation,
      overrides:
        wouldHaveBeen !== null
          ? `SOP v4 s2 default of INR ${wouldHaveBeen} (lower of INR ${sop.capAmount} or ${sop.percent}% of the INR ${inputs.shipmentFeeInr} shipment fee)`
          : `SOP v4 s2 default amount rule`,
    });
  } else if (sop.capAmount !== null && sop.percent !== null && inputs.shipmentFeeInr !== null) {
    const pct = (sop.percent / 100) * inputs.shipmentFeeInr;
    amount = Math.min(sop.capAmount, pct);
    trace.push({
      rule: "SOP v4 s2 - default credit amount",
      outcome: `Credit is the lower of INR ${sop.capAmount} or ${sop.percent}% of the INR ${inputs.shipmentFeeInr} shipment fee (INR ${pct}), giving INR ${amount}.`,
      citation: sopCitation,
    });
  } else {
    amount = null;
  }

  // --- Step 5: aggregate cap and approval ------------------------------------
  if (contract.monthlyCap !== null && contractCitation) {
    trace.push({
      rule: "signed agreement - monthly aggregate cap",
      outcome: `${possessive(account.account_name)} credits are capped at INR ${contract.monthlyCap} per month in aggregate. This single credit is within that ceiling, but the month-to-date total is not tracked in the supplied dataset and should be checked before issuing.`,
      citation: contractCitation,
    });
  }

  const needsApproval =
    amount !== null && sop.approvalAbove !== null && amount > sop.approvalAbove;
  if (needsApproval && approvalCitation) {
    trace.push({
      rule: "SOP v4 s3 - manager approval",
      outcome: `INR ${amount} exceeds the INR ${sop.approvalAbove} individual-credit threshold, so manager approval is required before issuing.`,
      citation: approvalCitation,
    });
  }

  return decision<CreditOutcome>({
    determination: {
      ...base,
      eligible: true,
      amount_inr: amount,
      requires_manager_approval: needsApproval,
    },
    trace,
    citations,
    conflicts:
      contract.fixedAmount !== null || contract.thresholdHours !== null
        ? [
            {
              kind: "contract_overrides_policy",
              summary: `${possessive(account.account_name)} agreement replaces the SOP's default failed-pickup credit terms.`,
              winner: contractCitation,
              loser: sopCitation,
            },
          ]
        : [],
    requiresApproval: needsApproval
      ? {
          reason: "Individual credit exceeds the SOP manager-approval threshold.",
          threshold: `INR ${sop.approvalAbove}`,
        }
      : undefined,
    summary:
      `A service credit of INR ${amount} applies${inputs.orderId ? ` to ${inputs.orderId}` : ""}: ` +
      `the pickup was ${delayHours.toFixed(2)}h past the window (threshold ${thresholdHours}h), ` +
      `the carrier is at fault and there is no customer-caused issue.` +
      (needsApproval ? " Manager approval is required before issuing." : ""),
  });
}

/** Build credit inputs from an order, using the snapshot when pickup never happened. */
export function creditInputsFromOrder(order: Order, nowMs: number): CreditInputs {
  const windowEnd = order.pickup_window_end
    ? Date.parse(`${order.pickup_window_end.replace(" ", "T")}Z`)
    : null;
  const actual = order.pickup_actual_at
    ? Date.parse(`${order.pickup_actual_at.replace(" ", "T")}Z`)
    : null;

  // If the parcel was never collected, the delay is still accruing at snapshot time.
  const reference = actual ?? nowMs;
  const delayHours =
    windowEnd !== null ? Math.max(0, (reference - windowEnd) / HOUR) : null;

  return {
    delayHours,
    shipmentFeeInr: order.shipment_fee_inr,
    carrierFault: order.carrier_fault,
    customerFault: order.customer_fault,
    orderId: order.order_id,
  };
}

export { formatIst, humanDuration };
