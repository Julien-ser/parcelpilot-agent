/**
 * Shared vocabulary for policy decisions.
 *
 * Every engine returns a Decision rather than a bare number. The Decision
 * carries the *reasoning path* - which clause was consulted, which one won, and
 * what it displaced - so the agent can explain itself and a human can audit it
 * without rerunning the model. The model is never the source of a figure; it
 * only narrates a trace that code produced.
 */
import type { Citation } from "../corpus";

/** One step of the deterministic reasoning path. */
export interface RuleStep {
  /** Short label, e.g. "contract cancellation waiver". */
  rule: string;
  /** What this step determined, in plain language. */
  outcome: string;
  /** The clause this step was read from, if any. */
  citation?: Citation;
  /** What this step displaced, e.g. "SOP v4 s1 default INR 250 fee". */
  overrides?: string;
}

/**
 * A disagreement between sources that a human should know about, even when the
 * engine resolved it confidently.
 */
export interface Conflict {
  kind: "contract_overrides_policy" | "deprecated_source" | "stale_data" | "incorrect_history";
  summary: string;
  winner?: Citation;
  loser?: Citation;
}

export type Confidence = "high" | "needs_verification";

/** Something the engine could not determine and must not guess. */
export interface Unknown {
  field: string;
  why: string;
}

export interface Decision<T> {
  /** The machine-readable determination. */
  determination: T;
  confidence: Confidence;
  /** Ordered reasoning path. */
  trace: RuleStep[];
  citations: Citation[];
  conflicts: Conflict[];
  unknowns: Unknown[];
  /** Set when the SOP requires a human to sign off before acting. */
  requiresApproval?: { reason: string; threshold?: string };
  /** One-line summary safe to show a user verbatim. */
  summary: string;
}

export function decision<T>(init: Partial<Decision<T>> & { determination: T; summary: string }): Decision<T> {
  return {
    confidence: "high",
    trace: [],
    citations: [],
    conflicts: [],
    unknowns: [],
    ...init,
  };
}

/** Parse an INR amount out of policy prose, e.g. "INR 250" or "INR 1,000". */
export function parseInr(text: string, near?: RegExp): number | null {
  const scope = near ? (text.match(near)?.[0] ?? text) : text;
  const m = scope.match(/INR\s*([\d,]+)/i);
  return m ? Number(m[1].replace(/,/g, "")) : null;
}

/** Parse a percentage, e.g. "10% of the shipment fee". */
export function parsePercent(text: string): number | null {
  const m = text.match(/(\d+(?:\.\d+)?)\s*%/);
  return m ? Number(m[1]) : null;
}
