import Link from "next/link";
import { detectSignals, type Signal, type SignalSeverity } from "@/lib/signals";
import { SNAPSHOT_LABEL, ACCOUNTS, ORDERS, TICKETS } from "@/lib/db";
import { getSession, capabilities } from "@/lib/session";

export const dynamic = "force-dynamic";

const SEVERITY_COLOR: Record<SignalSeverity, string> = {
  critical: "var(--crit)",
  high: "var(--high)",
  medium: "var(--warn)",
  low: "var(--muted)",
};

const KIND_LABEL: Record<Signal["kind"], string> = {
  sla_breach: "SLA breach",
  sla_at_risk: "SLA at risk",
  issue_cluster: "Recurring issue",
  multi_account_issue: "Multi-account issue",
  silent_failure: "Unreported failure",
  stale_status: "Stale status",
  incorrect_history: "Incorrect past guidance",
  security: "Security",
};

export default async function OpsPage({
  searchParams,
}: {
  searchParams: Promise<{ user?: string }>;
}) {
  const { user } = await searchParams;
  const session = getSession(user ?? "manager-priya");

  // The dashboard is an internal surface. A customer session is refused here
  // for the same reason the tools refuse it: authorisation is checked at the
  // data layer, not assumed from the URL.
  if (!capabilities(session).readOpsSignals) {
    return (
      <main className="flex-1 grid place-items-center p-8">
        <div className="panel px-6 py-5 max-w-md text-center">
          <h1 className="font-semibold mb-2">Not authorised</h1>
          <p className="text-sm" style={{ color: "var(--muted)" }}>
            The operations dashboard is available to ParcelPilot support and operations staff only.
            You are signed in as {session.displayName}.
          </p>
          <Link href="/" className="inline-block mt-4 text-sm" style={{ color: "var(--accent)" }}>
            Back to chat
          </Link>
        </div>
      </main>
    );
  }

  const signals = detectSignals();
  const counts = signals.reduce<Record<string, number>>((acc, s) => {
    acc[s.severity] = (acc[s.severity] ?? 0) + 1;
    return acc;
  }, {});

  const openTickets = TICKETS.filter((t) => t.status === "open").length;

  return (
    <main className="flex-1 overflow-y-auto">
      <div className="max-w-5xl mx-auto px-5 py-8">
        <div className="flex items-start gap-4 mb-6 flex-wrap">
          <div>
            <h1 className="text-2xl font-semibold">Operations signals</h1>
            <p className="text-sm mt-1" style={{ color: "var(--muted)" }}>
              What deserves attention across all accounts at {SNAPSHOT_LABEL}. Every signal below is
              computed deterministically and carries its own evidence — no model output.
            </p>
          </div>
          <div className="flex-1" />
          <Link
            href="/"
            className="text-xs px-3 py-1.5 rounded-md border"
            style={{ borderColor: "var(--border)", color: "var(--muted)" }}
          >
            Back to chat
          </Link>
        </div>

        <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 mb-7">
          <Stat label="Critical" value={counts.critical ?? 0} color="var(--crit)" />
          <Stat label="High" value={counts.high ?? 0} color="var(--high)" />
          <Stat label="Open tickets" value={openTickets} color="var(--accent)" />
          <Stat
            label="Accounts / orders"
            value={`${ACCOUNTS.length} / ${ORDERS.length}`}
            color="var(--muted)"
          />
        </div>

        <div className="space-y-3">
          {signals.map((s) => (
            <article key={s.id} className="panel px-4 py-3.5">
              <div className="flex items-center gap-2 mb-1.5 flex-wrap">
                <span
                  className="text-[10px] font-semibold uppercase tracking-wider px-1.5 py-0.5 rounded"
                  style={{ background: SEVERITY_COLOR[s.severity], color: "#06111f" }}
                >
                  {s.severity}
                </span>
                <span className="text-[11px]" style={{ color: "var(--muted)" }}>
                  {KIND_LABEL[s.kind]}
                </span>
                <span className="flex-1" />
                <span className="mono text-[10px]" style={{ color: "var(--muted)" }}>
                  {s.accounts.join(", ")}
                </span>
              </div>

              <h2 className="text-sm font-semibold mb-1">{s.title}</h2>
              <p className="text-[13px] leading-relaxed mb-2.5" style={{ color: "var(--muted)" }}>
                {s.detail}
              </p>

              <div
                className="text-[12px] rounded-lg px-3 py-2 mb-2"
                style={{ background: "var(--bg)" }}
              >
                <span style={{ color: "var(--ok)" }}>Recommended: </span>
                <span style={{ color: "var(--text)" }}>{s.recommended_action}</span>
              </div>

              <div className="flex gap-1.5 flex-wrap">
                {s.evidence.map((e) => (
                  <span
                    key={e}
                    className="mono text-[10px] px-1.5 py-0.5 rounded border"
                    style={{ borderColor: "var(--border)", color: "var(--muted)" }}
                  >
                    {e}
                  </span>
                ))}
                {s.citations?.map((c) => (
                  <span
                    key={c.chunk_id}
                    className="mono text-[10px] px-1.5 py-0.5 rounded border"
                    style={{ borderColor: "var(--accent-dim)", color: "var(--accent)" }}
                  >
                    {c.doc_title} — {c.section}
                  </span>
                ))}
              </div>
            </article>
          ))}
        </div>

        <section className="panel px-4 py-3.5 mt-8">
          <h2 className="text-sm font-semibold mb-2">Assumptions behind these figures</h2>
          <ul className="text-[12px] space-y-1.5" style={{ color: "var(--muted)" }}>
            <li>
              • &quot;Now&quot; is the dataset snapshot, {SNAPSHOT_LABEL} — which falls on a{" "}
              <strong style={{ color: "var(--text)" }}>Sunday</strong>. Targets written as 24x7 run
              through the weekend; targets in business hours do not.
            </li>
            <li>• Business hours are Mon–Fri 09:00–18:00 IST. Public holidays are not modelled.</li>
            <li>
              • A target written without the word &quot;business&quot; is treated as wall-clock, since
              the documents say &quot;business hours&quot; whenever they mean it.
            </li>
            <li>
              • Orders still BOOKED are only flagged once they are past the KI-211 webhook delay
              window, to avoid the false alarm the product guide warns about.
            </li>
          </ul>
        </section>
      </div>
    </main>
  );
}

function Stat({ label, value, color }: { label: string; value: number | string; color: string }) {
  return (
    <div className="panel px-3.5 py-3">
      <div className="text-2xl font-semibold" style={{ color }}>
        {value}
      </div>
      <div className="text-[11px] mt-0.5" style={{ color: "var(--muted)" }}>
        {label}
      </div>
    </div>
  );
}
