/**
 * Document retrieval: BM25 over authority-filtered chunks.
 *
 * Why not embeddings? The whole corpus is ~6 KB of text across 23 chunks. At
 * that size a vector index adds a runtime dependency, a second failure mode and
 * an opaque ranking, and buys nothing: the hard part here is not *finding*
 * relevant text, it is deciding which of several relevant, contradictory
 * passages actually governs. That decision is precedence, not similarity, so the
 * effort goes into authority ranking instead. The architecture note describes
 * the scale-out path (chunk embeddings + a cross-encoder reranker, keeping this
 * same authority layer on top).
 */
import {
  visibleChunks,
  toCitation,
  type Chunk,
  type Citation,
  type ScopeOptions,
} from "./corpus";
import type { Session } from "./session";

const STOPWORDS = new Set([
  "a", "an", "the", "is", "are", "was", "were", "be", "been", "of", "to", "in", "on", "for",
  "and", "or", "if", "it", "its", "this", "that", "with", "as", "at", "by", "from", "we",
  "you", "i", "do", "does", "can", "could", "should", "would", "may", "will", "what", "when",
  "how", "why", "which", "there", "their", "they",
]);

/**
 * Domain synonyms. Support questions and policy documents use different words
 * for the same concept ("SLA" never appears in the policy; it says "response
 * target"). Expanding the query is cheaper and far more debuggable than
 * embeddings for a vocabulary this small and this stable.
 */
const SYNONYMS: Record<string, string[]> = {
  sla: ["response", "target", "first-response"],
  slas: ["response", "target", "first-response"],
  refund: ["credit", "fee"],
  charge: ["fee"],
  fee: ["fee", "cancellation"],
  cancel: ["cancellation", "cancelled"],
  cancelling: ["cancellation"],
  late: ["delay", "delayed", "past"],
  delay: ["late", "past", "delayed"],
  compensation: ["credit", "service"],
  credit: ["credit", "service"],
  csv: ["bulk", "upload", "rows"],
  bulk: ["csv", "upload", "rows"],
  outage: ["critical", "p1", "production"],
  down: ["outage", "critical", "p1"],
  breach: ["target", "escalation", "breached"],
  escalate: ["escalation", "p1"],
  urgent: ["critical", "p1", "severity"],
  severity: ["p1", "p2", "p3", "critical"],
  webhook: ["pickup", "confirmation", "swiftship"],
  pickup: ["pickup", "collected", "window"],
  entitlement: ["plan", "capabilities", "included"],
  entitlements: ["plan", "capabilities", "included"],
  hours: ["hour", "business"],
};

function stem(token: string): string {
  return token
    .replace(/(ications|ication)$/, "ic")
    .replace(/(ments|ment)$/, "")
    .replace(/(ions|ion)$/, "")
    .replace(/(ing)$/, "")
    .replace(/(ed)$/, "")
    .replace(/(es|s)$/, "");
}

export function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9\-#]+/g, " ")
    .split(/\s+/)
    .filter((t) => t.length > 1 && !STOPWORDS.has(t))
    .map(stem);
}

function expand(query: string): string[] {
  const base = query.toLowerCase().replace(/[^a-z0-9\-#]+/g, " ").split(/\s+/).filter(Boolean);
  const extra: string[] = [];
  for (const word of base) {
    const syns = SYNONYMS[word];
    if (syns) extra.push(...syns);
  }
  return tokenize([...base, ...extra].join(" "));
}

const K1 = 1.5;
const B = 0.75;

/**
 * Authority multiplier. A signed agreement outranks general policy for the same
 * lexical match, so a query answerable from both surfaces the contract first.
 */
function authorityBoost(c: Chunk): number {
  switch (c.authority_tier) {
    case 1: return 1.6;
    case 2: return 1.25;
    case 3: return 1.0;
    default: return 0.6;
  }
}

export interface SearchHit {
  score: number;
  citation: Citation;
  text: string;
  /** Set when a DEPRECATED document was deliberately included. */
  warning?: string;
}

export interface SearchOptions extends ScopeOptions {
  limit?: number;
  /** Restrict to a document kind, e.g. only agreements. */
  kind?: Chunk["kind"];
}

export function searchDocuments(
  session: Session,
  query: string,
  opts: SearchOptions = {},
): SearchHit[] {
  const limit = opts.limit ?? 5;
  let pool = visibleChunks(session, opts);
  if (opts.kind) pool = pool.filter((c) => c.kind === opts.kind);
  if (pool.length === 0) return [];

  const docs = pool.map((c) => tokenize(`${c.doc_title} ${c.section} ${c.text}`));
  const avgLen = docs.reduce((sum, d) => sum + d.length, 0) / docs.length;
  const terms = expand(query);
  if (terms.length === 0) return [];

  const df = new Map<string, number>();
  for (const term of new Set(terms)) {
    df.set(term, docs.filter((d) => d.includes(term)).length);
  }

  const scored = pool.map((chunk, i) => {
    const doc = docs[i];
    let score = 0;
    for (const term of terms) {
      const n = df.get(term) ?? 0;
      if (n === 0) continue;
      const freq = doc.filter((t) => t === term).length;
      if (freq === 0) continue;
      const idf = Math.log(1 + (docs.length - n + 0.5) / (n + 0.5));
      score += idf * ((freq * (K1 + 1)) / (freq + K1 * (1 - B + B * (doc.length / avgLen))));
    }
    return { chunk, score: score * authorityBoost(chunk) };
  });

  return scored
    .filter((s) => s.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
    .map(({ chunk, score }) => ({
      score: Number(score.toFixed(3)),
      citation: toCitation(chunk),
      text: chunk.text,
      ...(chunk.status === "DEPRECATED"
        ? {
            warning:
              "This document is DEPRECATED and must not be used as current policy. It is shown only because deprecated sources were explicitly requested.",
          }
        : {}),
    }));
}
