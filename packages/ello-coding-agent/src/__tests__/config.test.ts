import { describe, expect, it } from 'vitest';

import { parseTomlConfig, stringifyTomlConfig } from '../config-toml.js';
import { loadCodingAgentConfig } from '../config.js';

describe('loadCodingAgentConfig', () => {
  it('accepts custom http headers from explicit config', async () => {
    const config = await loadCodingAgentConfig({
      model: 'fake:test',
      httpHeaders: { 'x-ello-test': 'yes' },
    });

    expect(config.httpHeaders).toEqual({ 'x-ello-test': 'yes' });
  });

  it('round-trips a TOML config object', () => {
    const text = stringifyTomlConfig({
      model: 'fake:test',
      httpHeaders: { 'x-ello': '1' },
    });
    expect(text).toContain('[httpHeaders]');
    expect(parseTomlConfig(text)).toMatchObject({
      model: 'fake:test',
      httpHeaders: { 'x-ello': '1' },
    });
  });
});
