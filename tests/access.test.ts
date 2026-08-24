/**
 * Access control is a data-layer property, so it is tested at the data layer.
 *
 * These tests deliberately call the accessors the way a *compromised or
 * jailbroken model* would: asking directly for another account's records by id.
 * Passing them means no prompt injection can widen scope, because scope is not
 * something the model can express.
 */
import { describe, expect, it } from "vitest";
import {
  getAccount,
  getOrder,
  getTicket,
  listOrders,
  listTickets,
  visibleAccountIds,
  allTicketsForOps,
} from "@/lib/access";
import { getSession } from "@/lib/session";
import { visibleChunks, contractChunks } from "@/lib/corpus";
import { searchDocuments } from "@/lib/retrieval";
import { prepareAction, executeAction, decodeActionToken } from "@/lib/actions";

const northstar = getSession("northstar-ops"); // customer, ACCT-001
const lumenworks = getSession("lumenworks-ops"); // customer, ACCT-002
const agent = getSession("agent-maya"); // internal, no approval rights
const manager = getSession("manager-priya"); // internal, may approve credits

describe("account scoping", () => {
  it("limits a customer to their own account", () => {
    expect(visibleAccountIds(northstar)).toEqual(["ACCT-001"]);
    expect(visibleAccountIds(agent).length).toBeGreaterThan(1);
  });

  it("refuses another account's order even when asked for it by id", () => {
    const r = getOrder(northstar, "ORD-2001"); // LumenWorks' order
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("forbidden");
  });

  it("does not reveal which account owns a forbidden order", () => {
    const r = getOrder(northstar, "ORD-2001");
    if (!r.ok) {
      expect(r.message).not.toMatch(/ACCT-002/);
      expect(r.message).not.toMatch(/LumenWorks/i);
    }
  });

  it("refuses another account's ticket", () => {
    const r = getTicket(lumenworks, "TKT-501"); // Northstar's outage
    expect(r.ok).toBe(false);
  });

  it("never returns another account's rows in a list", () => {
    const r = listOrders(northstar);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value.every((o) => o.account_id === "ACCT-001")).toBe(true);
    }
  });

  it("refuses an explicit cross-account filter rather than silently ignoring it", () => {
    const r = listTickets(northstar, { accountId: "ACCT-002" });
    expect(r.ok).toBe(false);
  });

  it("lets internal staff read any account", () => {
    expect(getOrder(agent, "ORD-2001").ok).toBe(true);
    expect(getTicket(agent, "TKT-501").ok).toBe(true);
  });
});

describe("field-level redaction", () => {
  it("strips internal fields from a customer's view of their own ticket", () => {
    const r = getTicket(northstar, "TKT-450");
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect("historical_resolution" in r.value).toBe(false);
      expect("assigned_to" in r.value).toBe(false);
    }
  });

  it("keeps internal fields for staff", () => {
    const r = getTicket(agent, "TKT-450");
    if (r.ok) {
      expect("historical_resolution" in r.value).toBe(true);
    }
  });

  it("hides internal account notes from customers", () => {
    const r = getAccount(northstar, "ACCT-001");
    if (r.ok) expect("notes" in r.value).toBe(false);
  });
});

describe("document scoping", () => {
  it("never surfaces another customer's agreement to a customer", () => {
    const chunks = visibleChunks(lumenworks);
    expect(chunks.some((c) => c.account_scope === "ACCT-001")).toBe(false);
    expect(chunks.some((c) => c.account_scope === "ACCT-002")).toBe(true);
  });

  it("excludes deprecated policy from retrieval by default", () => {
    const hits = searchDocuments(agent, "enterprise P1 response target");
    expect(hits.every((h) => h.citation.status !== "DEPRECATED")).toBe(true);
  });

  it("returns deprecated policy only on explicit opt-in, and warns", () => {
    const hits = searchDocuments(agent, "support policy v2 response targets", {
      includeDeprecated: true,
    });
    const deprecated = hits.find((h) => h.citation.status === "DEPRECATED");
    expect(deprecated).toBeDefined();
    expect(deprecated!.warning).toMatch(/must not be used as current policy/i);
  });

  it("cannot leak Northstar's terms into a LumenWorks search", () => {
    const hits = searchDocuments(lumenworks, "cancellation fee waiver no fee regardless");
    expect(hits.every((h) => h.citation.account_scope !== "ACCT-001")).toBe(true);
  });

  it("still exposes shared policy documents to every customer", () => {
    const hits = searchDocuments(northstar, "cancellation fee booked pickup");
    expect(hits.length).toBeGreaterThan(0);
  });
});

describe("ops surface", () => {
  it("throws if the unfiltered ops read is attempted without the capability", () => {
    expect(() => allTicketsForOps(northstar)).toThrow();
    expect(() => allTicketsForOps(agent)).not.toThrow();
  });
});

describe("action confirmation gate", () => {
  const proposal = () =>
    prepareAction(agent, {
      type: "create_escalation",
      subject_id: "TKT-501",
      account_id: "ACCT-001",
      summary: "Escalate breached P1",
      justification: "First-response target breached by 15 minutes.",
      changes: { priority: "P1", page_on_call: true },
    });

  it("prepare_action changes nothing and returns a signed token", () => {
    const p = proposal();
    expect("action_token" in p && p.status === "awaiting_confirmation").toBe(true);
    if ("action_token" in p) {
      expect(decodeActionToken(p.action_token)).not.toBeNull();
    }
  });

  it("REFUSES execution when the user has not confirmed", () => {
    const p = proposal();
    if (!("action_token" in p)) throw new Error("expected a proposal");
    const r = executeAction(agent, p.action_token, false);
    expect(r.status).toBe("refused");
  });

  it("executes only once the user has confirmed", () => {
    const p = proposal();
    if (!("action_token" in p)) throw new Error("expected a proposal");
    const r = executeAction(agent, p.action_token, true);
    expect(r.status).toBe("executed");
    if (r.status === "executed") expect(r.reference).toMatch(/^ESC-/);
  });

  it("rejects a tampered token", () => {
    const p = proposal();
    if (!("action_token" in p)) throw new Error("expected a proposal");
    const [body, sig] = p.action_token.split(".");
    const tampered = `${body}x.${sig}`;
    expect(executeAction(agent, tampered, true).status).toBe("refused");
  });

  it("refuses to prepare an action on another account's ticket", () => {
    const r = prepareAction(lumenworks, {
      type: "create_escalation",
      subject_id: "TKT-501",
      account_id: "ACCT-001",
      summary: "escalate",
      justification: "n/a",
      changes: {},
    });
    expect("ok" in r && r.ok === false).toBe(true);
  });

  it("blocks a customer from issuing a service credit", () => {
    const r = prepareAction(northstar, {
      type: "issue_service_credit",
      subject_id: "ORD-1001",
      account_id: "ACCT-001",
      summary: "credit",
      justification: "n/a",
      changes: { amount_inr: 300, requires_manager_approval: false },
    });
    expect("status" in r && r.status === "refused").toBe(true);
  });

  it("blocks an agent from approving a credit above the SOP threshold", () => {
    const r = prepareAction(agent, {
      type: "issue_service_credit",
      subject_id: "ORD-2002",
      account_id: "ACCT-002",
      summary: "large credit",
      justification: "n/a",
      changes: { amount_inr: 2500, requires_manager_approval: true },
    });
    expect("status" in r && r.status === "refused").toBe(true);
  });

  it("allows a manager to approve the same credit", () => {
    const r = prepareAction(manager, {
      type: "issue_service_credit",
      subject_id: "ORD-2002",
      account_id: "ACCT-002",
      summary: "large credit",
      justification: "Carrier fault, 4.5h delay.",
      changes: { amount_inr: 2500, requires_manager_approval: true },
    });
    expect("status" in r && r.status === "awaiting_confirmation").toBe(true);
  });
});

describe("contract chunk helper", () => {
  it("returns only that account's clauses", () => {
    expect(contractChunks("ACCT-001").every((c) => c.account_scope === "ACCT-001")).toBe(true);
    expect(contractChunks("ACCT-003")).toHaveLength(0); // no agreement in the pack
  });
});
