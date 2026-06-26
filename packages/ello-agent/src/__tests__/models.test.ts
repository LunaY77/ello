import { afterEach, describe, expect, it, vi } from "vitest";
import { createAgent, normalizeModelName, resolveModel, splitProviderAndModel } from "../index.js";

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("model parsing", () => {
  it("uses the default model name", () => {
    expect(normalizeModelName()).toBe("openai-chat:gpt-4o-mini");
  });

  it("rejects ambiguous openai provider", () => {
    expect(() => normalizeModelName("openai:gpt-4o")).toThrow(/openai-chat.*openai-responses/);
  });

  it("splits provider and model", () => {
    expect(splitProviderAndModel("openai-chat:gpt-4o-mini")).toEqual([
      "openai-chat",
      "gpt-4o-mini",
    ]);
    expect(splitProviderAndModel("gpt-4o-mini")).toEqual([null, "gpt-4o-mini"]);
  });

  it("resolves openai base url", () => {
    const selection = resolveModel({
      modelName: "openai-chat:gpt-4.1-mini",
      baseUrl: "https://gateway.example.com/v1",
    });

    expect(selection.modelName).toBe("openai-chat:gpt-4.1-mini");
    expect(selection.baseUrl).toBe("https://gateway.example.com/v1");
  });

  it("normalizes anthropic base url from env", () => {
    vi.stubEnv("ANTHROPIC_BASE_URL", "https://anthropic.example.com/v1");

    const selection = resolveModel({ modelName: "anthropic:claude-sonnet-4-5" });

    expect(selection.modelName).toBe("anthropic:claude-sonnet-4-5");
    expect(selection.baseUrl).toBe("https://anthropic.example.com");
  });

  it("reads gateway credentials", () => {
    vi.stubEnv("MYGATEWAY_API_KEY", "test-key");
    vi.stubEnv("MYGATEWAY_BASE_URL", "https://gateway.example.com/v1");

    const selection = resolveModel({
      modelName: "gateway@mygateway:openai-chat:gpt-4o-mini",
    });

    expect(selection.modelName).toBe("openai-chat:gpt-4o-mini");
    expect(selection.baseUrl).toBe("https://gateway.example.com/v1");
  });

  it("requires gateway environment", () => {
    expect(() =>
      resolveModel({ modelName: "gateway@missing:openai-chat:gpt-4o-mini" }),
    ).toThrow("Gateway API key not found");
  });
});

describe("createAgent", () => {
  it("creates runtime with default configuration", () => {
    const runtime = createAgent();

    expect(runtime.modelName).toBe("openai-chat:gpt-4o-mini");
    expect(runtime.baseUrl).toBeNull();
    expect(runtime.env.constructor.name).toBe("LocalEnvironment");
  });

  it("preserves explicit model base url and system prompt", () => {
    const runtime = createAgent({
      modelName: "openai-chat:gpt-4.1-mini",
      baseUrl: "https://gateway.example.com/v1",
      systemPrompt: "You are concise.",
    });

    expect(runtime.modelName).toBe("openai-chat:gpt-4.1-mini");
    expect(runtime.baseUrl).toBe("https://gateway.example.com/v1");
    expect(runtime.systemPrompt).toBe("You are concise.");
  });

  it("requires enter before run", async () => {
    const runtime = createAgent();

    await expect(runtime.run("hello")).rejects.toThrow("must be entered");
  });

  it("enter creates context and exit clears it", async () => {
    const runtime = createAgent();

    expect(runtime.ctx).toBeNull();
    await runtime.enter();
    try {
      expect(runtime.ctx).not.toBeNull();
      expect(runtime.ctx?.env).toBe(runtime.env);
    } finally {
      await runtime.exit();
    }
    expect(runtime.ctx).toBeNull();
  });
});
