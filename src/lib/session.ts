/**
 * Mock authentication and authorisation.
 *
 * In production this would be a verified JWT / session cookie resolved against
 * an identity provider. Here it is a signed-in identity chosen from a fixed
 * roster, which is enough to demonstrate the property that matters: the agent
 * NEVER chooses its own scope. The scope arrives with the request and the data
 * layer enforces it.
 */

export type Role = "customer" | "support_agent" | "support_manager";

export interface Session {
  userId: string;
  displayName: string;
  role: Role;
  /** For customers: the only account they may ever read. Null for internal staff. */
  accountId: string | null;
  /** Internal staff only: may approve credits above the SOP approval threshold. */
  canApproveCredits: boolean;
}

/**
 * Capability flags derived from role. Tools check these rather than
 * re-deriving permissions from strings at each call site.
 */
export interface Capabilities {
  /** May read records belonging to accounts other than their own. */
  readAnyAccount: boolean;
  /** May read internal-only fields (assignee, historical resolutions, notes). */
  readInternalFields: boolean;
  /** May see cross-account aggregate signals (the ops dashboard). */
  readOpsSignals: boolean;
  /** May approve a credit above the SOP manager-approval threshold. */
  approveCredits: boolean;
}

export const USERS: Record<string, Session> = {
  "northstar-ops": {
    userId: "northstar-ops",
    displayName: "Ravi Menon - Northstar Logistics",
    role: "customer",
    accountId: "ACCT-001",
    canApproveCredits: false,
  },
  "lumenworks-ops": {
    userId: "lumenworks-ops",
    displayName: "Sara Iyer - LumenWorks",
    role: "customer",
    accountId: "ACCT-002",
    canApproveCredits: false,
  },
  "beacon-ops": {
    userId: "beacon-ops",
    displayName: "Dev Shah - Beacon Retail",
    role: "customer",
    accountId: "ACCT-003",
    canApproveCredits: false,
  },
  "agent-maya": {
    userId: "agent-maya",
    displayName: "Maya - ParcelPilot Support",
    role: "support_agent",
    accountId: null,
    canApproveCredits: false,
  },
  "manager-priya": {
    userId: "manager-priya",
    displayName: "Priya Mehta - Support Manager",
    role: "support_manager",
    accountId: null,
    canApproveCredits: true,
  },
};

export const DEFAULT_USER_ID = "northstar-ops";

export function getSession(userId: string | undefined | null): Session {
  const user = userId ? USERS[userId] : undefined;
  return user ?? USERS[DEFAULT_USER_ID];
}

export function capabilities(session: Session): Capabilities {
  const internal = session.role === "support_agent" || session.role === "support_manager";
  return {
    readAnyAccount: internal,
    readInternalFields: internal,
    readOpsSignals: internal,
    approveCredits: session.canApproveCredits,
  };
}

export function isInternal(session: Session): boolean {
  return session.role !== "customer";
}

/** Short description of the caller's scope, injected into the system prompt. */
export function describeScope(session: Session): string {
  if (session.role === "customer") {
    return `signed in as ${session.displayName}, a CUSTOMER restricted to account ${session.accountId}`;
  }
  return `signed in as ${session.displayName}, an INTERNAL ParcelPilot ${session.role.replace("_", " ")} with access to all accounts`;
}
