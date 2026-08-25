/**
 * The agent's tools.
 *
 * Every tool is built by a factory that closes over the caller's Session. The
 * model cannot pass an account id to widen its own scope, because scope is not a
 * parameter - it is bound at construction from the authenticated session.
 *
 * Tool results deliberately include the policy engine's `trace` and `citations`.
 * The model's job is to narrate a decision that code already made, not to make
 * the decision itself.
 */
import { tool } from "ai";
import { z } from "zod";
import {
  getAccount,
  getOrder,
  getTicket,
  listOrders,
  listTickets,
  type Result,
} from "./access";
import { SNAPSHOT_LABEL, SNAPSHOT_MS, accountById, type Account } from "./db";
import { searchDocuments } from "./retrieval";
import { capabilities, type Session } from "./session";
import { detectSignals } from "./signals";
import { evaluateCancellation } from "./policy/cancellation";
import { creditInputsFromOrder, evaluateCredit } from "./policy/credit";
import { evaluateSla } from "./policy/sla";
import { executeAction, prepareAction, type ActionType } from "./actions";

/** Unwrap a Result into something the model can read, preserving refusals. */
function unwrap<T>(r: Result<T>): T | { error: string; reason: string } {
  return r.ok ? r.value : { error: r.message, reason: r.reason };
}

function accountFor(id: string): Account | undefined {
  return accountById(id);
}

export function buildTools(session: Session, confirmedTokens: Set<string>) {
  const caps = capabilities(session);

  const base = {
    search_documents: tool({
      description:
        "Search ParcelPilot's policies, SOPs, product documentation and customer agreements. " +
        "Returns passages ranked with signed customer agreements above general policy. " +
        "Deprecated documents are excluded unless explicitly requested. " +
        "Use this for any question about rules, entitlements, severity definitions or known issues.",
      inputSchema: z.object({
        query: z.string().describe("What to look for, in natural language."),
        include_deprecated: z
          .boolean()
          .optional()
          .describe(
            "Only set true when the user explicitly asks what a superseded policy used to say.",
          ),
        limit: z.number().int().min(1).max(8).optional(),
      }),
      execute: async ({ query, include_deprecated, limit }) => {
        const hits = searchDocuments(session, query, {
          includeDeprecated: include_deprecated ?? false,
          limit: limit ?? 4,
        });
        return {
          snapshot: SNAPSHOT_LABEL,
          results: hits,
          note:
            hits.length === 0
              ? "No passage matched. Do not guess - say what is missing and offer to escalate."
              : "Sources are ranked by authority: signed agreement > current policy/SOP > product docs.",
        };
      },
    }),

    get_order: tool({
      description:
        "Look up one order by id (e.g. ORD-1001): status, carrier, pickup window, actual pickup, " +
        "shipment fee, fault flags and cancellation request time.",
      inputSchema: z.object({ order_id: z.string() }),
      execute: async ({ order_id }) => unwrap(getOrder(session, order_id)),
    }),

    get_ticket: tool({
      description:
        "Look up one support ticket by id (e.g. TKT-501). Historical resolutions on closed tickets " +
        "may be WRONG and are context only, never authority.",
      inputSchema: z.object({ ticket_id: z.string() }),
      execute: async ({ ticket_id }) => unwrap(getTicket(session, ticket_id)),
    }),

    get_account: tool({
      description:
        "Look up an account by id or name (e.g. ACCT-001 or 'Northstar') to get its plan, status " +
        "and whether it has a signed agreement on file.",
      inputSchema: z.object({ account: z.string() }),
      execute: async ({ account }) => unwrap(getAccount(session, account)),
    }),

    list_records: tool({
      description:
        "List orders or tickets visible to the current user, optionally filtered by account or status. " +
        "Use when the user asks 'what are my open tickets' or needs to find an id.",
      inputSchema: z.object({
        kind: z.enum(["orders", "tickets"]),
        account: z.string().optional().describe("Account id; omit for everything in scope."),
        status: z.string().optional(),
      }),
      execute: async ({ kind, account, status }) => {
        const filter = { accountId: account, status };
        return kind === "orders"
          ? unwrap(listOrders(session, filter))
          : unwrap(listTickets(session, filter));
      },
    }),

    evaluate_cancellation: tool({
      description:
        "Decide whether an order can be cancelled and what fee applies. This performs the full " +
        "precedence calculation (signed agreement over SOP) and returns a rule trace. " +
        "ALWAYS use this instead of reasoning about cancellation fees yourself.",
      inputSchema: z.object({ order_id: z.string() }),
      execute: async ({ order_id }) => {
        const r = getOrder(session, order_id);
        if (!r.ok) return { error: r.message, reason: r.reason };
        const account = accountFor(r.value.account_id);
        if (!account) return { error: `Account ${r.value.account_id} not found.` };
        return evaluateCancellation(r.value, account, SNAPSHOT_MS);
      },
    }),

    evaluate_service_credit: tool({
      description:
        "Decide whether a failed-pickup service credit applies and how much. Pass an order_id for a " +
        "real order, or the hypothetical fields for a 'what if' question such as 'a pickup was 3 hours " +
        "late, do I get a credit?'. Returns a rule trace showing which threshold and amount governed. " +
        "ALWAYS use this instead of calculating a credit yourself. " +
        "IMPORTANT: pass every fact the user has already stated. If they say the delay was three " +
        "hours and the carrier was at fault, pass delay_hours: 3 and carrier_fault: true. Dropping a " +
        "stated fact makes this tool report it as unestablished and refuse to answer.",
      inputSchema: z.object({
        order_id: z.string().optional(),
        account: z
          .string()
          .optional()
          .describe("Required for hypotheticals: whose terms should apply."),
        delay_hours: z.number().optional().describe("Hours past the END of the pickup window."),
        shipment_fee_inr: z.number().optional(),
        carrier_fault: z
          .boolean()
          .optional()
          .describe(
            "True when the user or the record says the carrier was at fault. Omit ONLY when fault " +
              "is genuinely unestablished; the SOP then forbids promising a credit.",
          ),
        customer_fault: z
          .boolean()
          .optional()
          .describe(
            "False when nothing suggests the customer caused the delay. Omit only when genuinely unknown.",
          ),
      }),
      execute: async (args) => {
        if (args.order_id) {
          const r = getOrder(session, args.order_id);
          if (!r.ok) return { error: r.message, reason: r.reason };
          const account = accountFor(r.value.account_id);
          if (!account) return { error: `Account ${r.value.account_id} not found.` };
          return evaluateCredit(creditInputsFromOrder(r.value, SNAPSHOT_MS), account, SNAPSHOT_MS);
        }

        const target = args.account ?? session.accountId;
        if (!target) {
          return {
            error:
              "Specify which account's terms apply - service credit terms differ by agreement.",
          };
        }
        const acc = getAccount(session, target);
        if (!acc.ok) return { error: acc.message, reason: acc.reason };
        const account = accountFor((acc.value as Account).account_id)!;

        return evaluateCredit(
          {
            delayHours: args.delay_hours ?? null,
            shipmentFeeInr: args.shipment_fee_inr ?? null,
            carrierFault: args.carrier_fault ?? null,
            customerFault: args.customer_fault ?? null,
          },
          account,
          SNAPSHOT_MS,
        );
      },
    }),

    evaluate_sla: tool({
      description:
        "Classify a ticket's severity and compute its first-response target, due time and whether it " +
        "has breached, measured against the correct clock (24x7 vs business hours). " +
        "ALWAYS use this instead of doing SLA arithmetic yourself.",
      inputSchema: z.object({
        ticket_id: z.string(),
        severity: z
          .enum(["P1", "P2", "P3"])
          .optional()
          .describe("Override the automatic classification only if you have a documented reason."),
      }),
      execute: async ({ ticket_id, severity }) => {
        const r = getTicket(session, ticket_id);
        if (!r.ok) return { error: r.message, reason: r.reason };
        const account = accountFor(r.value.account_id);
        if (!account) return { error: `Account ${r.value.account_id} not found.` };
        return evaluateSla(r.value as never, account, SNAPSHOT_MS, severity);
      },
    }),

    prepare_action: tool({
      description:
        "Propose a state-changing action WITHOUT executing it. This is always the first step for " +
        "escalations, ticket updates, follow-up tasks and service credits. It returns an action_token " +
        "and a confirmation prompt to show the user. Never call execute_action until the user has " +
        "explicitly agreed.",
      inputSchema: z.object({
        type: z.enum([
          "create_escalation",
          "update_ticket",
          "create_followup_task",
          "issue_service_credit",
        ]),
        subject_id: z.string().describe("The ticket or order this concerns, e.g. TKT-501."),
        summary: z.string().describe("One line describing what will happen."),
        justification: z.string().describe("Why this is warranted, citing the governing source."),
        changes: z
          .record(z.string(), z.union([z.string(), z.number(), z.boolean(), z.null()]))
          .describe(
            "Exactly what will change, e.g. {priority: 'P1', amount_inr: 300, requires_manager_approval: false}.",
          ),
      }),
      execute: async (args) => {
        const subject = args.subject_id.toUpperCase();
        const owning = subject.startsWith("TKT")
          ? getTicket(session, subject)
          : getOrder(session, subject);
        if (!owning.ok) return { error: owning.message, reason: owning.reason };

        return prepareAction(session, {
          type: args.type as ActionType,
          subject_id: subject,
          account_id: (owning.value as { account_id: string }).account_id,
          summary: args.summary,
          justification: args.justification,
          changes: args.changes,
        });
      },
    }),

    execute_action: tool({
      description:
        "Execute a previously prepared action. This only succeeds after the user has confirmed it in " +
        "the interface. If it returns 'refused', tell the user what is still needed - do not retry.",
      inputSchema: z.object({
        action_token: z.string().describe("The action_token returned by prepare_action."),
      }),
      execute: async ({ action_token }) =>
        executeAction(session, action_token, confirmedTokens.has(action_token)),
    }),
  };

  if (!caps.readOpsSignals) return base;

  return {
    ...base,
    get_ops_signals: tool({
      description:
        "INTERNAL ONLY. Return the ranked list of proactive operational signals across all accounts: " +
        "SLA breaches, recurring product issues, multi-account incidents, orders silently owed a " +
        "credit, and past ticket answers that contradict current policy. Use for questions like " +
        "'what needs attention right now?'.",
      inputSchema: z.object({
        severity: z
          .enum(["critical", "high", "medium", "low"])
          .optional()
          .describe("Filter to a minimum severity."),
      }),
      execute: async ({ severity }) => {
        const order = ["critical", "high", "medium", "low"];
        const all = detectSignals();
        const filtered = severity
          ? all.filter((s) => order.indexOf(s.severity) <= order.indexOf(severity))
          : all;
        // Trimmed for the model: full citation objects and long evidence lists
        // burn the token budget on free tiers without improving the answer. The
        // /ops dashboard renders the complete Signal objects server-side.
        return {
          snapshot: SNAPSHOT_LABEL,
          count: filtered.length,
          signals: filtered.map((s) => ({
            id: s.id,
            kind: s.kind,
            severity: s.severity,
            title: s.title,
            detail: s.detail,
            accounts: s.accounts,
            evidence: s.evidence,
            recommended_action: s.recommended_action,
          })),
        };
      },
    }),
  };
}

export type AgentTools = ReturnType<typeof buildTools>;
