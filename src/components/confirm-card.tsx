"use client";

import { CheckCircledIcon, ExclamationTriangleIcon } from "@radix-ui/react-icons";

/**
 * The confirmation gate, rendered from a prepare_action result.
 *
 * Clicking Confirm is what puts the action token into the set the API route
 * trusts. Until then execute_action is refused server side, so this is a real
 * gate rather than a courtesy prompt.
 */
interface Props {
  data: {
    action_token: string;
    confirmation_prompt: string;
    warnings: string[];
    action: {
      type: string;
      subject_id: string;
      summary: string;
      justification: string;
      changes: Record<string, string | number | boolean | null>;
    };
  };
  confirmed: boolean;
  cancelled: boolean;
  disabled: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}

const TITLES: Record<string, string> = {
  create_escalation: "Create escalation",
  update_ticket: "Update ticket",
  create_followup_task: "Create follow up task",
  issue_service_credit: "Issue service credit",
};

export function ConfirmCard({ data, confirmed, cancelled, disabled, onConfirm, onCancel }: Props) {
  const { action, warnings } = data;
  const settled = confirmed || cancelled;

  const rail = confirmed ? "var(--accent)" : cancelled ? "var(--faint)" : "var(--med)";

  return (
    <div
      className="rise rounded-xl overflow-hidden flex"
      style={{ border: "1px solid var(--line)", background: "var(--surface)" }}
    >
      <span className="w-[3px] shrink-0" style={{ background: rail }} />

      <div className="flex-1 min-w-0">
        <div
          className="px-4 py-2.5 flex items-center gap-2 border-b"
          style={{ borderColor: "var(--line)" }}
        >
          <span className="text-[13px]" style={{ fontWeight: 600 }}>
            {TITLES[action.type] ?? action.type}
          </span>
          <span className="mono text-[11px]" style={{ color: "var(--faint)" }}>
            {action.subject_id}
          </span>
          <span className="flex-1" />
          <span
            className="text-[10.5px] uppercase tracking-wider"
            style={{ color: confirmed ? "var(--accent-text)" : cancelled ? "var(--faint)" : "var(--med)" }}
          >
            {confirmed ? "executed" : cancelled ? "cancelled" : "awaiting approval"}
          </span>
        </div>

        <div className="px-4 py-3.5 space-y-3.5">
          <p className="text-[13.5px]" style={{ color: "var(--text-2)" }}>
            {action.summary}
          </p>

          <div>
            <div
              className="text-[10.5px] uppercase tracking-wider mb-1.5"
              style={{ color: "var(--faint)" }}
            >
              Exactly what changes
            </div>
            <dl className="divide-y" style={{ borderColor: "var(--line-soft)" }}>
              {Object.entries(action.changes).map(([k, v]) => (
                <div key={k} className="flex items-baseline gap-3 py-1.5">
                  <dt className="mono text-[11.5px] w-[46%] shrink-0" style={{ color: "var(--muted)" }}>
                    {k}
                  </dt>
                  <dd className="mono text-[11.5px] tnum" style={{ color: "var(--text)" }}>
                    {v === null ? "not set" : String(v)}
                  </dd>
                </div>
              ))}
            </dl>
          </div>

          <p className="text-[12.5px] leading-relaxed" style={{ color: "var(--muted)" }}>
            <span style={{ color: "var(--text-2)" }}>Why: </span>
            {action.justification}
          </p>

          {warnings.map((w) => (
            <div
              key={w}
              className="flex items-start gap-2 text-[12px] rounded-lg px-3 py-2"
              style={{
                color: "var(--med)",
                background: "color-mix(in srgb, var(--med) 8%, transparent)",
              }}
            >
              <ExclamationTriangleIcon className="mt-[2px] shrink-0" />
              <span>{w}</span>
            </div>
          ))}

          {!settled && (
            <div className="flex gap-2 pt-0.5">
              <button
                onClick={onConfirm}
                disabled={disabled}
                className="press px-4 py-2 rounded-lg text-[13px] disabled:opacity-35"
                style={{ background: "var(--accent)", color: "#0b1a14", fontWeight: 600 }}
              >
                Confirm
              </button>
              <button
                onClick={onCancel}
                disabled={disabled}
                className="press px-4 py-2 rounded-lg text-[13px] border disabled:opacity-35"
                style={{ borderColor: "var(--line)", color: "var(--text-2)" }}
              >
                Cancel
              </button>
            </div>
          )}

          {confirmed && (
            <div className="flex items-center gap-1.5 text-[12px]" style={{ color: "var(--accent-text)" }}>
              <CheckCircledIcon />
              Approved by you. The action tool accepted the signed token.
            </div>
          )}
          {cancelled && (
            <p className="text-[12px]" style={{ color: "var(--faint)" }}>
              Cancelled. Nothing was changed.
            </p>
          )}
        </div>
      </div>
    </div>
  );
}
