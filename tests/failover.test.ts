/**
 * Provider failover.
 *
 * Verified with fake models: proving this against real providers would mean
 * deliberately exhausting a quota, which is slow and destroys the exact resource
 * the feature exists to conserve.
 */
import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import type { LanguageModelV4 } from "@ai-sdk/provider";
import { isExhaustion, withFallback } from "@/lib/model";

function fake(name: string, behaviour: "ok" | Error): LanguageModelV4 {
  const result = {
    stream: new ReadableStream(),
    // The shape is not inspected by the failover logic; identity is what matters.
    request: { model: name },
  };
  return {
    specificationVersion: "v4",
    provider: name,
    modelId: `${name}-model`,
    supportedUrls: {},
    doGenerate: vi.fn(async () => {
      if (behaviour !== "ok") throw behaviour;
      return { model: name } as never;
    }),
    doStream: vi.fn(async () => {
      if (behaviour !== "ok") throw behaviour;
      return { ...result } as never;
    }),
  } as unknown as LanguageModelV4;
}

function httpError(status: number, message: string): Error {
  const e = new Error(message) as Error & { statusCode: number };
  e.statusCode = status;
  return e;
}

describe("classifying which failures are worth failing over", () => {
  it("treats rate limits and quota exhaustion as retryable elsewhere", () => {
    expect(isExhaustion(httpError(429, "Too Many Requests"))).toBe(true);
    expect(isExhaustion(new Error("Quota exceeded for metric: generate_content_free_tier_requests"))).toBe(true);
    expect(isExhaustion(new Error("RESOURCE_EXHAUSTED"))).toBe(true);
    expect(isExhaustion(new Error("Rate limit reached for model tokens per day (TPD)"))).toBe(true);
    expect(isExhaustion(httpError(402, "Insufficient credits"))).toBe(true);
    expect(isExhaustion(httpError(503, "overloaded"))).toBe(true);
  });

  it("does NOT fail over for errors every provider would reject identically", () => {
    // A bad request or a bad key fails the same way everywhere. Retrying it
    // across the chain burns three quotas and buries the real cause.
    expect(isExhaustion(httpError(400, "Invalid tool schema"))).toBe(false);
    expect(isExhaustion(httpError(401, "Invalid API key"))).toBe(false);
    expect(isExhaustion(httpError(404, "model does not exist"))).toBe(false);
  });
});

describe("withFallback", () => {
  const warn = vi.spyOn(console, "warn");
  beforeEach(() => warn.mockImplementation(() => {}));
  afterEach(() => warn.mockClear());

  it("returns the primary untouched when nothing is standing by", () => {
    const primary = fake("groq", "ok");
    expect(withFallback(primary, [])).toBe(primary);
  });

  it("uses the primary when it works, and never touches the fallback", async () => {
    const primary = fake("groq", "ok");
    const backup = fake("google", "ok");
    const model = withFallback(primary, [backup]);

    await model.doStream({} as never);

    expect(primary.doStream).toHaveBeenCalledTimes(1);
    expect(backup.doStream).not.toHaveBeenCalled();
  });

  it("steps to the next provider when the primary is rate limited", async () => {
    const primary = fake("groq", httpError(429, "tokens per day (TPD) exceeded"));
    const backup = fake("google", "ok");
    const model = withFallback(primary, [backup]);

    await model.doStream({} as never);

    expect(primary.doStream).toHaveBeenCalledTimes(1);
    expect(backup.doStream).toHaveBeenCalledTimes(1);
  });

  it("walks the whole chain when several providers are exhausted", async () => {
    const primary = fake("groq", httpError(429, "rate limit"));
    const second = fake("google", httpError(429, "quota exceeded"));
    const third = fake("openrouter", "ok");
    const model = withFallback(primary, [second, third]);

    await model.doStream({} as never);

    expect(third.doStream).toHaveBeenCalledTimes(1);
  });

  it("surfaces the last error when every provider is exhausted", async () => {
    const primary = fake("groq", httpError(429, "first"));
    const backup = fake("google", httpError(429, "last one standing"));
    const model = withFallback(primary, [backup]);

    await expect(model.doStream({} as never)).rejects.toThrow(/last one standing/);
  });

  it("does not fail over on a non-quota error", async () => {
    const primary = fake("groq", httpError(400, "Invalid tool schema"));
    const backup = fake("google", "ok");
    const model = withFallback(primary, [backup]);

    await expect(model.doStream({} as never)).rejects.toThrow(/Invalid tool schema/);
    expect(backup.doStream).not.toHaveBeenCalled();
  });

  it("applies the same rules to non-streaming calls", async () => {
    const primary = fake("groq", httpError(429, "rate limit"));
    const backup = fake("google", "ok");
    const model = withFallback(primary, [backup]);

    await model.doGenerate({} as never);

    expect(backup.doGenerate).toHaveBeenCalledTimes(1);
  });
});
