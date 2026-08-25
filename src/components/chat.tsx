"use client";

import { useChat } from "@ai-sdk/react";
import { DefaultChatTransport } from "ai";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ToolCall } from "./tool-call";
import { ConfirmCard } from "./confirm-card";
import { RichText } from "./rich-text";
import type { UserOption } from "@/lib/user-options";

const EXAMPLES: Record<string, string[]> = {
  customer: [
    "Can I cancel ORD-1001 without a cancellation fee? Explain why.",
    "A pickup is three hours late because of carrier fault. Should I get a service credit?",
    "Can I see ORD-2001?",
    "Is bulk upload included on my plan, and is there a row limit?",
  ],
  staff: [
    "What needs attention right now?",
    "Is TKT-501 within SLA? If not, prepare an escalation.",
    "Does ORD-2002 qualify for a service credit, and how much?",
    "Were any past ticket answers wrong?",
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
  const examples = EXAMPLES[current.role === "customer" ? "customer" : "staff"];

  return (
    <div className="flex flex-col h-screen">
      <header className="border-b" style={{ borderColor: "var(--border)" }}>
        <div className="max-w-5xl mx-auto px-5 py-3 flex items-center gap-4 flex-wrap">
          <div className="flex items-center gap-2.5">
            <div
              className="w-7 h-7 rounded-md grid place-items-center text-sm font-bold"
              style={{ background: "var(--accent-dim)", color: "var(--accent)" }}
            >
              PP
            </div>
            <div>
              <div className="font-semibold leading-tight">ParcelPilot Support</div>
              <div className="text-[11px] leading-tight" style={{ color: "var(--muted)" }}>
                Snapshot 2026-08-16 11:00 IST
              </div>
            </div>
          </div>

          <div className="flex-1" />

          <label className="flex items-center gap-2 text-xs" style={{ color: "var(--muted)" }}>
            Signed in as
            <select
              value={userId}
              onChange={(e) => switchUser(e.target.value)}
              className="panel px-2.5 py-1.5 text-xs outline-none cursor-pointer"
              style={{ color: "var(--text)" }}
            >
              {users.map((u) => (
                <option key={u.id} value={u.id} style={{ background: "var(--panel)" }}>
                  {u.label}
                </option>
              ))}
            </select>
          </label>

          <a
            href="/ops"
            className="text-xs px-3 py-1.5 rounded-md border transition-colors"
            style={{ borderColor: "var(--border)", color: "var(--muted)" }}
          >
            Ops dashboard
          </a>
        </div>

        <div
          className="max-w-5xl mx-auto px-5 pb-2.5 text-[11px] flex items-center gap-2"
          style={{ color: "var(--muted)" }}
        >
          <span
            className="inline-block w-1.5 h-1.5 rounded-full"
            style={{ background: current.role === "customer" ? "var(--warn)" : "var(--ok)" }}
          />
          {current.scopeNote}
        </div>
      </header>

      <div ref={scrollRef} className="flex-1 min-h-0 overflow-y-auto">
        <div className="max-w-5xl mx-auto px-5 py-6">
          {messages.length === 0 && (
            <div className="mt-6">
              <h1 className="text-2xl font-semibold mb-1.5">
                {current.role === "customer" ? "How can we help?" : "What do you need to look into?"}
              </h1>
              <p className="text-sm mb-6" style={{ color: "var(--muted)" }}>
                Answers come from ParcelPilot&apos;s policies, SOPs, product docs and your account&apos;s
                signed agreement. Every fee, credit and SLA figure is computed by a rule engine, not
                by the model.
              </p>
              <div className="grid sm:grid-cols-2 gap-2">
                {examples.map((q) => (
                  <button
                    key={q}
                    onClick={() => send(q)}
                    className="panel text-left px-3.5 py-3 text-sm hover:brightness-125 transition"
                  >
                    {q}
                  </button>
                ))}
              </div>
            </div>
          )}

          {messages.map((m) => (
            <div key={m.id} className="mb-5 slide-in">
              {m.role === "user" ? (
                <div className="flex justify-end">
                  <div
                    className="px-3.5 py-2.5 rounded-xl rounded-br-sm max-w-[80%] text-sm"
                    style={{ background: "var(--accent-dim)" }}
                  >
                    {m.parts
                      .filter((p) => p.type === "text")
                      .map((p, i) => (
                        <span key={i}>{(p as { text: string }).text}</span>
                      ))}
                  </div>
                </div>
              ) : (
                <div className="space-y-2">
                  {m.parts.map((part, i) => {
                    if (part.type === "text") {
                      return <RichText key={i} text={(part as { text: string }).text} />;
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

          {busy && (
            <div className="flex items-center gap-2 text-xs" style={{ color: "var(--muted)" }}>
              <span className="pulse">Working</span>
              <span className="pulse">•</span>
            </div>
          )}

          {error && (
            <div
              className="panel px-4 py-3 text-sm"
              style={{ borderColor: "var(--crit)", color: "var(--crit)" }}
            >
              {error.message}
            </div>
          )}
        </div>
      </div>

      <div className="border-t" style={{ borderColor: "var(--border)" }}>
        <form
          onSubmit={(e) => {
            e.preventDefault();
            send(input);
          }}
          className="max-w-5xl mx-auto px-5 py-4 flex gap-2"
        >
          <input
            value={input}
            onChange={(e) => setInput(e.target.value)}
            placeholder={
              current.role === "customer"
                ? "Ask about an order, a fee, a credit or your plan…"
                : "Ask about a ticket, an account, SLAs or what needs attention…"
            }
            className="flex-1 panel px-4 py-3 text-sm outline-none focus:brightness-125"
            style={{ color: "var(--text)" }}
          />
          <button
            type="submit"
            disabled={busy || !input.trim()}
            className="px-5 py-3 rounded-xl text-sm font-medium disabled:opacity-40 transition"
            style={{ background: "var(--accent)", color: "#06111f" }}
          >
            Send
          </button>
        </form>
      </div>
    </div>
  );
}
