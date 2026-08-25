import Link from "next/link";
import { ArrowLeftIcon } from "@radix-ui/react-icons";
import { detectSignals, type Signal, type SignalSeverity } from "@/lib/signals";
import { SNAPSHOT_LABEL, ACCOUNTS, ORDERS, TICKETS } from "@/lib/db";
import { getSession, capabilities } from "@/lib/session";
import { Logo } from "@/components/brand/logo";

export const dynamic = "force-dynamic";

const SEVERITY_COLOR: Record<SignalSeverity, string> = {
  critical: "var(--crit)",
  high: "var(--high)",
  medium: "var(--med)",
  low: "var(--low)",
};

const KIND_LABEL: Record<Signal["kind"], string> = {
  sla_breach: "Response target breached",
  sla_at_risk: "Response target at risk",
  issue_cluster: "Recurring issue",
  multi_account_issue: "Multiple accounts affected",
  silent_failure: "Owed but unreported",
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

  // Authorisation is checked here for the same reason the tools check it: the
  // URL is not evidence of anything.
  if (!capabilities(session).readOpsSignals) {
    return (
      <main className="flex-1 grid place-items-center p-8">
        <div className="surface px-7 py-6 max-w-sm">
          <h1 className="text-[15px] mb-2" style={{ fontWeight: 600 }}>
            Not authorised
          </h1>
          <p className="text-[13px] leading-relaxed" style={{ color: "var(--muted)" }}>
            The operations console is limited to ParcelPilot support and operations staff. You are
            signed in as {session.displayName}.
          </p>
          <Link
            href="/"
            className="press inline-flex items-center gap-1.5 mt-4 text-[13px]"
            style={{ color: "var(--accent-text)" }}
          >
            <ArrowLeftIcon />
            Back to console
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
      <header className="border-b" style={{ borderColor: "var(--line)" }}>
        <div className="max-w-[1100px] mx-auto px-5 h-[58px] flex items-center gap-4">
          <Logo subtitle="Operations" />
          <div className="flex-1" />
          <Link
            href="/"
            className="press flex items-center gap-1.5 px-3 py-2 text-[12.5px] border rounded-lg"
            style={{ borderColor: "var(--line)", color: "var(--text-2)" }}
          >
            <ArrowLeftIcon />
            Console
          </Link>
        </div>
      </header>

      <div className="max-w-[1100px] mx-auto px-5 py-9">
        <div className="grid lg:grid-cols-[1fr_auto] gap-x-12 gap-y-6 items-end mb-9">
          <div className="max-w-[52ch]">
            <h1
              className="text-[27px] leading-[1.15] mb-2.5"
              style={{ letterSpacing: "-0.028em", fontWeight: 700 }}
            >
              What deserves attention
            </h1>
            <p className="text-[13.5px] leading-relaxed" style={{ color: "var(--muted)" }}>
              Across every account at{" "}
              <span className="mono tnum" style={{ color: "var(--text-2)" }}>
                {SNAPSHOT_LABEL}
              </span>
              . Each signal below is computed deterministically and carries its own evidence. No
              model output appears on this page.
            </p>
          </div>

          {/* Metrics without boxes: the rules do the grouping. */}
          <dl className="flex divide-x" style={{ borderColor: "var(--line)" }}>
            <Stat label="Critical" value={counts.critical ?? 0} color="var(--crit)" first />
            <Stat label="High" value={counts.high ?? 0} color="var(--high)" />
            <Stat label="Open" value={openTickets} color="var(--text)" />
            <Stat label="Accounts" value={ACCOUNTS.length} color="var(--text)" />
            <Stat label="Orders" value={ORDERS.length} color="var(--text)" />
          </dl>
        </div>

        <ol className="border-t" style={{ borderColor: "var(--line)" }}>
          {signals.map((s, i) => (
            <li
              key={s.id}
              className="border-b rise"
              style={{ borderColor: "var(--line)", animationDelay: `${i * 40}ms` }}
            >
              <article className="flex gap-4 py-5">
                <span
                  className="w-[3px] rounded-full shrink-0"
                  style={{ background: SEVERITY_COLOR[s.severity] }}
                  aria-hidden="true"
                />

                <div className="flex-1 min-w-0">
                  <div className="flex items-baseline gap-2.5 mb-1.5 flex-wrap">
                    <span
                      className="mono text-[10px] uppercase tracking-[0.09em]"
                      style={{ color: SEVERITY_COLOR[s.severity] }}
                    >
                      {s.severity}
                    </span>
                    <span className="text-[11.5px]" style={{ color: "var(--faint)" }}>
                      {KIND_LABEL[s.kind]}
                    </span>
                    <span className="flex-1" />
                    <span className="mono text-[10.5px]" style={{ color: "var(--faint)" }}>
                      {s.accounts.join("  ")}
                    </span>
                  </div>

                  <h2 className="text-[14.5px] mb-1.5" style={{ fontWeight: 600 }}>
                    {s.title}
                  </h2>
                  <p
                    className="text-[13px] leading-relaxed mb-3 max-w-[80ch]"
                    style={{ color: "var(--muted)" }}
                  >
                    {s.detail}
                  </p>

                  <p className="text-[13px] mb-3 max-w-[80ch]">
                    <span style={{ color: "var(--accent-text)" }}>Do next. </span>
                    <span style={{ color: "var(--text-2)" }}>{s.recommended_action}</span>
                  </p>

                  <div className="flex gap-1.5 flex-wrap">
                    {s.evidence.map((e) => (
                      <span
                        key={e}
                        className="mono text-[10px] px-1.5 py-[3px] rounded border"
                        style={{ borderColor: "var(--line)", color: "var(--muted)" }}
                      >
                        {e}
                      </span>
                    ))}
                    {s.citations?.map((c) => (
                      <span
                        key={c.chunk_id}
                        className="mono text-[10px] px-1.5 py-[3px] rounded border"
                        style={{
                          borderColor: "color-mix(in srgb, var(--accent) 28%, var(--line))",
                          color: "var(--accent-text)",
                        }}
                      >
                        {c.doc_title} / {c.section}
                      </span>
                    ))}
                  </div>
                </div>
              </article>
            </li>
          ))}
        </ol>

        <section className="mt-10 pt-6 border-t" style={{ borderColor: "var(--line)" }}>
          <h2
            className="text-[10.5px] uppercase tracking-[0.09em] mb-3"
            style={{ color: "var(--faint)" }}
          >
            Assumptions behind these figures
          </h2>
          <ul className="grid md:grid-cols-2 gap-x-10 gap-y-2.5 text-[12.5px] leading-relaxed max-w-[86ch]" style={{ color: "var(--muted)" }}>
            <li>
              Now is the dataset snapshot,{" "}
              <span className="mono tnum" style={{ color: "var(--text-2)" }}>
                {SNAPSHOT_LABEL}
              </span>
              , which falls on a <strong style={{ color: "var(--text)" }}>Sunday</strong>. Targets
              written as 24x7 run through the weekend. Targets in business hours do not.
            </li>
            <li>
              Business hours are Monday to Friday, 09:00 to 18:00 IST. Public holidays are not
              modelled.
            </li>
            <li>
              A target written without the word business is treated as wall clock, since the
              documents say business hours whenever they mean it.
            </li>
            <li>
              Orders still showing BOOKED are flagged only once past the KI-211 webhook delay
              window, to avoid the false alarm the product guide warns about.
            </li>
          </ul>
        </section>
      </div>
    </main>
  );
}

function Stat({
  label,
  value,
  color,
  first,
}: {
  label: string;
  value: number;
  color: string;
  first?: boolean;
}) {
  return (
    <div className={first ? "pr-5" : "px-5"} style={{ borderColor: "var(--line)" }}>
      <dd className="mono tnum text-[25px] leading-none" style={{ color }}>
        {value}
      </dd>
      <dt
        className="text-[10.5px] uppercase tracking-[0.09em] mt-2"
        style={{ color: "var(--faint)" }}
      >
        {label}
      </dt>
    </div>
  );
}
