import { describe, expect, it } from 'vitest';

import { CodingAgentConfigSchema } from '../config/schema.js';

describe('Langfuse observability config', () => {
  it('allows disabled tracing without valid connection fields', () => {
    const config = CodingAgentConfigSchema.parse({
      initialMode: 'default',
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
        initialMode: 'default',
        observability: { langfuse: { enabled: true } },
      }),
    ).toThrow();
  });

  it('rejects an invalid explicit routing switch', () => {
    expect(() =>
      CodingAgentConfigSchema.parse({
        tools: { routing_enabled: 'yes' },
      }),
    ).toThrow('expected boolean');
  });
});
