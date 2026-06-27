import { describe, expect, it } from 'vitest';

import { ModelCapability, ModelConfig, ToolConfig } from '../index.js';

describe('ModelCapability', () => {
  it('keeps stable enum values', () => {
    expect(ModelCapability.vision).toBe('vision');
    expect(ModelCapability.videoUnderstanding).toBe('video_understanding');
    expect(ModelCapability.documentUnderstanding).toBe(
      'document_understanding',
    );
    expect(ModelCapability.audioUnderstanding).toBe('audio_understanding');
  });
});

describe('ModelConfig', () => {
  it('uses defaults', () => {
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
    expect(cfg.hasVideoUnderstanding).toBe(false);
    expect(cfg.hasAudioUnderstanding).toBe(false);
    expect(cfg.hasDocumentUnderstanding).toBe(false);
  });

  it('allows extra fields', () => {
    const cfg = new ModelConfig({ customField: 'hello' });

    expect(cfg.extra.customField).toBe('hello');
    expect((cfg as unknown as { customField: string }).customField).toBe(
      'hello',
    );
  });

  it('accepts camelCase field names', () => {
    const cfg = new ModelConfig({
      contextWindow: 200000,
      proactiveContextManagementThreshold: 0.7,
      compactThreshold: 0.8,
      maxImages: 3,
      coldStartTrimSeconds: 12,
      capabilities: [ModelCapability.documentUnderstanding],
      customField: 'hello',
    });

    expect(cfg.contextWindow).toBe(200000);
    expect(cfg.proactiveContextManagementThreshold).toBe(0.7);
    expect(cfg.compactThreshold).toBe(0.8);
    expect(cfg.maxImages).toBe(3);
    expect(cfg.coldStartTrimSeconds).toBe(12);
    expect(cfg.hasDocumentUnderstanding).toBe(true);
    expect((cfg as unknown as { customField: string }).customField).toBe(
      'hello',
    );
  });

  it('validates thresholds', () => {
    expect(() => new ModelConfig({ compactThreshold: 1.5 })).toThrow();
  });
});

describe('ToolConfig', () => {
  it('uses defaults', () => {
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

  it('accepts camelCase field names and nested security config', () => {
    const cfg = new ToolConfig({
      viewMaxTextFileSize: 5,
      shellOutputTruncateLimit: 10,
      shellDefaultTimeoutSeconds: 60,
      security: {
        shellReview: {
          allowPatterns: ['^ls'],
          denyPatterns: ['rm'],
          requireApproval: true,
        },
        maxToolCallsPerTurn: 3,
        allowedPaths: ['/tmp'],
        deniedPaths: ['/etc'],
      },
      myApiKey: 'secret',
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
    expect((cfg as unknown as { myApiKey: string }).myApiKey).toBe('secret');
  });
});
