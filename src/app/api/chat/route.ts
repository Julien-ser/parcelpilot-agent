import { createOpenRouter } from "@openrouter/ai-sdk-provider";
import { convertToModelMessages, stepCountIs, streamText, type UIMessage } from "ai";
import { buildTools } from "@/lib/tools";
import { systemPrompt } from "@/lib/prompt";
import { getSession } from "@/lib/session";

export const maxDuration = 60;

const MODEL = process.env.OPENROUTER_MODEL ?? "anthropic/claude-haiku-4.5";

export async function POST(req: Request) {
  const apiKey = process.env.OPENROUTER_API_KEY;
  if (!apiKey) {
    return Response.json(
      { error: "OPENROUTER_API_KEY is not set. Add it to .env.local or the Vercel project." },
      { status: 500 },
    );
  }

  const body = (await req.json()) as {
    messages: UIMessage[];
    userId?: string;
    /** Action tokens the USER confirmed by clicking Confirm in the interface. */
    confirmedTokens?: string[];
  };

  const session = getSession(body.userId);
  // The confirmation set comes from the client's explicit click, never from the
  // model. buildTools closes over it, so execute_action cannot bypass the gate.
  const confirmed = new Set(body.confirmedTokens ?? []);

  const openrouter = createOpenRouter({ apiKey });

  const result = streamText({
    model: openrouter.chat(MODEL),
    system: systemPrompt(session),
    messages: await convertToModelMessages(body.messages),
    tools: buildTools(session, confirmed),
    // Multi-step: look up the order, resolve the account, read the agreement,
    // check the SOP, compute, then answer - without returning to the user between.
    stopWhen: stepCountIs(10),
    temperature: 0,
    onError: ({ error }) => {
      console.error("[chat] streamText error:", error);
    },
  });

  return result.toUIMessageStreamResponse({
    onError: (error) => {
      const message = error instanceof Error ? error.message : String(error);
      console.error("[chat] stream error:", message);
      if (/402|insufficient credits/i.test(message)) {
        return "The OpenRouter account has no credits. Add credits at openrouter.ai/settings/credits.";
      }
      if (/429|rate limit/i.test(message)) {
        return "OpenRouter rate limit reached for this model. Try again shortly or switch OPENROUTER_MODEL.";
      }
      return `Upstream model error: ${message}`;
    },
  });
}
