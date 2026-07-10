import type { AgentMessage, ModelAdapter } from '@ello/agent';

import { runInternalToolAgent } from '../agents/agent-runner.js';
import type { AgentRegistry } from '../agents/registry.js';
import type { CodingAgentConfig } from '../config/index.js';
import type { ProviderRegistry } from '../provider/index.js';
import type { JsonlSessionRepository } from '../session/repository.js';

import type { MemoryIndexLoader } from './index-loader.js';
import { renderMemoryExtractionPrompt, renderMemoryPrompt } from './prompt.js';
import { MEMORY_INDEX_FILE } from './schema.js';
import type { MemoryToolPort } from './tools.js';
import { createMemoryTools } from './tools.js';

export async function runMemoryExtractionJob(input: {
  readonly sessionId: string;
  readonly sourceLeafId: string;
  readonly recentMessages: number;
  readonly config: CodingAgentConfig;
  readonly registry: AgentRegistry;
  readonly providerRegistry: ProviderRegistry;
  readonly sessionRepository: JsonlSessionRepository;
  readonly memory: MemoryToolPort;
  readonly indexLoader: MemoryIndexLoader;
  readonly modelAdapter?: ModelAdapter;
}): Promise<{ readonly changes: number; readonly summary: string }> {
  const allMessages = await input.sessionRepository.loadMessagesAt(
    input.sessionId,
    input.sourceLeafId,
  );
  const messages = allMessages.slice(-input.recentMessages);
  const [privateIndex, teamIndex] = await Promise.all([
    input.memory.repository.read('private', MEMORY_INDEX_FILE),
    input.memory.repository.read('team', MEMORY_INDEX_FILE),
  ]);
  let changes = 0;
  const tools = createMemoryTools({
    port: input.memory,
    onMutation: () => {
      changes += 1;
      input.indexLoader.invalidate();
    },
  });
  const instructions = [
    renderMemoryPrompt(input.memory.repository.roots),
    renderMemoryExtractionPrompt({
      recentMessages: input.recentMessages,
      indexes: [
        '<private-index>',
        privateIndex.content.trim(),
        '</private-index>',
        '<team-index>',
        teamIndex.content.trim(),
        '</team-index>',
      ].join('\n'),
    }),
  ].join('\n\n');
  const result = await runInternalToolAgent({
    definition: input.registry.get('memory-extractor'),
    instructions,
    prompt: `<recent-messages>\n${serializeMessages(messages)}\n</recent-messages>`,
    tools,
    maxTurns: input.registry.get('memory-extractor').maxTurns ?? 8,
    config: input.config,
    providerRegistry: input.providerRegistry,
    ...(input.modelAdapter !== undefined
      ? { modelAdapter: input.modelAdapter }
      : {}),
  });
  return { changes, summary: result.output || result.text || '' };
}

function serializeMessages(messages: readonly AgentMessage[]): string {
  return messages
    .map((message, index) =>
      JSON.stringify({
        index,
        role: message.role,
        content: message.content,
      }),
    )
    .join('\n');
}
