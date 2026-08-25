/**
 * Model provider resolution, with failover.
 *
 * The agent's behaviour lives in the tools and the policy engine, not in any one
 * vendor, so the provider is configuration. Whichever API keys are present are
 * assembled into an ordered chain.
 *
 * Failover exists because free tiers run out in different, uncorrelated ways:
 * Groq caps tokens per day, Google caps requests per minute. A single question
 * spends three or four requests on multi-step tool calls, so a demo leaning on
 * one provider stalls partway through an answer. The chain is wired at the model
 * level rather than the request level, which matters: `streamText` issues one
 * call per step, so a provider that runs out between the tool call and the final
 * answer is stepped over without losing the work already done.
 */
import { createOpenRouter } from "@openrouter/ai-sdk-provider";
import { createGoogleGenerativeAI } from "@ai-sdk/google";
import { createGroq } from "@ai-sdk/groq";
import { wrapLanguageModel, type LanguageModel } from "ai";
import type { LanguageModelV4 } from "@ai-sdk/provider";

export type ProviderName = "google" | "groq" | "openrouter";

export interface ResolvedModel {
  model: LanguageModel;
  provider: ProviderName;
  modelId: string;
  /** Providers standing by as failover, in order. */
  fallbacks: string[];
}

export class NoProviderError extends Error {
  constructor() {
    super(
      "No model provider configured. Set one of GROQ_API_KEY, " +
        "GOOGLE_GENERATIVE_AI_API_KEY or OPENROUTER_API_KEY in .env.local (or in the Vercel project).",
    );
  }
}

/**
 * The chain, in order. Chosen from measured free-tier limits rather than
 * benchmark scores, because an answer from a slightly weaker model beats a rate
 * limit error from a better one.
 *
 * Groq leads: the largest practical budget of the three, and the best tool
 * calling of what is free.
 *
 * Google contributes TWO entries, and the order matters. gemini-3.6-flash is the
 * stronger model but its free tier allows only 20 requests PER DAY
 * (GenerateRequestsPerDayPerProjectPerModel-FreeTier), which is roughly five
 * questions. gemini-2.5-flash is weaker on nuance but has real daily headroom,
 * so it sits behind 3.6 as the one that keeps a demo alive.
 */
const DEFAULTS: Record<ProviderName, string> = {
  groq: "openai/gpt-oss-120b",
  google: "gemini-3.6-flash",
  openrouter: "anthropic/claude-haiku-4.5",
};

/** Extra models tried after a provider's primary model is spent. */
const SECONDARY: Partial<Record<ProviderName, string[]>> = {
  google: ["gemini-2.5-flash"],
};

const ORDER: ProviderName[] = ["groq", "google", "openrouter"];

interface Candidate {
  provider: ProviderName;
  modelId: string;
  model: LanguageModelV4;
}

/** A provider's primary model plus any secondary models, in order. */
function buildAll(provider: ProviderName): Candidate[] {
  const primary = build(provider);
  if (!primary) return [];
  const extras = (SECONDARY[provider] ?? [])
    .map((modelId) => build(provider, modelId))
    .filter((c): c is Candidate => c !== null);
  return [primary, ...extras];
}

function build(provider: ProviderName, overrideModelId?: string): Candidate | null {
  switch (provider) {
    case "groq": {
      const key = process.env.GROQ_API_KEY;
      if (!key) return null;
      const modelId = overrideModelId ?? process.env.GROQ_MODEL ?? DEFAULTS.groq;
      return { provider, modelId, model: createGroq({ apiKey: key })(modelId) as LanguageModelV4 };
    }
    case "google": {
      const key = process.env.GOOGLE_GENERATIVE_AI_API_KEY;
      if (!key) return null;
      const modelId = overrideModelId ?? process.env.GOOGLE_MODEL ?? DEFAULTS.google;
      return {
        provider,
        modelId,
        model: createGoogleGenerativeAI({ apiKey: key })(modelId) as LanguageModelV4,
      };
    }
    case "openrouter": {
      const key = process.env.OPENROUTER_API_KEY;
      if (!key) return null;
      const modelId = overrideModelId ?? process.env.OPENROUTER_MODEL ?? DEFAULTS.openrouter;
      return {
        provider,
        modelId,
        model: createOpenRouter({ apiKey: key }).chat(modelId) as unknown as LanguageModelV4,
      };
    }
  }
}

/**
 * Only step over a provider for a failure another provider could plausibly
 * survive. A malformed request fails identically everywhere, and retrying it
 * across the chain just burns three quotas and buries the real error.
 */
export function isExhaustion(err: unknown): boolean {
  const message = err instanceof Error ? err.message : String(err);
  const status =
    (err as { statusCode?: number })?.statusCode ?? (err as { status?: number })?.status;
  if (status === 429 || status === 402 || (typeof status === "number" && status >= 500)) return true;
  return /429|402|rate.?limit|quota|RESOURCE_EXHAUSTED|insufficient credits|overloaded|capacity|temporarily unavailable|ECONNRESET|ETIMEDOUT/i.test(
    message,
  );
}

export function resolveModel(): ResolvedModel {
  const forced = process.env.MODEL_PROVIDER?.toLowerCase() as ProviderName | undefined;

  const available = ORDER.flatMap(buildAll);
  if (available.length === 0) throw new NoProviderError();

  // A forced provider leads the chain but does not remove the safety net.
  const chain = forced
    ? [
        ...available.filter((c) => c.provider === forced),
        ...available.filter((c) => c.provider !== forced),
      ]
    : available;

  const [primary, ...rest] = chain;

  return {
    model: withFallback(primary.model, rest.map((c) => c.model)) as LanguageModel,
    provider: primary.provider,
    modelId: primary.modelId,
    fallbacks: rest.map((c) => `${c.provider}/${c.modelId}`),
  };
}

/**
 * Wrap a model so that quota failures step to the next model in the list.
 *
 * Exported so the behaviour can be tested with fake models. Verifying this
 * against real providers would mean deliberately exhausting a quota, which is
 * both slow and the resource we are trying to conserve.
 */
export function withFallback(
  primary: LanguageModelV4,
  rest: LanguageModelV4[],
): LanguageModelV4 {
  if (rest.length === 0) return primary;

  return wrapLanguageModel({
    model: primary,
    middleware: {
      async wrapStream({ doStream, params }) {
        try {
          return await doStream();
        } catch (err) {
          if (!isExhaustion(err)) throw err;
          return await tryRest(rest, (m) => m.doStream(params), err);
        }
      },
      async wrapGenerate({ doGenerate, params }) {
        try {
          return await doGenerate();
        } catch (err) {
          if (!isExhaustion(err)) throw err;
          return await tryRest(rest, (m) => m.doGenerate(params), err);
        }
      },
    },
  }) as LanguageModelV4;
}

async function tryRest<T>(
  rest: LanguageModelV4[],
  call: (m: LanguageModelV4) => PromiseLike<T>,
  firstError: unknown,
): Promise<T> {
  let last = firstError;
  for (const model of rest) {
    console.warn(
      `[model] failing over to ${model.provider}/${model.modelId}, previous provider said:`,
      last instanceof Error ? last.message.slice(0, 140) : String(last).slice(0, 140),
    );
    try {
      return await call(model);
    } catch (err) {
      last = err;
      if (!isExhaustion(err)) throw err;
    }
  }
  throw last;
}

/** Turn an upstream failure into something a person can act on. */
export function explainModelError(message: string, provider?: string): string {
  if (/402|insufficient credits/i.test(message)) {
    return "Every configured model provider is out of credit or quota. Add credits, or set another provider key.";
  }
  if (/429|rate limit|quota|RESOURCE_EXHAUSTED/i.test(message)) {
    return "Every configured model provider is rate limited right now. Free tiers cap requests per minute and tokens per day. Wait a moment and try again.";
  }
  if (/401|403|API key|unauthenticated|PERMISSION_DENIED/i.test(message)) {
    return "The model provider rejected the API key. Check it is set correctly and enabled for this model.";
  }
  return `Upstream model error: ${message}${provider ? ` (${provider})` : ""}`;
}
