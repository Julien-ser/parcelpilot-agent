/**
 * Typed access to the structured dataset produced by ingest/build.py.
 *
 * This module is deliberately dumb: it loads and types the records and exposes
 * the dataset snapshot time. It performs NO access control - that lives in
 * access.ts, which is the only module the agent's tools are allowed to call.
 */
import raw from "@/data/db.json";
import { parseIst } from "./time";

export type Plan = "Enterprise" | "Growth" | "Standard";
export type OrderStatus = "DRAFT" | "BOOKED" | "PICKED_UP" | "DELIVERED" | string;

export interface Account {
  account_id: string;
  account_name: string;
  plan: Plan;
  status: string;
  csm: string;
  contract_file: string | null;
  premium_support: boolean;
  notes: string | null;
}

export interface Order {
  order_id: string;
  account_id: string;
  carrier: string;
  status: OrderStatus;
  booked_at: string | null;
  pickup_window_start: string | null;
  pickup_window_end: string | null;
  pickup_actual_at: string | null;
  shipment_fee_inr: number;
  carrier_fault: boolean;
  customer_fault: boolean;
  cancellation_requested_at: string | null;
  notes: string | null;
}

export interface Ticket {
  ticket_id: string;
  account_id: string;
  created_at: string | null;
  status: string;
  subject: string;
  description: string;
  channel: string;
  assigned_to: string | null;
  last_customer_message_at: string | null;
  /**
   * What an agent told the customer previously. The README sheet warns these
   * may be WRONG. Never treat as policy authority - see precedence.ts.
   */
  historical_resolution: string | null;
}

interface Db {
  snapshot_local: string;
  snapshot_tz: string;
  currency: string;
  meta: Record<string, string>;
  accounts: Account[];
  orders: Order[];
  tickets: Ticket[];
}

const db = raw as unknown as Db;

export const ACCOUNTS: Account[] = db.accounts;
export const ORDERS: Order[] = db.orders;
export const TICKETS: Ticket[] = db.tickets;
export const CURRENCY = db.currency;

/** Reference "now" for every time-based question, per the README sheet. */
export const SNAPSHOT_MS: number = parseIst(db.snapshot_local)!;
export const SNAPSHOT_LABEL = `${db.snapshot_local} ${db.snapshot_tz}`;
export const SNAPSHOT_TZ = db.snapshot_tz;

export function accountById(id: string): Account | undefined {
  return ACCOUNTS.find((a) => a.account_id.toLowerCase() === id.toLowerCase());
}

/** Resolve "Northstar", "northstar logistics" or "ACCT-001" to an account. */
export function resolveAccount(nameOrId: string): Account | undefined {
  const q = nameOrId.trim().toLowerCase();
  if (!q) return undefined;
  return (
    ACCOUNTS.find((a) => a.account_id.toLowerCase() === q) ||
    ACCOUNTS.find((a) => a.account_name.toLowerCase() === q) ||
    ACCOUNTS.find((a) => a.account_name.toLowerCase().startsWith(q)) ||
    ACCOUNTS.find((a) => a.account_name.toLowerCase().includes(q))
  );
}
