import { describe, expect, it } from 'vitest';

import { loadCodingAgentConfig } from '../config.js';
import type { JsonlSessionSummary } from '../session/repository.js';
import { handleSlashCommand } from '../slash-commands.js';

describe('slash commands', () => {
  it('opens the model selector when /model has no argument', async () => {
    const config = await loadCodingAgentConfig({ model: 'fake:one' });

    expect(handleSlashCommand('/model', config).command).toEqual({
      type: 'open-overlay',
      overlay: 'model-selector',
    });
  });

  it('sets the model when /model receives an argument', async () => {
    const config = await loadCodingAgentConfig({ model: 'fake:one' });

    expect(handleSlashCommand('/model fake:two', config).command).toEqual({
      type: 'set-model',
      model: 'fake:two',
    });
  });

  it('opens implemented TUI overlays for settings and session tree', async () => {
    const config = await loadCodingAgentConfig({ model: 'fake:one' });

    expect(handleSlashCommand('/settings', config).command).toEqual({
      type: 'open-overlay',
      overlay: 'settings',
    });
    expect(handleSlashCommand('/tree', config).command).toEqual({
      type: 'open-overlay',
      overlay: 'session-tree',
    });
  });

  it('keeps session summaries available for resume browsing', () => {
    const summary: JsonlSessionSummary = {
      sessionId: 'session-1',
      path: '/tmp/session-1.jsonl',
      cwd: '/repo',
      entryCount: 4,
      lastUserText: '帮我看下当前的目录下的项目',
      lastAssistantText: '可以，我来看看',
    };

    expect(summary.lastUserText).toContain('目录');
    expect(summary.lastAssistantText).toContain('看看');
  });
});
