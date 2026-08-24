/**
 * State-changing actions, behind a two-phase confirmation gate.
 *
 * REQUIREMENT: no action executes without explicit user confirmation. That gate
 * is enforced here, in the tool layer. A model that decides to skip the
 * confirmation step and call `execute_action` directly is refused, because the
 * token it must present is only accepted once the *user* has confirmed it
 * through the UI.
 *
 * The token is an HMAC-signed description of the action rather than a row in a
 * module-level Map, because this deploys to serverless functions where no two
 * requests are guaranteed to share memory. The signature means the server can
 * verify, on a cold instance, that it authored this exact proposal and that
 * nothing in the payload was altered between proposal and execution.
 */
import { createHmac, timingSafeEqual } from "node:crypto";
import { getOrder, getTicket, type Denied } from "./access";
import { capabilities, type Session } from "./session";
import { SNAPSHOT_MS } from "./db";
import { formatIst } from "./time";

const SECRET = process.env.ACTION_SIGNING_SECRET ?? "parcelpilot-dev-secret-change-me";
/** Proposals expire so a stale token cannot be replayed much later. */
const TOKEN_TTL_MS = 30 * 60 * 1000;

export type ActionType =
  | "create_escalation"
  | "update_ticket"
  | "create_followup_task"
  | "issue_service_credit";

export interface ActionPayload {
  type: ActionType;
  /** Ticket or order the action concerns. */
  subject_id: string;
  account_id: string;
  /** Human-readable description shown on the confirmation card. */
  summary: string;
  /** Field-by-field preview of exactly what will change. */
  changes: Record<string, string | number | boolean | null>;
  /** Why the agent believes this action is warranted. */
  justification: string;
  issued_at: number;
}

export interface PreparedAction {
  status: "awaiting_confirmation";
  action_token: string;
  action: ActionPayload;
  /** Shown verbatim to the user before they confirm. */
  confirmation_prompt: string;
  warnings: string[];
}

export interface ExecutedAction {
  status: "executed";
  reference: string;
  action: ActionPayload;
  executed_at: string;
  executed_by: string;
}

export interface ActionRefused {
  status: "refused";
  reason: string;
}

function sign(body: string): string {
  return createHmac("sha256", SECRET).update(body).digest("base64url");
}

function encode(payload: ActionPayload): string {
  const body = Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
  return `${body}.${sign(body)}`;
}

export function decodeActionToken(token: string): ActionPayload | null {
  const [body, sig] = String(token).split(".");
  if (!body || !sig) return null;
  const expected = sign(body);
  const a = Buffer.from(sig);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null;
  try {
    const payload = JSON.parse(Buffer.from(body, "base64url").toString("utf8")) as ActionPayload;
    if (Date.now() - payload.issued_at > TOKEN_TTL_MS) return null;
    return payload;
  } catch {
    return null;
  }
}

/** Role gate for each action type. */
function authorise(session: Session, type: ActionType, changes: Record<string, unknown>): string | null {
  const caps = capabilities(session);

  if (type === "issue_service_credit") {
    const amount = Number(changes.amount_inr ?? 0);
    const needsManager = Boolean(changes.requires_manager_approval);
    if (session.role === "customer") {
      return "Customers cannot issue service credits. I can raise this to the support team on your behalf instead.";
    }
    if (needsManager && !caps.approveCredits) {
      return `This credit of INR ${amount} exceeds the SOP's manager-approval threshold, and your role cannot approve it. A support manager must sign off.`;
    }
  }

  if (type === "update_ticket" && session.role === "customer") {
    return "Customers cannot modify ticket fields directly. I can add a note or escalate for you instead.";
  }

  return null;
}

/** Phase 1: describe the action. Changes nothing. */
export function prepareAction(
  session: Session,
  input: Omit<ActionPayload, "issued_at">,
): PreparedAction | ActionRefused | Denied {
  // The subject must be visible to this session, checked through the same
  // scoped accessors the read tools use.
  const subject = input.subject_id.toUpperCase().startsWith("TKT")
    ? getTicket(session, input.subject_id)
    : getOrder(session, input.subject_id);
  if (!subject.ok) return subject;

  const refusal = authorise(session, input.type, input.changes);
  if (refusal) return { status: "refused", reason: refusal };

  const payload: ActionPayload = { ...input, issued_at: Date.now() };
  const warnings: string[] = [];
  if (input.type === "issue_service_credit" && input.changes.requires_manager_approval) {
    warnings.push("Requires manager approval per Cancellation & Service Credit SOP v4 s3.");
  }
  if (input.type === "create_escalation") {
    warnings.push("This will page the on-call support team.");
  }

  const lines = Object.entries(input.changes)
    .map(([k, v]) => `  - ${k}: ${v === null ? "(not set)" : v}`)
    .join("\n");

  return {
    status: "awaiting_confirmation",
    action_token: encode(payload),
    action: payload,
    confirmation_prompt:
      `I am ready to ${describeType(input.type)} for ${input.subject_id}:\n${lines}\n\n` +
      `Reason: ${input.justification}\n\nShall I go ahead?`,
    warnings,
  };
}

function describeType(type: ActionType): string {
  switch (type) {
    case "create_escalation": return "create an escalation";
    case "update_ticket": return "update the ticket";
    case "create_followup_task": return "create a follow-up task";
    case "issue_service_credit": return "issue a service credit";
  }
}

/**
 * The in-memory audit log. In production this is a database table; here it
 * demonstrates that every executed action is recorded with who authorised it.
 */
const AUDIT: ExecutedAction[] = [];

export function auditLog(): ExecutedAction[] {
  return AUDIT;
}

let counter = 1000;

/**
 * Phase 2: execute. `userConfirmed` is supplied by the API route from the
 * user's own click, never by the model.
 */
export function executeAction(
  session: Session,
  token: string,
  userConfirmed: boolean,
): ExecutedAction | ActionRefused {
  if (!userConfirmed) {
    return {
      status: "refused",
      reason:
        "This action has not been confirmed by the user. Present the proposal and wait for them to confirm before calling execute_action.",
    };
  }

  const payload = decodeActionToken(token);
  if (!payload) {
    return {
      status: "refused",
      reason: "The action token is invalid or has expired. Prepare the action again.",
    };
  }

  const refusal = authorise(session, payload.type, payload.changes);
  if (refusal) return { status: "refused", reason: refusal };

  const prefix =
    payload.type === "create_escalation" ? "ESC" :
    payload.type === "create_followup_task" ? "TASK" :
    payload.type === "issue_service_credit" ? "CR" : "UPD";

  const executed: ExecutedAction = {
    status: "executed",
    reference: `${prefix}-${++counter}`,
    action: payload,
    // Actions are timestamped against the dataset snapshot so the demo stays
    // internally consistent with every other time in the system.
    executed_at: formatIst(SNAPSHOT_MS),
    executed_by: session.displayName,
  };
  AUDIT.push(executed);
  return executed;
}
