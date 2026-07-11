import { describe, expect, it } from 'vitest';

import { loadCodingAgentConfig } from '../config/index.js';
import type { JsonlSessionSummary } from '../session/repository.js';
import { handleSlashCommand } from '../slash-commands.js';

describe('slash commands', () => {
  it('opens the model catalog with /models', async () => {
    const config = await loadCodingAgentConfig();

    expect(handleSlashCommand('/models', config).command).toEqual({
      type: 'open-overlay',
      overlay: 'models',
    });
  });

  it('opens the subagent browser with /agents', async () => {
    const config = await loadCodingAgentConfig();

    expect(handleSlashCommand('/agents', config).command).toEqual({
      type: 'open-overlay',
      overlay: 'agents',
    });
  });

  it('sets the active profile when /profiles receives an argument', async () => {
    const config = await loadCodingAgentConfig();

    expect(handleSlashCommand('/profiles main', config).command).toEqual({
      type: 'set-profile',
      profile: 'main',
    });
  });

  it('routes /goal arguments to the session runtime', async () => {
    const config = await loadCodingAgentConfig();

    expect(
      handleSlashCommand(
        '/goal finish the implementation --tokens 12000',
        config,
      ).command,
    ).toEqual({
      type: 'runtime-action',
      action: 'goal',
      args: ['finish', 'the', 'implementation', '--tokens', '12000'],
    });
  });

  it('does not keep the removed /model command', async () => {
    const config = await loadCodingAgentConfig();

    expect(handleSlashCommand('/model', config)).toMatchObject({
      handled: true,
      output: 'Unknown command: /model',
    });
  });

  it('opens implemented TUI overlays for settings and removes tree/session commands', async () => {
    const config = await loadCodingAgentConfig();

    expect(handleSlashCommand('/settings', config).command).toEqual({
      type: 'open-overlay',
      overlay: 'settings',
    });
    expect(handleSlashCommand('/tree', config)).toMatchObject({
      handled: true,
      output: 'Unknown command: /tree',
    });
    expect(handleSlashCommand('/session', config)).toMatchObject({
      handled: true,
      output: 'Unknown command: /session',
    });
  });

  it('keeps session summaries available for resume browsing', () => {
    const summary: JsonlSessionSummary = {
      sessionId: 'session-1',
      path: '/tmp/session-1.jsonl',
      cwd: '/repo',
      entryCount: 4,
      title: '查看项目目录',
      lastUserText: '帮我看下当前的目录下的项目',
      lastAssistantText: '可以，我来看看',
    };

    expect(summary.title).toContain('项目');
    expect(summary.lastUserText).toContain('目录');
    expect(summary.lastAssistantText).toContain('看看');
  });
});
