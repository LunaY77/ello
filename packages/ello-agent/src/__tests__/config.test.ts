import { describe, expect, it } from 'vitest';

import { ModelCapability, ModelConfig, ToolConfig } from '../index.js';

describe('ModelCapability', () => {
  it('keeps Python enum values', () => {
    expect(ModelCapability.vision).toBe('vision');
    expect(ModelCapability.videoUnderstanding).toBe('video_understanding');
    expect(ModelCapability.documentUnderstanding).toBe(
      'document_understanding',
    );
    expect(ModelCapability.audioUnderstanding).toBe('audio_understanding');
  });
});

describe('ModelConfig', () => {
  it('uses Python defaults', () => {
    const cfg = new ModelConfig();

    expect(cfg.contextWindow).toBeNull();
    expect(cfg.proactiveContextManagementThreshold).toBe(0.65);
    expect(cfg.compactThreshold).toBe(0.9);
    expect(cfg.maxImages).toBe(20);
    expect(cfg.capabilities.size).toBe(0);
  });

  it('checks capabilities', () => {
    const cfg = new ModelConfig({ capabilities: [ModelCapability.vision] });

    expect(cfg.hasCapability(ModelCapability.vision)).toBe(true);
    expect(cfg.hasCapability(ModelCapability.audioUnderstanding)).toBe(false);
    expect(cfg.hasVision).toBe(true);
    expect(cfg.has_capability(ModelCapability.vision)).toBe(true);
    expect(cfg.has_vision).toBe(true);
    expect(cfg.has_video_understanding).toBe(false);
    expect(cfg.has_audio_understanding).toBe(false);
    expect(cfg.has_document_understanding).toBe(false);
  });

  it('allows extra fields like pydantic extra=allow', () => {
    const cfg = new ModelConfig({ customField: 'hello' });

    expect(cfg.extra.customField).toBe('hello');
    expect((cfg as unknown as { customField: string }).customField).toBe(
      'hello',
    );
  });

  it('accepts Python style field names', () => {
    const cfg = new ModelConfig({
      context_window: 200000,
      proactive_context_management_threshold: 0.7,
      compact_threshold: 0.8,
      max_images: 3,
      cold_start_trim_seconds: 12,
      capabilities: [ModelCapability.documentUnderstanding],
      custom_field: 'hello',
    });

    expect(cfg.contextWindow).toBe(200000);
    expect(cfg.proactiveContextManagementThreshold).toBe(0.7);
    expect(cfg.compactThreshold).toBe(0.8);
    expect(cfg.maxImages).toBe(3);
    expect(cfg.coldStartTrimSeconds).toBe(12);
    expect(cfg.has_document_understanding).toBe(true);
    expect((cfg as unknown as { custom_field: string }).custom_field).toBe(
      'hello',
    );
  });

  it('validates thresholds', () => {
    expect(() => new ModelConfig({ compactThreshold: 1.5 })).toThrow();
  });
});

describe('ToolConfig', () => {
  it('uses Python defaults', () => {
    const cfg = new ToolConfig();

    expect(cfg.viewMaxTextFileSize).toBe(10 * 1024 * 1024);
    expect(cfg.shellOutputTruncateLimit).toBe(20_000);
    expect(cfg.shellDefaultTimeoutSeconds).toBe(120);
  });

  it('preserves extra fields', () => {
    const cfg = new ToolConfig({ myApiKey: 'secret' });

    expect(cfg.extra.myApiKey).toBe('secret');
    expect((cfg as unknown as { myApiKey: string }).myApiKey).toBe('secret');
  });

  it('accepts Python style field names and nested security config', () => {
    const cfg = new ToolConfig({
      view_max_text_file_size: 5,
      shell_output_truncate_limit: 10,
      shell_default_timeout_seconds: 60,
      security: {
        shell_review: {
          allow_patterns: ['^ls'],
          deny_patterns: ['rm'],
          require_approval: true,
        },
        max_tool_calls_per_turn: 3,
        allowed_paths: ['/tmp'],
        denied_paths: ['/etc'],
      },
      my_api_key: 'secret',
    });

    expect(cfg.viewMaxTextFileSize).toBe(5);
    expect(cfg.shellOutputTruncateLimit).toBe(10);
    expect(cfg.shellDefaultTimeoutSeconds).toBe(60);
    expect(cfg.security?.shellReview?.allowPatterns).toEqual(['^ls']);
    expect(cfg.security?.shellReview?.denyPatterns).toEqual(['rm']);
    expect(cfg.security?.shellReview?.requireApproval).toBe(true);
    expect(cfg.security?.maxToolCallsPerTurn).toBe(3);
    expect(cfg.security?.allowedPaths).toEqual(['/tmp']);
    expect(cfg.security?.deniedPaths).toEqual(['/etc']);
    expect((cfg as unknown as { my_api_key: string }).my_api_key).toBe(
      'secret',
    );
  });
});
