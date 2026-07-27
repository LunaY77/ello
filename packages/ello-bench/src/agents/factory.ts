import type { AgentSpec } from '../contracts.js';

import type { AgentAdapter } from './adapter.js';
import { createClaudeCodeAdapter } from './claude-code/adapter.js';
import { createElloAdapter } from './ello/adapter.js';

export function createAgentAdapter(agent: AgentSpec): AgentAdapter {
  switch (agent.kind) {
    case 'ello':
      return createElloAdapter(agent);
    case 'claude-code':
      return createClaudeCodeAdapter(agent);
  }
}
