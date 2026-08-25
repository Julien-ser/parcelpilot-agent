"use client";

import { useChat } from "@ai-sdk/react";
import { DefaultChatTransport } from "ai";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ArrowUpIcon, CaretDownIcon, DashboardIcon } from "@radix-ui/react-icons";
import { ToolCall } from "./tool-call";
import { ConfirmCard } from "./confirm-card";
import { RichText } from "./rich-text";
import { Logo } from "./brand/logo";
import type { UserOption } from "@/lib/user-options";

const EXAMPLES: Record<string, { label: string; hint: string }[]> = {
  customer: [
    {
      label: "Can I cancel ORD-1001 without a cancellation fee?",
      hint: "contract overrides the standard fee",
    },
    {
      label: "A pickup is three hours late through carrier fault. Do I get a credit?",
      hint: "your agreement sets its own threshold",
    },
    { label: "Show me order ORD-2001", hint: "belongs to another account" },
    { label: "Is bulk upload on my plan, and is there a row limit?", hint: "plan entitlements" },
  ],
  staff: [
    { label: "What needs attention right now?", hint: "ranked operational signals" },
    { label: "Is TKT-501 within SLA? If not, prepare an escalation.", hint: "multi step, then act" },
    { label: "Does ORD-2002 qualify for a service credit?", hint: "contract sets a fixed amount" },
    { label: "Were any past ticket answers wrong?", hint: "contradiction detection" },
  ],
};

export function Chat({ users }: { users: UserOption[] }) {
  const [userId, setUserId] = useState(users[0].id);
  const [input, setInput] = useState("");
  const [confirmed, setConfirmed] = useState<Set<string>>(new Set());
  const [cancelled, setCancelled] = useState<Set<string>>(new Set());

  // Read the latest values at send time without rebuilding the transport.
  const userIdRef = useRef(userId);
  const confirmedRef = useRef(confirmed);
  useEffect(() => {
    userIdRef.current = userId;
  }, [userId]);
  useEffect(() => {
    confirmedRef.current = confirmed;
  }, [confirmed]);

  const transport = useMemo(
    () =>
      new DefaultChatTransport({
        api: "/api/chat",
        prepareSendMessagesRequest: ({ messages }) => ({
          body: {
            messages,
            userId: userIdRef.current,
            confirmedTokens: [...confirmedRef.current],
          },
        }),
      }),
    [],
  );

  const { messages, sendMessage, status, error, setMessages } = useChat({ transport });

  const busy = status === "streaming" || status === "submitted";
  const scrollRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: "smooth" });
  }, [messages, busy]);

  const send = useCallback(
    (text: string) => {
      if (!text.trim() || busy) return;
      setInput("");
      void sendMessage({ text });
    },
    [busy, sendMessage],
  );

  const onConfirm = useCallback(
    (token: string) => {
      // The token enters the confirmed set from the USER's click. The API route
      // reads this set; the model cannot add to it.
      setConfirmed((prev) => {
        const next = new Set(prev);
        next.add(token);
        confirmedRef.current = next;
        return next;
      });
      void sendMessage({ text: "Yes, go ahead." });
    },
    [sendMessage],
  );

  const onCancel = useCallback((token: string) => {
    setCancelled((prev) => new Set(prev).add(token));
  }, []);

  const switchUser = (id: string) => {
    setUserId(id);
    userIdRef.current = id;
    setMessages([]);
    setConfirmed(new Set());
    setCancelled(new Set());
  };

  const current = users.find((u) => u.id === userId)!;
  const isCustomer = current.role === "customer";
  const examples = EXAMPLES[isCustomer ? "customer" : "staff"];

  return (
    <div className="flex flex-col h-[100dvh]">
      <header
        className="shrink-0 border-b backdrop-blur-sm"
        style={{ borderColor: "var(--line)", background: "color-mix(in srgb, var(--bg) 88%, transparent)" }}
      >
        <div className="max-w-[1100px] mx-auto px-5 h-[58px] flex items-center gap-4">
          <Logo subtitle="Support console" />

          <div className="flex-1" />

          <div className="hidden md:flex items-center gap-2 text-[12px]" style={{ color: "var(--muted)" }}>
            <span className="mono tnum">2026-08-16 11:00 IST</span>
            <span style={{ color: "var(--line)" }}>/</span>
            <span>snapshot</span>
          </div>

          <div className="relative">
            <select
              value={userId}
              onChange={(e) => switchUser(e.target.value)}
              aria-label="Signed in as"
              className="press appearance-none pl-3 pr-8 py-2 text-[12.5px] cursor-pointer border rounded-lg"
              style={{
                borderColor: "var(--line)",
                background: "var(--surface)",
                color: "var(--text)",
              }}
            >
              {users.map((u) => (
                <option key={u.id} value={u.id} style={{ background: "var(--surface)" }}>
                  {u.label}
                </option>
              ))}
            </select>
            <CaretDownIcon
              className="absolute right-2.5 top-1/2 -translate-y-1/2 pointer-events-none"
              style={{ color: "var(--muted)" }}
            />
          </div>

          <a
            href="/ops"
            className="press flex items-center gap-1.5 px-3 py-2 text-[12.5px] border rounded-lg"
            style={{ borderColor: "var(--line)", color: "var(--text-2)" }}
          >
            <DashboardIcon />
            <span className="hidden sm:inline">Operations</span>
          </a>
        </div>

        <div
          className="max-w-[1100px] mx-auto px-5 pb-2.5 -mt-0.5 flex items-center gap-2 text-[11.5px]"
          style={{ color: "var(--muted)" }}
        >
          <span
            className="inline-block w-1.5 h-1.5 rounded-full shrink-0"
            style={{ background: isCustomer ? "var(--med)" : "var(--accent)" }}
          />
          {current.scopeNote}
        </div>
      </header>

      <div ref={scrollRef} className="flex-1 min-h-0 overflow-y-auto">
        <div className="max-w-[1100px] mx-auto px-5 py-8">
          {messages.length === 0 && (
            <div className="grid lg:grid-cols-[1fr_1.05fr] gap-x-14 gap-y-8 pt-6 rise">
              <div className="max-w-[40ch]">
                <h1
                  className="text-[30px] leading-[1.12] mb-3"
                  style={{ letterSpacing: "-0.028em", fontWeight: 700 }}
                >
                  {isCustomer ? "Ask about your shipments." : "Investigate anything."}
                </h1>
                <p className="text-[14px] leading-relaxed" style={{ color: "var(--muted)" }}>
                  Answers come from ParcelPilot policies, SOPs, product documentation and the
                  signed agreement on this account. Every fee, credit and response target is
                  computed by a rule engine, not written by the model.
                </p>

                <PrecedenceLadder />
              </div>

              <div className="border-t" style={{ borderColor: "var(--line)" }}>
                {examples.map((q, i) => (
                  <button
                    key={q.label}
                    onClick={() => send(q.label)}
                    className="press group w-full text-left py-3.5 border-b flex items-baseline gap-3 rise"
                    style={{
                      borderColor: "var(--line)",
                      animationDelay: `${80 + i * 55}ms`,
                    }}
                  >
                    <span
                      className="mono text-[10.5px] shrink-0 tnum"
                      style={{ color: "var(--faint)" }}
                    >
                      {String(i + 1).padStart(2, "0")}
                    </span>
                    <span className="flex-1">
                      <span className="block text-[13.5px]" style={{ color: "var(--text)" }}>
                        {q.label}
                      </span>
                      <span className="block text-[11.5px] mt-0.5" style={{ color: "var(--faint)" }}>
                        {q.hint}
                      </span>
                    </span>
                    <ArrowUpIcon
                      className="shrink-0 rotate-45 opacity-0 group-hover:opacity-100 transition-opacity"
                      style={{ color: "var(--accent-text)" }}
                    />
                  </button>
                ))}
              </div>
            </div>
          )}

          {messages.map((m) => (
            <div key={m.id} className="mb-7 rise">
              {m.role === "user" ? (
                <div className="flex justify-end">
                  <div
                    className="px-4 py-2.5 rounded-2xl rounded-br-md max-w-[75%] text-[14px]"
                    style={{
                      background: "var(--surface-2)",
                      border: "1px solid var(--line)",
                      color: "var(--text)",
                    }}
                  >
                    {m.parts
                      .filter((p) => p.type === "text")
                      .map((p, i) => (
                        <span key={i}>{(p as { text: string }).text}</span>
                      ))}
                  </div>
                </div>
              ) : (
                <div className="space-y-2.5">
                  {m.parts.map((part, i) => {
                    if (part.type === "text") {
                      const text = (part as { text: string }).text;
                      if (!text.trim()) return null;
                      return <RichText key={i} text={text} />;
                    }

                    if (part.type.startsWith("tool-")) {
                      const p = part as unknown as {
                        type: string;
                        state: string;
                        input?: unknown;
                        output?: unknown;
                        errorText?: string;
                      };
                      const name = p.type.slice(5);
                      const output = p.output as
                        | { status?: string; action_token?: string }
                        | undefined;

                      if (
                        name === "prepare_action" &&
                        p.state === "output-available" &&
                        output?.status === "awaiting_confirmation"
                      ) {
                        const token = output.action_token!;
                        return (
                          <ConfirmCard
                            key={i}
                            data={p.output as never}
                            confirmed={confirmed.has(token)}
                            cancelled={cancelled.has(token)}
                            disabled={busy}
                            onConfirm={() => onConfirm(token)}
                            onCancel={() => onCancel(token)}
                          />
                        );
                      }

                      return (
                        <ToolCall
                          key={i}
                          name={name}
                          state={p.state}
                          input={p.input}
                          output={p.output}
                          errorText={p.errorText}
                        />
                      );
                    }
                    return null;
                  })}
                </div>
              )}
            </div>
          ))}

          {busy && <Thinking />}

          {error && (
            <div
              className="rounded-lg px-4 py-3 text-[13px] rise"
              style={{
                border: "1px solid color-mix(in srgb, var(--crit) 45%, var(--line))",
                background: "color-mix(in srgb, var(--crit) 7%, var(--surface))",
                color: "var(--text)",
              }}
            >
              <div className="font-medium mb-0.5" style={{ color: "var(--crit)" }}>
                Could not complete that request
              </div>
              {error.message}
            </div>
          )}
        </div>
      </div>

      <div className="shrink-0 border-t" style={{ borderColor: "var(--line)" }}>
        <form
          onSubmit={(e) => {
            e.preventDefault();
            send(input);
          }}
          className="max-w-[1100px] mx-auto px-5 py-4 flex gap-2 items-end"
        >
          <input
            value={input}
            onChange={(e) => setInput(e.target.value)}
            placeholder={
              isCustomer
                ? "Ask about an order, a fee, a credit or your plan"
                : "Ask about a ticket, an account, an SLA or what needs attention"
            }
            className="flex-1 px-4 py-3 text-[14px] rounded-xl border outline-none transition-colors"
            style={{
              borderColor: "var(--line)",
              background: "var(--surface)",
              color: "var(--text)",
            }}
          />
          <button
            type="submit"
            disabled={busy || !input.trim()}
            aria-label="Send message"
            className="press grid place-items-center w-[46px] h-[46px] rounded-xl disabled:opacity-35"
            style={{ background: "var(--accent)", color: "#0b1a14" }}
          >
            <ArrowUpIcon width={19} height={19} />
          </button>
        </form>
      </div>
    </div>
  );
}

/**
 * The precedence ladder.
 *
 * This is the single idea the product turns on, so the empty state says it
 * rather than leaving a hole where a marketing paragraph would go. Rank is
 * carried by weight and position, not by four competing colours.
 */
const PRECEDENCE = [
  { rank: "01", label: "Signed customer agreement", note: "wins outright" },
  { rank: "02", label: "Current policy and SOPs", note: "" },
  { rank: "03", label: "Product documentation", note: "" },
  { rank: "04", label: "Past ticket resolutions", note: "context only, may be wrong" },
];

function PrecedenceLadder() {
  return (
    <div className="mt-9">
      <div
        className="text-[10.5px] uppercase tracking-[0.09em] mb-3"
        style={{ color: "var(--faint)" }}
      >
        When sources disagree
      </div>
      <ol className="space-y-[7px]">
        {PRECEDENCE.map((p, i) => {
          const last = i === PRECEDENCE.length - 1;
          return (
            <li key={p.rank} className="flex items-baseline gap-3 rise" style={{ animationDelay: `${140 + i * 60}ms` }}>
              <span className="mono text-[10px] tnum shrink-0" style={{ color: "var(--faint)" }}>
                {p.rank}
              </span>
              <span
                className="text-[12.5px]"
                style={{
                  color: last ? "var(--faint)" : i === 0 ? "var(--text)" : "var(--text-2)",
                  textDecoration: last ? "line-through" : undefined,
                  textDecorationColor: "var(--line)",
                }}
              >
                {p.label}
              </span>
              {p.note ? (
                <span className="text-[11px]" style={{ color: "var(--faint)" }}>
                  {p.note}
                </span>
              ) : null}
            </li>
          );
        })}
      </ol>
    </div>
  );
}

/** Skeleton rather than a spinner, so the layout does not jump when text arrives. */
function Thinking() {
  return (
    <div className="space-y-2 rise" aria-live="polite">
      <div className="flex items-center gap-2 text-[12px]" style={{ color: "var(--muted)" }}>
        <span
          className="breathe inline-block w-1.5 h-1.5 rounded-full"
          style={{ background: "var(--accent)" }}
        />
        Working through the sources
      </div>
      <div className="shimmer h-3 rounded w-[62%]" />
      <div className="shimmer h-3 rounded w-[44%]" />
    </div>
  );
}
