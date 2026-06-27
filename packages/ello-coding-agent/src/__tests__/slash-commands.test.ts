import { describe, expect, it } from 'vitest';

import type { CodingAgentConfig } from '../config.js';
import { handleSlashCommand } from '../slash-commands.js';

const config: CodingAgentConfig = {
  model: 'openai-chat:gpt-4o-mini',
  modelCandidates: ['openai-chat:gpt-4o-mini'],
  baseUrl: null,
  cwd: '/tmp/project',
  allowedPaths: ['/tmp/project'],
  sessionDir: '/tmp/sessions',
  sessionId: null,
  approvalMode: 'on-request',
  permissionRules: [],
  mcpConfigPath: null,
  systemPromptProfile: 'coding',
  theme: 'default',
  tui: true,
  json: false,
};

describe('handleSlashCommand', () => {
  it('parses model switch arguments', () => {
    expect(handleSlashCommand('/model anthropic:claude', config)).toMatchObject({
      handled: true,
      command: 'model',
      args: ['anthropic:claude'],
    });
  });

  it('covers product layer slash commands', () => {
    expect(handleSlashCommand('/compact', config)).toMatchObject({
      handled: true,
      command: 'compact',
    });
    expect(handleSlashCommand('/resume abc', config)).toMatchObject({
      handled: true,
      command: 'resume',
      args: ['abc'],
    });
    expect(handleSlashCommand('/memory', config)).toMatchObject({
      handled: true,
      command: 'memory',
    });
    expect(handleSlashCommand('/permissions', config)).toMatchObject({
      handled: true,
      command: 'permissions',
    });
    expect(handleSlashCommand('/tasks', config)).toMatchObject({
      handled: true,
      command: 'tasks',
    });
  });
});
