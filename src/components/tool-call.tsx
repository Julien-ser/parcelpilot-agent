"use client";

import { useState } from "react";
import {
  CheckIcon,
  ChevronDownIcon,
  CrossCircledIcon,
  FileTextIcon,
  GearIcon,
  LayersIcon,
  LightningBoltIcon,
} from "@radix-ui/react-icons";

/** Labels read as intent. Nobody outside the codebase cares about function names. */
const LABELS: Record<string, string> = {
  search_documents: "Searching policies and agreements",
  get_order: "Reading order",
  get_ticket: "Reading ticket",
  get_account: "Reading account",
  list_records: "Listing records",
  evaluate_cancellation: "Applying cancellation rules",
  evaluate_service_credit: "Applying service credit rules",
  evaluate_sla: "Checking response target",
  get_ops_signals: "Scanning support activity",
  prepare_action: "Preparing action",
  execute_action: "Executing action",
};

type Kind = "doc" | "data" | "policy" | "action";

const KIND: Record<string, Kind> = {
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

const ICONS: Record<Kind, typeof FileTextIcon> = {
  doc: FileTextIcon,
  data: LayersIcon,
  policy: GearIcon,
  action: LightningBoltIcon,
};

interface TraceStep {
  rule: string;
  outcome: string;
  overrides?: string;
  citation?: { doc_title?: string; section?: string; tier_label?: string; status?: string };
}

interface Props {
  name: string;
  state: string;
  input?: unknown;
  output?: unknown;
  errorText?: string;
}

export function ToolCall({ name, state, input, output, errorText }: Props) {
  const [open, setOpen] = useState(false);
  const kind = KIND[name] ?? "data";
  const Icon = ICONS[kind];
  const running = state === "input-streaming" || state === "input-available";

  const out = output as
    | {
        trace?: TraceStep[];
        error?: string;
        results?: { citation?: { doc_title?: string; section?: string } }[];
      }
    | undefined;

  const blocked = Boolean(out?.error) || state === "output-error";
  const subject = summarise(name, input);
  const traceCount = out?.trace?.length ?? 0;
  const hitCount = out?.results?.length ?? 0;

  return (
    <div className="flex gap-3">
      {/* Connector rail: makes a sequence of calls read as one chain of work. */}
      <div className="flex flex-col items-center pt-[3px] shrink-0">
        <span
          className={`grid place-items-center w-[22px] h-[22px] rounded-md border ${running ? "breathe" : ""}`}
          style={{
            borderColor: blocked ? "color-mix(in srgb, var(--crit) 50%, var(--line))" : "var(--line)",
            background: "var(--surface)",
            color: blocked ? "var(--crit)" : running ? "var(--muted)" : "var(--accent-text)",
          }}
        >
          {blocked ? <CrossCircledIcon width={12} /> : running ? <Icon width={12} /> : <CheckIcon width={13} />}
        </span>
        <span className="flex-1 w-px mt-1" style={{ background: "var(--line-soft)" }} />
      </div>

      <div className="flex-1 min-w-0 pb-1">
        <button
          onClick={() => setOpen((v) => !v)}
          className="press group flex items-baseline gap-2 text-left w-full"
          aria-expanded={open}
        >
          <span className="text-[12.5px]" style={{ color: blocked ? "var(--crit)" : "var(--text-2)" }}>
            {LABELS[name] ?? name}
          </span>
          {subject ? (
            <span className="mono text-[11px] truncate" style={{ color: "var(--faint)" }}>
              {subject}
            </span>
          ) : null}
          <span className="flex-1" />
          {blocked ? (
            <span className="text-[10.5px] uppercase tracking-wide" style={{ color: "var(--crit)" }}>
              refused
            </span>
          ) : traceCount || hitCount ? (
            <span
              className="mono text-[10.5px] tnum flex items-center gap-1"
              style={{ color: "var(--faint)" }}
            >
              {traceCount ? `${traceCount} rules` : `${hitCount} sources`}
              <ChevronDownIcon
                className="transition-transform"
                style={{ transform: open ? "rotate(180deg)" : "none" }}
              />
            </span>
          ) : null}
        </button>

        {out?.error ? (
          <p className="text-[12px] mt-1" style={{ color: "var(--muted)" }}>
            {out.error}
          </p>
        ) : null}
        {errorText ? (
          <p className="text-[12px] mt-1" style={{ color: "var(--crit)" }}>
            {errorText}
          </p>
        ) : null}

        {open && (
          <div className="mt-2.5 space-y-2.5 rise">
            {/* The rule trace is the point of the system, so it leads. */}
            {out?.trace?.map((step, i) => (
              <div
                key={i}
                className="pl-3 border-l"
                style={{ borderColor: "var(--line)" }}
              >
                <div className="text-[12px]" style={{ color: "var(--text)" }}>
                  {step.rule}
                </div>
                <div className="text-[12px] leading-relaxed mt-0.5" style={{ color: "var(--muted)" }}>
                  {step.outcome}
                </div>
                {step.overrides ? (
                  <div className="text-[11.5px] mt-1" style={{ color: "var(--high)" }}>
                    displaces {step.overrides}
                  </div>
                ) : null}
                {step.citation?.doc_title ? (
                  <div className="mono text-[10.5px] mt-1" style={{ color: "var(--accent-text)" }}>
                    {step.citation.doc_title}
                    {step.citation.section ? ` / ${step.citation.section}` : ""}
                  </div>
                ) : null}
              </div>
            ))}

            {out?.results?.map((r, i) => (
              <div key={i} className="mono text-[10.5px] pl-3 border-l" style={{ borderColor: "var(--line)", color: "var(--accent-text)" }}>
                {r.citation?.doc_title}
                {r.citation?.section ? ` / ${r.citation.section}` : ""}
              </div>
            ))}

            <details>
              <summary
                className="text-[11px] cursor-pointer select-none list-none"
                style={{ color: "var(--faint)" }}
              >
                Raw call
              </summary>
              <pre
                className="mono text-[10.5px] mt-2 p-3 rounded-lg overflow-x-auto max-h-72"
                style={{ background: "var(--bg)", border: "1px solid var(--line)", color: "var(--muted)" }}
              >
                {JSON.stringify({ input, output }, null, 2)}
              </pre>
            </details>
          </div>
        )}
      </div>
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
