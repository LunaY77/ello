import type { AgentSpec } from '../../domain/contract/index.js';
import type { AgentAdapter } from '../../ports/agent.js';

import { createClaudeCodeAdapter } from './claude-code/adapter.js';
import { createCodexAdapter } from './codex/adapter.js';
import { createElloAdapter } from './ello/adapter.js';

export function createAgentAdapter(agent: AgentSpec): AgentAdapter {
  switch (agent.kind) {
    case 'ello':
      return createElloAdapter(agent);
    case 'claude-code':
      return createClaudeCodeAdapter(agent);
    case 'codex':
      return createCodexAdapter(agent);
  }
}
