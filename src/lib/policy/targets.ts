/**
 * Extraction of first-response targets from the source documents.
 *
 * Targets are PARSED from the policy table and the contract bullets rather than
 * copied into code, so a re-negotiated agreement or a policy v4 changes the
 * system's answers without a code change. That is also what the brief asks for:
 * reason over the supplied data, do not hardcode.
 *
 * Assumption, stated explicitly: a target written without the word "business"
 * ("30 minutes, 24x7", "2 hours") is wall-clock time. The documents say
 * "business hours" whenever they mean business hours, so the omission is
 * meaningful. This matters because the dataset snapshot falls on a Sunday.
 */
import { contractChunks, policyChunks, toCitation, type Chunk, type Citation } from "../corpus";
import { HOUR, MINUTE, addBusinessDays, addBusinessMs, businessMsBetween } from "../time";

export type Severity = "P1" | "P2" | "P3";
export type Clock = "wall" | "business_hours" | "business_days";

export interface Target {
  severity: Severity;
  /** Magnitude in the unit implied by `clock`. */
  value: number;
  unit: "minutes" | "hours" | "days";
  clock: Clock;
  /** Verbatim text from the source, e.g. "15 minutes, 24x7". */
  raw: string;
  citation: Citation;
  /** "contract" targets displace "policy" ones. */
  source: "contract" | "policy";
}

const DURATION_RE =
  /(\d+)\s+(business\s+hours?|business\s+days?|minutes?|hours?|days?)(\s*,?\s*24x7)?/gi;

interface ParsedDuration {
  value: number;
  unit: "minutes" | "hours" | "days";
  clock: Clock;
  raw: string;
}

export function parseDuration(text: string): ParsedDuration | null {
  DURATION_RE.lastIndex = 0;
  const m = DURATION_RE.exec(text);
  return m ? toDuration(m) : null;
}

function toDuration(m: RegExpExecArray): ParsedDuration {
  const value = Number(m[1]);
  const word = m[2].toLowerCase().replace(/\s+/g, " ");
  const twentyFourSeven = Boolean(m[3]);

  let unit: "minutes" | "hours" | "days";
  let clock: Clock;
  if (word.startsWith("business hour")) {
    unit = "hours";
    clock = "business_hours";
  } else if (word.startsWith("business day")) {
    unit = "days";
    clock = "business_days";
  } else if (word.startsWith("minute")) {
    unit = "minutes";
    clock = "wall";
  } else if (word.startsWith("day")) {
    unit = "days";
    clock = "business_days";
  } else {
    unit = "hours";
    clock = "wall";
  }
  // An explicit 24x7 marker forces wall-clock regardless of wording.
  if (twentyFourSeven) clock = "wall";
  return { value, unit, clock, raw: m[0].trim() };
}

function allDurations(text: string): ParsedDuration[] {
  const out: ParsedDuration[] = [];
  DURATION_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = DURATION_RE.exec(text)) !== null) out.push(toDuration(m));
  return out;
}

/**
 * Parse the plan/severity grid in Support Policy v3 section 3.
 * Row shape: "Enterprise 30 minutes, 24x7 2 hours 1 business day"
 */
export function policyTargets(plan: string): Target[] {
  const chunk = policyChunks().find(
    (c) => /first-response target/i.test(c.section) || /first-response target/i.test(c.text),
  );
  if (!chunk) return [];

  const row = chunk.text
    .split("\n")
    .find((line) => new RegExp(`^\\s*${plan}\\b`, "i").test(line.trim()));
  if (!row) return [];

  const durations = allDurations(row);
  if (durations.length < 3) return [];

  const citation = toCitation(chunk);
  return (["P1", "P2", "P3"] as Severity[]).map((severity, i) => ({
    severity,
    ...durations[i],
    citation,
    source: "policy" as const,
  }));
}

/**
 * Parse contract support terms.
 * Bullet shape: "- P1: 15 minutes, 24x7"
 */
export function contractTargets(accountId: string): Target[] {
  const chunk = contractChunks(accountId).find((c) => /support term/i.test(c.section));
  if (!chunk) return [];

  const citation = toCitation(chunk);
  const out: Target[] = [];
  for (const line of chunk.text.split("\n")) {
    const m = line.match(/P([123])\s*:\s*(.+)$/i);
    if (!m) continue;
    const parsed = parseDuration(m[2]);
    if (!parsed) continue;
    out.push({
      severity: `P${m[1]}` as Severity,
      ...parsed,
      citation,
      source: "contract",
    });
  }
  return out;
}

/** True when a contract removes weekend / after-hours coverage entirely. */
export function noWeekendCoverage(accountId: string): { yes: boolean; citation?: Citation } {
  const chunk = contractChunks(accountId).find((c) =>
    /no weekend|no after-hours|weekend or after-hours/i.test(c.text),
  );
  return chunk ? { yes: true, citation: toCitation(chunk) } : { yes: false };
}

/**
 * Resolve the governing target for one severity, applying precedence:
 * signed agreement first, then the current support policy.
 */
export function resolveTarget(
  accountId: string,
  plan: string,
  severity: Severity,
): { target: Target | null; displaced: Target | null } {
  const fromContract = contractTargets(accountId).find((t) => t.severity === severity) ?? null;
  const fromPolicy = policyTargets(plan).find((t) => t.severity === severity) ?? null;
  if (fromContract) return { target: fromContract, displaced: fromPolicy };
  return { target: fromPolicy, displaced: null };
}

/** Convert a target into a deadline measured from `from`. */
export function dueAt(target: Target, from: number): number {
  switch (target.clock) {
    case "wall": {
      const ms = target.unit === "minutes" ? target.value * MINUTE : target.value * HOUR;
      return from + ms;
    }
    case "business_hours":
      return addBusinessMs(from, target.value * HOUR);
    case "business_days":
      return addBusinessDays(from, target.value);
  }
}

/** Elapsed time against a target's own clock. */
export function elapsedAgainst(target: Target, from: number, to: number): number {
  return target.clock === "wall" ? Math.max(0, to - from) : businessMsBetween(from, to);
}

export function describeTarget(t: Target): string {
  const clockLabel =
    t.clock === "wall" ? (/24x7/i.test(t.raw) ? " (24x7)" : " (wall clock)") : "";
  return `${t.raw}${clockLabel}`;
}

export type { Citation, Chunk };
