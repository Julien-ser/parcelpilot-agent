import { USERS, type Role } from "./session";
import { accountById } from "./db";

export interface UserOption {
  id: string;
  label: string;
  role: Role;
  /** Shown under the header so the active scope is always visible. */
  scopeNote: string;
}

/**
 * The identity roster offered by the demo's user switcher.
 *
 * Real deployments resolve this from an IdP; exposing a switcher here is what
 * makes the access-control behaviour demonstrable - ask the same question as two
 * different users and watch the data layer answer differently.
 */
export function userOptions(): UserOption[] {
  return Object.values(USERS).map((u) => {
    if (u.role === "customer") {
      const account = u.accountId ? accountById(u.accountId) : undefined;
      return {
        id: u.userId,
        label: u.displayName,
        role: u.role,
        scopeNote: `Customer scope: can only read ${account?.account_name ?? u.accountId} (${u.accountId}), ${account?.plan ?? "unknown"} plan. Internal fields are stripped in the data layer.`,
      };
    }
    return {
      id: u.userId,
      label: u.displayName,
      role: u.role,
      scopeNote:
        u.role === "support_manager"
          ? "Internal scope: all accounts, all internal fields, and may approve credits above the SOP threshold."
          : "Internal scope: all accounts and internal fields. Cannot approve credits above the SOP threshold.",
    };
  });
}
