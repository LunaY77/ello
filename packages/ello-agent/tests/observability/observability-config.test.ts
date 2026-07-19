import { describe, expect, it } from 'vitest';

import { CodingAgentConfigSchema } from '../../src/config/schema.js';

describe('Langfuse observability config', () => {
  it('allows disabled tracing without valid connection fields', () => {
    const config = CodingAgentConfigSchema.parse({
      initial_mode: 'ask-before-changes',
      observability: {
        langfuse: {
          enabled: false,
          base_url: 42,
          content: 'not-validated-while-disabled',
        },
      },
    });

    expect(config.observability?.langfuse.enabled).toBe(false);
  });

  it('requires complete Langfuse configuration only when enabled', () => {
    expect(() =>
      CodingAgentConfigSchema.parse({
        initial_mode: 'ask-before-changes',
        observability: { langfuse: { enabled: true } },
      }),
    ).toThrow();
  });

  it('rejects an invalid explicit routing switch', () => {
    expect(() =>
      CodingAgentConfigSchema.parse({
        initial_mode: 'ask-before-changes',
        tools: { routing_enabled: 'yes' },
      }),
    ).toThrow('expected boolean');
  });
});
