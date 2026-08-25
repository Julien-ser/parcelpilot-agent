/**
 * Model provider resolution.
 *
 * The agent's behaviour lives in the tools and the policy engine, not in any one
 * vendor, so the provider is a configuration choice. Whichever API key is present
 * wins, in the order below.
 *
 * This exists for a practical reason: hosting a demo on a free tier. OpenRouter's
 * free tier is capped at 50 requests/day for accounts with no credit balance, and
 * a single conversation with multi-step tool calling spends several. Google AI
 * Studio and Groq both offer free tiers with daily limits high enough to survive
 * people actually using the deployed app.
 */
import { createOpenRouter } from "@openrouter/ai-sdk-provider";
import { createGoogleGenerativeAI } from "@ai-sdk/google";
import { createGroq } from "@ai-sdk/groq";
import type { LanguageModel } from "ai";

export interface ResolvedModel {
  model: LanguageModel;
  provider: "google" | "groq" | "openrouter";
  modelId: string;
}

export class NoProviderError extends Error {
  constructor() {
    super(
      "No model provider configured. Set one of GOOGLE_GENERATIVE_AI_API_KEY, " +
        "GROQ_API_KEY or OPENROUTER_API_KEY in .env.local (or in the Vercel project).",
    );
  }
}

/**
 * Defaults are chosen for tool-calling reliability on a free tier, not for
 * benchmark scores. Override per provider with *_MODEL.
 */
const DEFAULTS = {
  google: "gemini-2.5-flash",
  groq: "llama-3.3-70b-versatile",
  openrouter: "anthropic/claude-haiku-4.5",
} as const;

export function resolveModel(): ResolvedModel {
  const googleKey = process.env.GOOGLE_GENERATIVE_AI_API_KEY;
  if (googleKey) {
    const modelId = process.env.GOOGLE_MODEL ?? DEFAULTS.google;
    return {
      model: createGoogleGenerativeAI({ apiKey: googleKey })(modelId),
      provider: "google",
      modelId,
    };
  }

  const groqKey = process.env.GROQ_API_KEY;
  if (groqKey) {
    const modelId = process.env.GROQ_MODEL ?? DEFAULTS.groq;
    return {
      model: createGroq({ apiKey: groqKey })(modelId),
      provider: "groq",
      modelId,
    };
  }

  const openrouterKey = process.env.OPENROUTER_API_KEY;
  if (openrouterKey) {
    const modelId = process.env.OPENROUTER_MODEL ?? DEFAULTS.openrouter;
    return {
      model: createOpenRouter({ apiKey: openrouterKey }).chat(modelId),
      provider: "openrouter",
      modelId,
    };
  }

  throw new NoProviderError();
}

/** Turn an upstream failure into something a user can act on. */
export function explainModelError(message: string, provider?: string): string {
  if (/402|insufficient credits/i.test(message)) {
    return "The model provider reports no credit balance. Add credits, or switch provider by setting GOOGLE_GENERATIVE_AI_API_KEY or GROQ_API_KEY.";
  }
  if (/429|rate limit|quota|RESOURCE_EXHAUSTED/i.test(message)) {
    return `${provider ?? "The model provider"} rate limit reached. Free tiers are capped per minute and per day; wait a moment and retry, or configure a different provider.`;
  }
  if (/401|403|API key|unauthenticated|PERMISSION_DENIED/i.test(message)) {
    return "The model provider rejected the API key. Check it is set correctly and enabled for this model.";
  }
  return `Upstream model error: ${message}`;
}
