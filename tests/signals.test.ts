import { describe, expect, it } from "vitest";
import { detectSignals, knownIssues, matchKnownIssue } from "@/lib/signals";
import { TICKETS } from "@/lib/db";

const signals = detectSignals();
const byId = (id: string) => signals.find((s) => s.id === id);

describe("known issues parsed from the product guide", () => {
  it("finds the open issues and marks the resolved one resolved", () => {
    const issues = knownIssues();
    const ids = issues.map((i) => i.id).sort();
    expect(ids).toEqual(["KI-176", "KI-208", "KI-211"]);
    expect(issues.find((i) => i.id === "KI-176")!.resolved).toBe(true);
    expect(issues.find((i) => i.id === "KI-208")!.status).toBe("Investigating");
    expect(issues.find((i) => i.id === "KI-211")!.status).toBe("Monitoring");
  });

  it("never matches a new incident to the resolved KI-176", () => {
    for (const t of TICKETS) {
      expect(matchKnownIssue(t)?.id).not.toBe("KI-176");
    }
  });

  it("matches the bulk-upload ticket to KI-208", () => {
    const t = TICKETS.find((x) => x.ticket_id === "TKT-502")!;
    expect(matchKnownIssue(t)?.id).toBe("KI-208");
  });

  it("matches the SwiftShip webhook ticket to KI-211", () => {
    const t = TICKETS.find((x) => x.ticket_id === "TKT-504")!;
    expect(matchKnownIssue(t)?.id).toBe("KI-211");
  });

  it("does NOT match the total-outage ticket to the bulk-upload issue", () => {
    // TKT-501 and KI-208 share the word "shipment" and nothing that matters.
    const t = TICKETS.find((x) => x.ticket_id === "TKT-501")!;
    expect(matchKnownIssue(t)).toBeNull();
  });

  it("does NOT match a cancellation question to the webhook issue", () => {
    // TKT-450 mentions "pickup" only incidentally.
    const t = TICKETS.find((x) => x.ticket_id === "TKT-450")!;
    expect(matchKnownIssue(t)).toBeNull();
  });
});

describe("SLA and security signals", () => {
  it("flags both breached P1s as critical", () => {
    expect(byId("sla-TKT-501")?.severity).toBe("critical");
    expect(byId("sla-TKT-505")?.severity).toBe("critical");
  });

  it("flags the credential exposure separately as a security signal", () => {
    expect(byId("sec-TKT-505")?.kind).toBe("security");
  });

  it("does not flag tickets that are within target", () => {
    expect(byId("sla-TKT-502")).toBeUndefined();
    expect(byId("sla-TKT-503")).toBeUndefined();
  });
});

describe("proactive operational signals", () => {
  it("surfaces the credit-eligible order that nobody has complained about", () => {
    const s = byId("silent-ORD-2002");
    expect(s).toBeDefined();
    expect(s!.kind).toBe("silent_failure");
    expect(s!.accounts).toEqual(["ACCT-002"]);
  });

  it("flags the long-stale BOOKED order", () => {
    expect(byId("stale-ORD-2002")?.kind).toBe("stale_status");
  });

  it("does NOT flag a recent BOOKED order inside the KI-211 webhook delay window", () => {
    // ORD-1001's pickup window has not even closed at the snapshot.
    expect(byId("stale-ORD-1001")).toBeUndefined();
  });

  it("clusters the repeat bulk-upload reports", () => {
    const s = signals.find((x) => x.id === "cluster-KI-208");
    expect(s).toBeDefined();
    expect(s!.evidence).toEqual(expect.arrayContaining(["TKT-502", "TKT-451"]));
  });
});

describe("incorrect historical guidance", () => {
  it("catches the cancellation fee wrongly quoted to Northstar in TKT-450", () => {
    const s = byId("hist-TKT-450");
    expect(s).toBeDefined();
    expect(s!.kind).toBe("incorrect_history");
    expect(s!.detail).toMatch(/waives the cancellation fee/i);
  });

  it("catches the 3,000-row limit wrongly quoted as a plan capability in TKT-451", () => {
    const s = byId("hist-rows-TKT-451");
    expect(s).toBeDefined();
    expect(s!.detail).toMatch(/5,000 rows/);
    expect(s!.detail).toMatch(/workaround/i);
  });
});

describe("ranking", () => {
  it("puts critical signals first", () => {
    expect(signals[0].severity).toBe("critical");
  });
});
