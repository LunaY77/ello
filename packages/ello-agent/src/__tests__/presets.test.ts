import { describe, expect, it } from "vitest";
import {
  K_TOKENS,
  ModelSettingsPreset,
  getModelSettings,
  listPresets,
  resolveModelSettings,
} from "../index.js";

describe("getModelSettings", () => {
  it("gets preset by string", () => {
    const settings = getModelSettings("anthropic_high");

    expect(settings.anthropic_effort).toBe("high");
    expect(settings.max_tokens).toBe(32 * K_TOKENS);
  });

  it("gets preset by exported constant", () => {
    const settings = getModelSettings(ModelSettingsPreset.OPENAI_HIGH);

    expect(settings.openai_reasoning_effort).toBe("high");
  });

  it("resolves aliases", () => {
    expect(getModelSettings("anthropic")).toEqual(getModelSettings("anthropic_default"));
  });

  it("raises on unknown preset", () => {
    expect(() => getModelSettings("nonexistent_preset")).toThrow("Unknown preset");
  });

  it("keeps DeepSeek settings", () => {
    const enabled = getModelSettings("deepseek_default");
    const disabled = getModelSettings("deepseek_off");

    expect(enabled.extra_body).toEqual({ thinking: { type: "enabled" } });
    expect(enabled.openai_reasoning_effort).toBe("high");
    expect(disabled.extra_body).toEqual({ thinking: { type: "disabled" } });
    expect(disabled.openai_reasoning_effort).toBeUndefined();
  });

  it("keeps Gemini settings", () => {
    const settings = getModelSettings("gemini_default");

    expect(settings.google_thinking_config).toEqual({
      thinking_budget: 16 * K_TOKENS,
      include_thoughts: true,
    });
  });

  it("keeps OpenAI responses settings", () => {
    const settings = getModelSettings("openai_responses_high");

    expect(settings.openai_reasoning_effort).toBe("high");
    expect(settings.openai_reasoning_summary).toBe("detailed");
  });
});

describe("resolveModelSettings", () => {
  it("handles null string and dictionary", () => {
    expect(resolveModelSettings(null)).toBeNull();
    expect(resolveModelSettings("anthropic_high")?.anthropic_effort).toBe("high");
    expect(resolveModelSettings({ max_tokens: 4096, temperature: 0.5 })).toEqual({
      max_tokens: 4096,
      temperature: 0.5,
    });
  });
});

describe("listPresets", () => {
  it("includes constants and aliases", () => {
    const presets = listPresets();

    for (const preset of Object.values(ModelSettingsPreset)) {
      expect(presets).toContain(preset);
    }
    expect(presets).toContain("anthropic");
    expect(presets).toContain("openai");
    expect(presets).toContain("deepseek");
    expect(presets).toContain("gemini");
  });
});
