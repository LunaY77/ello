import { describe, expect, it } from "vitest";
import { ModelCapability, ModelConfig, ToolConfig } from "../index.js";

describe("ModelCapability", () => {
  it("keeps Python enum values", () => {
    expect(ModelCapability.vision).toBe("vision");
    expect(ModelCapability.videoUnderstanding).toBe("video_understanding");
    expect(ModelCapability.documentUnderstanding).toBe("document_understanding");
    expect(ModelCapability.audioUnderstanding).toBe("audio_understanding");
  });
});

describe("ModelConfig", () => {
  it("uses Python defaults", () => {
    const cfg = new ModelConfig();

    expect(cfg.contextWindow).toBeNull();
    expect(cfg.proactiveContextManagementThreshold).toBe(0.65);
    expect(cfg.compactThreshold).toBe(0.9);
    expect(cfg.maxImages).toBe(20);
    expect(cfg.capabilities.size).toBe(0);
  });

  it("checks capabilities", () => {
    const cfg = new ModelConfig({ capabilities: [ModelCapability.vision] });

    expect(cfg.hasCapability(ModelCapability.vision)).toBe(true);
    expect(cfg.hasCapability(ModelCapability.audioUnderstanding)).toBe(false);
    expect(cfg.hasVision).toBe(true);
  });

  it("allows extra fields like pydantic extra=allow", () => {
    const cfg = new ModelConfig({ customField: "hello" });

    expect(cfg.extra.customField).toBe("hello");
  });

  it("validates thresholds", () => {
    expect(() => new ModelConfig({ compactThreshold: 1.5 })).toThrow();
  });
});

describe("ToolConfig", () => {
  it("uses Python defaults", () => {
    const cfg = new ToolConfig();

    expect(cfg.viewMaxTextFileSize).toBe(10 * 1024 * 1024);
    expect(cfg.shellOutputTruncateLimit).toBe(20_000);
    expect(cfg.shellDefaultTimeoutSeconds).toBe(120);
  });

  it("preserves extra fields", () => {
    const cfg = new ToolConfig({ myApiKey: "secret" });

    expect(cfg.extra.myApiKey).toBe("secret");
  });
});
