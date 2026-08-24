/**
 * The scoped data-access layer.
 *
 * REQUIREMENT: access control is enforced here, in the data/tool layer, not by
 * asking the model nicely in a system prompt. Every accessor takes a Session and
 * filters before returning. A jailbroken or confused model calling these
 * functions with someone else's account id still gets nothing back.
 *
 * Denials are returned as values, not thrown, so the agent can explain the
 * refusal to the user and offer to escalate instead of surfacing a stack trace.
 */
import {
  ACCOUNTS,
  ORDERS,
  TICKETS,
  type Account,
  type Order,
  type Ticket,
  accountById,
  resolveAccount,
} from "./db";
import { capabilities, type Session } from "./session";

export interface Denied {
  ok: false;
  reason: "not_found" | "forbidden";
  message: string;
}

export type Result<T> = { ok: true; value: T } | Denied;

const forbidden = (message: string): Denied => ({ ok: false, reason: "forbidden", message });
const notFound = (message: string): Denied => ({ ok: false, reason: "not_found", message });

/** Account ids this session is permitted to read. */
export function visibleAccountIds(session: Session): string[] {
  if (capabilities(session).readAnyAccount) return ACCOUNTS.map((a) => a.account_id);
  return session.accountId ? [session.accountId] : [];
}

export function canSeeAccount(session: Session, accountId: string): boolean {
  return visibleAccountIds(session).includes(accountId);
}

/**
 * Strip internal-only fields before anything reaches a customer.
 *
 * `historical_resolution` is internal for two reasons: it is operational
 * chatter, and the dataset README warns it may be factually wrong. Showing a
 * customer a previous incorrect answer would actively cause harm.
 */
function redactTicket(session: Session, t: Ticket): Ticket | PublicTicket {
  if (capabilities(session).readInternalFields) return t;
  const { assigned_to: _a, historical_resolution: _h, ...rest } = t;
  return rest as PublicTicket;
}

export type PublicTicket = Omit<Ticket, "assigned_to" | "historical_resolution">;

function redactAccount(session: Session, a: Account): Account | PublicAccount {
  if (capabilities(session).readInternalFields) return a;
  const { notes: _n, ...rest } = a;
  return rest as PublicAccount;
}

export type PublicAccount = Omit<Account, "notes">;

// --- Accounts ---------------------------------------------------------------

export function getAccount(session: Session, nameOrId: string): Result<Account | PublicAccount> {
  const account = resolveAccount(nameOrId);
  if (!account) return notFound(`No account matches "${nameOrId}".`);
  if (!canSeeAccount(session, account.account_id)) {
    return forbidden(
      `You are not authorised to view account ${account.account_id}. Your session is scoped to ${session.accountId ?? "no account"}.`,
    );
  }
  return { ok: true, value: redactAccount(session, account) };
}

export function listAccounts(session: Session): Result<(Account | PublicAccount)[]> {
  const ids = visibleAccountIds(session);
  return {
    ok: true,
    value: ACCOUNTS.filter((a) => ids.includes(a.account_id)).map((a) => redactAccount(session, a)),
  };
}

// --- Orders -----------------------------------------------------------------

export function getOrder(session: Session, orderId: string): Result<Order> {
  const order = ORDERS.find((o) => o.order_id.toLowerCase() === orderId.trim().toLowerCase());
  if (!order) return notFound(`No order matches "${orderId}".`);
  if (!canSeeAccount(session, order.account_id)) {
    // Deliberately does not confirm which account owns it - that is itself a leak.
    return forbidden(
      `Order ${order.order_id} does not belong to your account, so it cannot be shown. If you believe this is an error, ParcelPilot support can help.`,
    );
  }
  return { ok: true, value: order };
}

export function listOrders(
  session: Session,
  filter: { accountId?: string; status?: string } = {},
): Result<Order[]> {
  const ids = visibleAccountIds(session);
  if (filter.accountId && !canSeeAccount(session, filter.accountId)) {
    return forbidden(`You are not authorised to list orders for ${filter.accountId}.`);
  }
  const scope = filter.accountId ? [filter.accountId] : ids;
  let rows = ORDERS.filter((o) => scope.includes(o.account_id));
  if (filter.status) {
    rows = rows.filter((o) => o.status.toLowerCase() === filter.status!.toLowerCase());
  }
  return { ok: true, value: rows };
}

// --- Tickets ----------------------------------------------------------------

export function getTicket(session: Session, ticketId: string): Result<Ticket | PublicTicket> {
  const ticket = TICKETS.find((t) => t.ticket_id.toLowerCase() === ticketId.trim().toLowerCase());
  if (!ticket) return notFound(`No ticket matches "${ticketId}".`);
  if (!canSeeAccount(session, ticket.account_id)) {
    return forbidden(
      `Ticket ${ticket.ticket_id} does not belong to your account, so it cannot be shown.`,
    );
  }
  return { ok: true, value: redactTicket(session, ticket) };
}

export function listTickets(
  session: Session,
  filter: { accountId?: string; status?: string } = {},
): Result<(Ticket | PublicTicket)[]> {
  const ids = visibleAccountIds(session);
  if (filter.accountId && !canSeeAccount(session, filter.accountId)) {
    return forbidden(`You are not authorised to list tickets for ${filter.accountId}.`);
  }
  const scope = filter.accountId ? [filter.accountId] : ids;
  let rows = TICKETS.filter((t) => scope.includes(t.account_id));
  if (filter.status) {
    rows = rows.filter((t) => t.status.toLowerCase() === filter.status!.toLowerCase());
  }
  return { ok: true, value: rows.map((t) => redactTicket(session, t)) };
}

/** Unfiltered read for internal aggregate views. Throws if misused. */
export function allTicketsForOps(session: Session): Ticket[] {
  if (!capabilities(session).readOpsSignals) {
    throw new Error("allTicketsForOps called without ops capability");
  }
  return TICKETS;
}

export function allOrdersForOps(session: Session): Order[] {
  if (!capabilities(session).readOpsSignals) {
    throw new Error("allOrdersForOps called without ops capability");
  }
  return ORDERS;
}

export { accountById };
