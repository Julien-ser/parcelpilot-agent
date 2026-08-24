"use client";

/**
 * The confirmation gate, rendered from a prepare_action result.
 *
 * Clicking Confirm is what adds the action token to the set the API route
 * trusts. Until that happens, execute_action is refused server-side - so this
 * card is a real gate, not a courtesy prompt.
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
  create_followup_task: "Create follow-up task",
  issue_service_credit: "Issue service credit",
};

export function ConfirmCard({ data, confirmed, cancelled, disabled, onConfirm, onCancel }: Props) {
  const { action, warnings } = data;
  const settled = confirmed || cancelled;

  return (
    <div
      className="panel overflow-hidden"
      style={{ borderColor: confirmed ? "var(--ok)" : cancelled ? "var(--border)" : "var(--warn)" }}
    >
      <div
        className="px-4 py-2.5 flex items-center gap-2 border-b"
        style={{
          borderColor: "var(--border)",
          background: "var(--panel-2)",
        }}
      >
        <span
          className="w-1.5 h-1.5 rounded-full"
          style={{ background: confirmed ? "var(--ok)" : cancelled ? "var(--muted)" : "var(--warn)" }}
        />
        <span className="text-sm font-semibold">
          {TITLES[action.type] ?? action.type} — {action.subject_id}
        </span>
        <span className="flex-1" />
        <span className="text-[11px]" style={{ color: "var(--muted)" }}>
          {confirmed ? "confirmed" : cancelled ? "cancelled" : "needs your approval"}
        </span>
      </div>

      <div className="px-4 py-3 space-y-3">
        <p className="text-sm">{action.summary}</p>

        <div className="rounded-lg p-3" style={{ background: "var(--bg)" }}>
          <div className="text-[11px] mb-1.5 uppercase tracking-wide" style={{ color: "var(--muted)" }}>
            Exactly what will change
          </div>
          <dl className="space-y-1">
            {Object.entries(action.changes).map(([k, v]) => (
              <div key={k} className="flex gap-2 text-xs">
                <dt className="mono" style={{ color: "var(--muted)" }}>
                  {k}
                </dt>
                <dd className="mono" style={{ color: "var(--text)" }}>
                  {v === null ? "—" : String(v)}
                </dd>
              </div>
            ))}
          </dl>
        </div>

        <div className="text-xs" style={{ color: "var(--muted)" }}>
          <span style={{ color: "var(--text)" }}>Why: </span>
          {action.justification}
        </div>

        {warnings.map((w) => (
          <div key={w} className="text-xs flex gap-1.5" style={{ color: "var(--warn)" }}>
            <span>!</span>
            <span>{w}</span>
          </div>
        ))}

        {!settled && (
          <div className="flex gap-2 pt-1">
            <button
              onClick={onConfirm}
              disabled={disabled}
              className="px-4 py-2 rounded-lg text-sm font-medium disabled:opacity-40 transition"
              style={{ background: "var(--ok)", color: "#06111f" }}
            >
              Confirm
            </button>
            <button
              onClick={onCancel}
              disabled={disabled}
              className="px-4 py-2 rounded-lg text-sm border disabled:opacity-40 transition"
              style={{ borderColor: "var(--border)", color: "var(--muted)" }}
            >
              Cancel
            </button>
          </div>
        )}

        {cancelled && (
          <p className="text-xs" style={{ color: "var(--muted)" }}>
            Cancelled. Nothing was changed.
          </p>
        )}
      </div>
    </div>
  );
}
