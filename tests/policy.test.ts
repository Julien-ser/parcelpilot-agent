/**
 * Golden answers for the policy engine, derived by hand from the source
 * documents. These are the cases the data pack was built to catch people out
 * on, so they are asserted exactly - including the figures that a naive
 * implementation gets wrong.
 */
import { describe, expect, it } from "vitest";
import { ACCOUNTS, ORDERS, TICKETS, SNAPSHOT_MS, accountById } from "@/lib/db";
import { evaluateCancellation, contractWaivesFee } from "@/lib/policy/cancellation";
import { evaluateCredit, creditInputsFromOrder, contractCreditTerms } from "@/lib/policy/credit";
import { classifySeverity, evaluateSla } from "@/lib/policy/sla";

const order = (id: string) => ORDERS.find((o) => o.order_id === id)!;
const ticket = (id: string) => TICKETS.find((t) => t.ticket_id === id)!;
const acct = (id: string) => accountById(id)!;

describe("cancellation - contract overrides the SOP", () => {
  it("ORD-1001: Northstar cancels 120 minutes after booking with NO fee", () => {
    const o = order("ORD-1001");
    const d = evaluateCancellation(o, acct(o.account_id), SNAPSHOT_MS);

    expect(d.determination.cancellable).toBe(true);
    expect(d.determination.fee_inr).toBe(0);
    expect(d.determination.fee_waived_by_contract).toBe(true);
    // Well outside the SOP's 30-minute free window - the contract is why it is free.
    expect(d.determination.minutes_since_booking).toBe(120);
    expect(d.conflicts[0].kind).toBe("contract_overrides_policy");
    expect(d.trace.some((s) => /waives the cancellation fee/i.test(s.outcome))).toBe(true);
  });

  it("ORD-2001: LumenWorks cancels 75 minutes after booking and IS charged INR 250", () => {
    const o = order("ORD-2001");
    const d = evaluateCancellation(o, acct(o.account_id), SNAPSHOT_MS);

    expect(d.determination.cancellable).toBe(true);
    expect(d.determination.fee_inr).toBe(250);
    expect(d.determination.fee_waived_by_contract).toBe(false);
    expect(d.determination.minutes_since_booking).toBe(75);
  });

  it('reads "No special cancellation-fee waiver applies" as a denial, not a waiver', () => {
    expect(contractWaivesFee("ACCT-002").waived).toBe(false);
    expect(contractWaivesFee("ACCT-001").waived).toBe(true);
  });

  it("ORD-3001: Beacon Retail cancels inside the 30-minute window with no fee", () => {
    const o = order("ORD-3001");
    const d = evaluateCancellation(o, acct(o.account_id), SNAPSHOT_MS);
    expect(d.determination.fee_inr).toBe(0);
    expect(d.determination.minutes_since_booking).toBe(15);
    expect(d.determination.fee_waived_by_contract).toBe(false);
  });

  it("ORD-1002: a PICKED_UP order cannot be cancelled even for Northstar", () => {
    const o = order("ORD-1002");
    const d = evaluateCancellation(o, acct(o.account_id), SNAPSHOT_MS);
    expect(d.determination.cancellable).toBe(false);
    expect(d.determination.alternative_workflow).toBe("return-to-origin");
  });

  it("ORD-4001: a DELIVERED order cannot be cancelled", () => {
    const o = order("ORD-4001");
    const d = evaluateCancellation(o, acct(o.account_id), SNAPSHOT_MS);
    expect(d.determination.cancellable).toBe(false);
  });
});

describe("service credits - contract replaces threshold and amount", () => {
  it("ORD-2002: LumenWorks gets the contract's fixed INR 300, not the SOP's INR 240", () => {
    const o = order("ORD-2002");
    const d = evaluateCredit(creditInputsFromOrder(o, SNAPSHOT_MS), acct(o.account_id), SNAPSHOT_MS);

    expect(d.determination.eligible).toBe(true);
    expect(d.determination.amount_inr).toBe(300);
    expect(d.determination.threshold_hours).toBe(4);
    // The SOP default would have been min(500, 10% of 2400) = 240.
    expect(d.trace.some((s) => /INR 240/.test(s.overrides ?? ""))).toBe(true);
    expect(d.determination.requires_manager_approval).toBe(false);
  });

  it("does not mistake Northstar's INR 5,000 monthly CAP for a credit amount", () => {
    const terms = contractCreditTerms("ACCT-001");
    expect(terms.monthlyCap).toBe(5000);
    expect(terms.fixedAmount).toBeNull();
    expect(terms.thresholdHours).toBeNull();
  });

  it("a 3-hour carrier-fault delay IS eligible under the default SOP", () => {
    // Axis Labs has no agreement, so the SOP's 2-hour threshold governs.
    const d = evaluateCredit(
      { delayHours: 3, shipmentFeeInr: 3600, carrierFault: true, customerFault: false },
      acct("ACCT-004"),
      SNAPSHOT_MS,
    );
    expect(d.determination.eligible).toBe(true);
    expect(d.determination.threshold_hours).toBe(2);
    expect(d.determination.amount_inr).toBe(360); // min(500, 10% of 3600)
  });

  it("the same 3-hour delay is NOT eligible for LumenWorks, whose threshold is 4h", () => {
    const d = evaluateCredit(
      { delayHours: 3, shipmentFeeInr: 1800, carrierFault: true, customerFault: false },
      acct("ACCT-002"),
      SNAPSHOT_MS,
    );
    expect(d.determination.eligible).toBe(false);
    expect(d.determination.threshold_hours).toBe(4);
  });

  it("caps the default credit at INR 500 for an expensive shipment", () => {
    const d = evaluateCredit(
      { delayHours: 9, shipmentFeeInr: 20000, carrierFault: true, customerFault: false },
      acct("ACCT-004"),
      SNAPSHOT_MS,
    );
    expect(d.determination.amount_inr).toBe(500); // 10% would be 2000
    expect(d.determination.requires_manager_approval).toBe(false); // 500 < 1000
  });

  it("refuses to promise a credit when fault is not established", () => {
    const d = evaluateCredit(
      { delayHours: 6, shipmentFeeInr: 3000, carrierFault: null, customerFault: false },
      acct("ACCT-004"),
      SNAPSHOT_MS,
    );
    expect(d.determination.eligible).toBe(false);
    expect(d.confidence).toBe("needs_verification");
    expect(d.unknowns[0].field).toBe("carrier_fault");
  });

  it("refuses a credit when the customer is at fault", () => {
    const d = evaluateCredit(
      { delayHours: 6, shipmentFeeInr: 3000, carrierFault: true, customerFault: true },
      acct("ACCT-004"),
      SNAPSHOT_MS,
    );
    expect(d.determination.eligible).toBe(false);
  });
});

describe("severity classification (Support Policy v3 s2)", () => {
  const cases: [string, string][] = [
    ["TKT-501", "P1"], // every user gets HTTP 500 on shipment creation
    ["TKT-505", "P1"], // production API key exposed
    ["TKT-502", "P2"], // bulk upload fails, one-by-one still works
    ["TKT-503", "P3"], // how do we change the billing contact
  ];

  for (const [id, expected] of cases) {
    it(`${id} classifies as ${expected}`, () => {
      const t = ticket(id);
      expect(classifySeverity(`${t.subject} ${t.description}`).severity).toBe(expected);
    });
  }
});

describe("SLA breach - the snapshot is a Sunday", () => {
  it("TKT-501: Northstar P1 on a 24x7 contract clock is breached by 15 minutes", () => {
    const t = ticket("TKT-501");
    const d = evaluateSla(t, acct(t.account_id), SNAPSHOT_MS);

    expect(d.determination.severity).toBe("P1");
    expect(d.determination.target_source).toBe("contract");
    expect(d.determination.target).toBe("15 minutes, 24x7 (24x7)");
    expect(d.determination.breached).toBe(true);
    expect(d.determination.overdue_by).toBe("15m");
    // Under the DEPRECATED v2 policy (Enterprise P1 = 1 hour) this would not be breached.
  });

  it("TKT-505: Axis Labs P1 falls back to the v3 Enterprise default and is badly breached", () => {
    const t = ticket("TKT-505");
    const d = evaluateSla(t, acct(t.account_id), SNAPSHOT_MS);

    expect(d.determination.severity).toBe("P1");
    expect(d.determination.target_source).toBe("policy");
    expect(d.determination.target).toBe("30 minutes, 24x7 (24x7)");
    expect(d.determination.breached).toBe(true);
    expect(d.determination.overdue_by).toBe("2h"); // created 08:30, due 09:00, snapshot 11:00
  });

  it("TKT-502: LumenWorks P2 clock is paused - no weekend coverage on a Sunday", () => {
    const t = ticket("TKT-502");
    const d = evaluateSla(t, acct(t.account_id), SNAPSHOT_MS);

    expect(d.determination.severity).toBe("P2");
    expect(d.determination.target_source).toBe("contract");
    expect(d.determination.clock).toBe("business_hours");
    // Zero business time has elapsed because the snapshot is a Sunday.
    expect(d.determination.elapsed).toBe("0m");
    expect(d.determination.breached).toBe(false);
    expect(d.trace.some((s) => /weekend/i.test(s.outcome))).toBe(true);
    // Due date lands on the next working day, not Sunday.
    expect(d.determination.due_at).toMatch(/2026-08-17/);
  });

  it("TKT-503: Beacon Retail P3 on the Standard plan default", () => {
    const t = ticket("TKT-503");
    const d = evaluateSla(t, acct(t.account_id), SNAPSHOT_MS);
    expect(d.determination.severity).toBe("P3");
    expect(d.determination.target_source).toBe("policy");
    expect(d.determination.target).toBe("2 business days");
    expect(d.determination.breached).toBe(false);
  });

  it("reports targets for all three severities so a misclassification is visible", () => {
    const t = ticket("TKT-501");
    const d = evaluateSla(t, acct(t.account_id), SNAPSHOT_MS);
    expect(d.determination.all_targets).toEqual({
      P1: "15 minutes, 24x7 (24x7)",
      P2: "1 hour (wall clock)",
      P3: "8 business hours",
    });
  });
});

describe("dataset sanity", () => {
  it("has the four accounts the documents refer to", () => {
    expect(ACCOUNTS.map((a) => a.account_id)).toEqual([
      "ACCT-001",
      "ACCT-002",
      "ACCT-003",
      "ACCT-004",
    ]);
  });
});
