import { describe, expect, it } from "vitest";
import {
  contractTargets,
  noWeekendCoverage,
  parseDuration,
  policyTargets,
  resolveTarget,
} from "@/lib/policy/targets";
import { SNAPSHOT_MS, SNAPSHOT_LABEL } from "@/lib/db";
import { formatIst, isWeekend } from "@/lib/time";

describe("duration parsing", () => {
  it("treats an explicit 24x7 marker as wall-clock", () => {
    expect(parseDuration("15 minutes, 24x7")).toMatchObject({
      value: 15,
      unit: "minutes",
      clock: "wall",
    });
  });

  it("treats an unqualified hour target as wall-clock", () => {
    expect(parseDuration("2 hours")).toMatchObject({ value: 2, unit: "hours", clock: "wall" });
  });

  it("distinguishes business hours from business days", () => {
    expect(parseDuration("8 business hours")).toMatchObject({ clock: "business_hours", value: 8 });
    expect(parseDuration("2 business days")).toMatchObject({ clock: "business_days", value: 2 });
  });
});

describe("policy target table (Support Policy v3 s3)", () => {
  it("parses the Enterprise row", () => {
    const t = policyTargets("Enterprise");
    expect(t.map((x) => x.raw)).toEqual(["30 minutes, 24x7", "2 hours", "1 business day"]);
    expect(t[0].clock).toBe("wall");
    expect(t[2].clock).toBe("business_days");
  });

  it("parses the Growth row", () => {
    expect(policyTargets("Growth").map((x) => x.raw)).toEqual([
      "2 business hours",
      "4 business hours",
      "2 business days",
    ]);
  });

  it("parses the Standard row", () => {
    expect(policyTargets("Standard").map((x) => x.raw)).toEqual([
      "4 business hours",
      "1 business day",
      "2 business days",
    ]);
  });

  it("reads targets from the CURRENT policy, never the deprecated v2", () => {
    // v2 would give Enterprise P1 = "1 hour"; v3 gives 30 minutes.
    const p1 = policyTargets("Enterprise")[0];
    expect(p1.value).toBe(30);
    expect(p1.citation.status).toBe("CURRENT");
    expect(p1.citation.doc_title).toMatch(/v3/);
  });
});

describe("contract targets", () => {
  it("parses Northstar's negotiated targets", () => {
    expect(contractTargets("ACCT-001").map((x) => `${x.severity} ${x.raw}`)).toEqual([
      "P1 15 minutes, 24x7",
      "P2 1 hour",
      "P3 8 business hours",
    ]);
  });

  it("parses LumenWorks' negotiated targets", () => {
    expect(contractTargets("ACCT-002").map((x) => `${x.severity} ${x.raw}`)).toEqual([
      "P1 2 business hours",
      "P2 4 business hours",
      "P3 2 business days",
    ]);
  });

  it("detects LumenWorks' removal of weekend coverage", () => {
    expect(noWeekendCoverage("ACCT-002").yes).toBe(true);
    expect(noWeekendCoverage("ACCT-001").yes).toBe(false);
  });
});

describe("precedence", () => {
  it("prefers the signed agreement over the policy default", () => {
    const { target, displaced } = resolveTarget("ACCT-001", "Enterprise", "P1");
    expect(target?.source).toBe("contract");
    expect(target?.value).toBe(15);
    expect(displaced?.value).toBe(30); // the policy default it displaced
  });

  it("falls back to the plan default when no agreement exists", () => {
    // Axis Labs (ACCT-004) is Enterprise with no contract in the pack.
    const { target, displaced } = resolveTarget("ACCT-004", "Enterprise", "P1");
    expect(target?.source).toBe("policy");
    expect(target?.value).toBe(30);
    expect(displaced).toBeNull();
  });
});

describe("dataset snapshot", () => {
  it("is the Sunday stated in the README sheet", () => {
    expect(SNAPSHOT_LABEL).toBe("2026-08-16 11:00 Asia/Kolkata");
    expect(formatIst(SNAPSHOT_MS)).toBe("2026-08-16 11:00 IST");
    expect(isWeekend(SNAPSHOT_MS)).toBe(true);
  });
});
