/**
 * Authority-aware access to the document corpus.
 *
 * Two independent filters are applied here rather than in the prompt:
 *
 *  1. ACCOUNT SCOPE - a chunk carrying `account_scope` is a signed agreement and
 *     is only reachable by sessions entitled to that account. LumenWorks must
 *     never retrieve Northstar's negotiated terms.
 *  2. LIFECYCLE - documents marked DEPRECATED are excluded by default. They are
 *     reachable only through an explicit opt-in used for "what did the old policy
 *     say" questions, and always carry a warning when returned.
 */
import rawCorpus from "@/data/corpus.json";
import { visibleAccountIds } from "./access";
import type { Session } from "./session";

export interface Chunk {
  chunk_id: string;
  doc_id: string;
  doc_title: string;
  source_file: string;
  kind: "customer_agreement" | "support_policy" | "sop" | "product_doc" | "document";
  /** 1 = signed agreement, 2 = current policy/SOP, 3 = product docs, 4 = historical. */
  authority_tier: number;
  status: "CURRENT" | "DEPRECATED" | "UNKNOWN" | string;
  effective: string;
  supersedes: string;
  superseded_by: string;
  account_scope: string;
  section: string;
  text: string;
  page: number;
}

export const CHUNKS: Chunk[] = (rawCorpus as unknown as Chunk[]).map((c) => ({
  ...c,
  // Normalise the PDF bullet glyph; it survives extraction but adds noise.
  text: c.text.replace(/●/g, "-").replace(/[ \t]+/g, " ").trim(),
}));

export const TIER_LABELS: Record<number, string> = {
  1: "signed customer agreement",
  2: "current policy / SOP",
  3: "product documentation",
  4: "historical ticket (context only)",
};

export interface ScopeOptions {
  /** Include DEPRECATED documents. Off by default. */
  includeDeprecated?: boolean;
  /**
   * Restrict contract visibility to this account even for internal staff, so an
   * agent investigating LumenWorks does not accidentally cite Northstar terms.
   */
  focusAccountId?: string | null;
}

export function isDeprecated(c: Chunk): boolean {
  return c.status === "DEPRECATED" || Boolean(c.superseded_by);
}

/** Chunks this session may retrieve, after scope and lifecycle filtering. */
export function visibleChunks(session: Session, opts: ScopeOptions = {}): Chunk[] {
  const allowedAccounts = visibleAccountIds(session);
  const focus = opts.focusAccountId;

  return CHUNKS.filter((c) => {
    if (!opts.includeDeprecated && isDeprecated(c)) return false;
    if (!c.account_scope) return true;
    if (!allowedAccounts.includes(c.account_scope)) return false;
    if (focus && c.account_scope !== focus) return false;
    return true;
  });
}

/**
 * Contract clauses for one account, used by the policy engine.
 * Callers MUST have already authorised access to `accountId`.
 */
export function contractChunks(accountId: string): Chunk[] {
  return CHUNKS.filter(
    (c) => c.account_scope === accountId && !isDeprecated(c) && c.authority_tier === 1,
  );
}

/** Current, non-account-specific policy and SOP text. */
export function policyChunks(): Chunk[] {
  return CHUNKS.filter((c) => !c.account_scope && !isDeprecated(c) && c.authority_tier === 2);
}

export function productChunks(): Chunk[] {
  return CHUNKS.filter((c) => !c.account_scope && !isDeprecated(c) && c.authority_tier === 3);
}

export function chunkById(id: string): Chunk | undefined {
  return CHUNKS.find((c) => c.chunk_id === id);
}

/** Find the first current chunk whose section heading matches a pattern. */
export function findClause(pattern: RegExp, opts: { accountId?: string } = {}): Chunk | undefined {
  const pool = opts.accountId
    ? contractChunks(opts.accountId)
    : CHUNKS.filter((c) => !c.account_scope && !isDeprecated(c));
  return pool.find((c) => pattern.test(c.section) || pattern.test(c.text));
}

/** A compact citation string used in rule traces and agent answers. */
export function cite(c: Chunk): string {
  const scope = c.account_scope ? ` (${c.account_scope})` : "";
  return `${c.doc_title}${scope} - ${c.section}`;
}

export interface Citation {
  chunk_id: string;
  doc_title: string;
  source_file: string;
  section: string;
  authority_tier: number;
  tier_label: string;
  status: string;
  effective: string;
  account_scope: string;
  page: number;
}

export function toCitation(c: Chunk): Citation {
  return {
    chunk_id: c.chunk_id,
    doc_title: c.doc_title,
    source_file: c.source_file,
    section: c.section,
    authority_tier: c.authority_tier,
    tier_label: TIER_LABELS[c.authority_tier] ?? "document",
    status: c.status,
    effective: c.effective,
    account_scope: c.account_scope,
    page: c.page,
  };
}
