import {
  loadCodingAgentConfig,
  type CodingAgentConfig,
} from '../../config/index.js';
import type { ThreadTitleGenerator } from '../../domain/ports/thread-title-generator.js';
import type { ThreadSnapshot } from '../../protocol/v1/index.js';
import { ThreadLogRepository } from '../../storage/threads/thread-log.js';
import { ThreadTranscriptStore } from '../../storage/threads/transcript-store.js';
import type { AgentMessage, ModelAdapter } from '../engine/index.js';
import { createProviderRegistry } from '../providers/catalog/index.js';
import { runInternalAgent } from '../subagents/internal-runner.js';
import { createAgentRegistry } from '../subagents/registry.js';

export function createThreadTitleGenerator(options: {
  readonly logs: ThreadLogRepository;
}): ThreadTitleGenerator {
  const transcripts = new ThreadTranscriptStore(options.logs);
  return {
    async generate(snapshot, signal) {
      const [config, messages] = await Promise.all([
        loadCodingAgentConfig({
          cwd: snapshot.thread.cwd,
          initial_mode: snapshot.settings.mode,
        }),
        transcripts.load(snapshot.thread.id),
      ]);
      return generateThreadTitle({ snapshot, messages, config, signal });
    },
  };
}

export async function generateThreadTitle(input: {
  readonly snapshot: ThreadSnapshot;
  readonly messages: readonly AgentMessage[];
  readonly config: CodingAgentConfig;
  readonly modelAdapter?: ModelAdapter;
  readonly signal?: AbortSignal;
}): Promise<string | undefined> {
  if (input.snapshot.thread.name.trim() !== '' || input.messages.length === 0) {
    return undefined;
  }
  const providerRegistry = createProviderRegistry(input.config);
  const agentRegistry = await createAgentRegistry(input.config);
  const generated = await runInternalAgent({
    definition: agentRegistry.get('title'),
    prompt: renderTitleConversation(input.messages),
    profileName: input.snapshot.settings.profile,
    config: input.config,
    providerRegistry,
    ...(input.modelAdapter === undefined
      ? {}
      : { modelAdapter: input.modelAdapter }),
    ...(input.signal === undefined ? {} : { signal: input.signal }),
  });
  const title = normalizeGeneratedTitle(generated);
  return title === '' ? undefined : title;
}

export function renderTitleConversation(
  messages: readonly AgentMessage[],
): string {
  return messages
    .slice(-12)
    .map((message) => {
      const text =
        typeof message.content === 'string'
          ? message.content
          : (JSON.stringify(message.content) ?? '');
      return `### ${message.role}\n${text.slice(0, 1_000)}`;
    })
    .join('\n\n');
}

export function normalizeGeneratedTitle(value: string): string {
  return value
    .trim()
    .replace(/^["'`]+|["'`]+$/gu, '')
    .replace(/\s+/gu, ' ')
    .slice(0, 80);
}
