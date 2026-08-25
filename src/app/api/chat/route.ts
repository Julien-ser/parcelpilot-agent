import { convertToModelMessages, stepCountIs, streamText, type UIMessage } from "ai";
import { buildTools } from "@/lib/tools";
import { systemPrompt } from "@/lib/prompt";
import { getSession } from "@/lib/session";
import { NoProviderError, explainModelError, resolveModel } from "@/lib/model";

export const maxDuration = 60;

export async function POST(req: Request) {
  let resolved;
  try {
    resolved = resolveModel();
  } catch (err) {
    if (err instanceof NoProviderError) {
      return Response.json({ error: err.message }, { status: 500 });
    }
    throw err;
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

  const result = streamText({
    model: resolved.model,
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
      return explainModelError(message, resolved.provider);
    },
  });
}
