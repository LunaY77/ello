
import type { ContextSourceLoadResult } from '../context/source-registry.js';
import { estimateTextTokens } from '../context/source-registry.js';
import type { AgentInput } from '../engine/index.js';

import type { MemoryScope } from './paths.js';
import { memoryRoot } from './paths.js';
import type { MemoryRepository } from './repository.js';
import { MEMORY_INDEX_FILE, parseMemoryIndex } from './schema.js';

export class MemoryIndexLoader {
  private cached: Promise<ContextSourceLoadResult> | undefined;

  constructor(private readonly repository: MemoryRepository) {}

  load(): Promise<ContextSourceLoadResult> {
    if (this.cached === undefined) {
      this.cached = this.loadCurrent();
    }
    return this.cached;
  }

  invalidate(): void {
    this.cached = undefined;
  }

  private async loadCurrent(): Promise<ContextSourceLoadResult> {
    const sources = await Promise.all(
      scopes().map(async (scope) => {
        const index = await this.repository.read(scope, MEMORY_INDEX_FILE);
        parseMemoryIndex(index.content);
        const root = memoryRoot(this.repository.roots, scope);
        const content = [
          `Memory root: ${root}`,
          '<memory-index>',
          index.content.trim(),
          '</memory-index>',
        ].join('\n');
        return {
          id: `memory:${scope}`,
          type: 'memory' as const,
          title: `${scope} memory index`,
          priority: scope === 'private' ? 180 : 181,
          content,
          origin: root,
          tokensEstimate: estimateTextTokens(content),
        };
      }),
    );
    return { sources };
  }
}

export function shouldIgnoreMemory(input: AgentInput): boolean {
  const text = inputText(input).toLocaleLowerCase();
  return /\b(ignore|do not use|don't use|not use)\s+(the\s+)?memor(?:y|ies)\b/u.test(
    text,
  );
}

function inputText(input: AgentInput): string {
  if (typeof input === 'string') {
    return input;
  }
  if (Array.isArray(input)) {
    return input
      .filter((message) => message.role === 'user')
      .map((message) =>
        typeof message.content === 'string'
          ? message.content
          : JSON.stringify(message.content),
      )
      .join('\n');
  }
  return input.prompt ?? '';
}

function scopes(): readonly MemoryScope[] {
  return ['private', 'team'];
}
