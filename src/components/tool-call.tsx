"use client";

import { useState } from "react";

/** Friendly labels so the trace reads as intent, not as function names. */
const LABELS: Record<string, string> = {
  search_documents: "Searching policies & agreements",
  get_order: "Looking up order",
  get_ticket: "Looking up ticket",
  get_account: "Looking up account",
  list_records: "Listing records",
  evaluate_cancellation: "Applying cancellation rules",
  evaluate_service_credit: "Applying service-credit rules",
  evaluate_sla: "Checking SLA target",
  get_ops_signals: "Scanning support activity",
  prepare_action: "Preparing action",
  execute_action: "Executing action",
};

const KIND: Record<string, "doc" | "data" | "policy" | "action"> = {
  search_documents: "doc",
  get_order: "data",
  get_ticket: "data",
  get_account: "data",
  list_records: "data",
  get_ops_signals: "data",
  evaluate_cancellation: "policy",
  evaluate_service_credit: "policy",
  evaluate_sla: "policy",
  prepare_action: "action",
  execute_action: "action",
};

const KIND_COLOR = {
  doc: "#a371f7",
  data: "#4f9cf9",
  policy: "#3fb950",
  action: "#d29922",
} as const;

interface Props {
  name: string;
  state: string;
  input?: unknown;
  output?: unknown;
  errorText?: string;
}

interface TraceStep {
  rule: string;
  outcome: string;
  overrides?: string;
  citation?: { doc_title?: string; section?: string; tier_label?: string; status?: string };
}

export function ToolCall({ name, state, input, output, errorText }: Props) {
  const [open, setOpen] = useState(false);
  const kind = KIND[name] ?? "data";
  const color = KIND_COLOR[kind];
  const running = state === "input-streaming" || state === "input-available";
  const failed = state === "output-error";

  const out = output as
    | {
        trace?: TraceStep[];
        summary?: string;
        error?: string;
        results?: { citation?: { doc_title?: string; section?: string } }[];
      }
    | undefined;

  const denied = Boolean(out?.error);
  const subtitle = summarise(name, input);

  return (
    <div className="panel overflow-hidden text-[13px]">
      <button
        onClick={() => setOpen((v) => !v)}
        className="w-full flex items-center gap-2.5 px-3 py-2 text-left hover:brightness-110 transition"
      >
        <span
          className={`w-1.5 h-1.5 rounded-full shrink-0 ${running ? "pulse" : ""}`}
          style={{ background: failed || denied ? "var(--crit)" : color }}
        />
        <span className="font-medium" style={{ color }}>
          {LABELS[name] ?? name}
        </span>
        {subtitle && (
          <span className="mono text-[11px] truncate" style={{ color: "var(--muted)" }}>
            {subtitle}
          </span>
        )}
        <span className="flex-1" />
        {denied && (
          <span className="text-[11px] px-1.5 py-0.5 rounded" style={{ color: "var(--crit)" }}>
            blocked
          </span>
        )}
        <span className="text-[11px]" style={{ color: "var(--muted)" }}>
          {running ? "running" : open ? "hide" : "details"}
        </span>
      </button>

      {open && (
        <div className="px-3 pb-3 pt-1 border-t" style={{ borderColor: "var(--border)" }}>
          {errorText && (
            <p className="text-xs mb-2" style={{ color: "var(--crit)" }}>
              {errorText}
            </p>
          )}

          {out?.error && (
            <p className="text-xs mb-2" style={{ color: "var(--crit)" }}>
              {out.error}
            </p>
          )}

          {/* The rule trace is the point of the whole system - show it first. */}
          {out?.trace && out.trace.length > 0 && (
            <ol className="space-y-2 mb-3">
              {out.trace.map((step, i) => (
                <li key={i} className="text-xs">
                  <div className="flex gap-2">
                    <span className="mono shrink-0" style={{ color: "var(--muted)" }}>
                      {i + 1}.
                    </span>
                    <div>
                      <div className="font-medium" style={{ color: "var(--text)" }}>
                        {step.rule}
                      </div>
                      <div style={{ color: "var(--muted)" }}>{step.outcome}</div>
                      {step.overrides && (
                        <div className="mt-0.5" style={{ color: "var(--warn)" }}>
                          overrides: {step.overrides}
                        </div>
                      )}
                      {step.citation?.doc_title && (
                        <div className="mt-0.5 mono text-[10px]" style={{ color: "var(--accent)" }}>
                          {step.citation.doc_title}
                          {step.citation.section ? ` — ${step.citation.section}` : ""}
                          {step.citation.tier_label ? ` (${step.citation.tier_label})` : ""}
                        </div>
                      )}
                    </div>
                  </div>
                </li>
              ))}
            </ol>
          )}

          {out?.results && (
            <ul className="space-y-1 mb-2">
              {out.results.map((r, i) => (
                <li key={i} className="mono text-[10px]" style={{ color: "var(--accent)" }}>
                  {r.citation?.doc_title}
                  {r.citation?.section ? ` — ${r.citation.section}` : ""}
                </li>
              ))}
            </ul>
          )}

          <details>
            <summary
              className="text-[11px] cursor-pointer select-none"
              style={{ color: "var(--muted)" }}
            >
              Raw tool call
            </summary>
            <pre
              className="mono text-[10px] mt-2 p-2 rounded overflow-x-auto max-h-72"
              style={{ background: "var(--bg)", color: "var(--muted)" }}
            >
              {JSON.stringify({ input, output }, null, 2)}
            </pre>
          </details>
        </div>
      )}
    </div>
  );
}

function summarise(name: string, input: unknown): string {
  if (!input || typeof input !== "object") return "";
  const o = input as Record<string, unknown>;
  if (name === "search_documents") return String(o.query ?? "");
  const id = o.order_id ?? o.ticket_id ?? o.account ?? o.subject_id;
  if (id) return String(id);
  if (o.kind) return String(o.kind);
  return "";
}
