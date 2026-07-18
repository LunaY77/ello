import { renderPromptTemplate } from '../context/prompts.js';

import type { MemoryRoots } from './paths.js';

export function renderMemoryPrompt(roots: MemoryRoots): string {
  return renderPromptTemplate('memory', {
    private_memory_dir: roots.private,
    team_memory_dir: roots.team,
  });
}

export function renderMemoryExtractionPrompt(input: {
  readonly recentMessages: number;
  readonly indexes: string;
}): string {
  return renderPromptTemplate('memory-extraction', {
    recent_messages: input.recentMessages,
    existing_memory: input.indexes,
  });
}

export function renderDreamPrompt(input: {
  readonly roots: MemoryRoots;
  readonly sessionDir: string;
}): string {
  return renderPromptTemplate('dream', {
    private_memory_dir: input.roots.private,
    team_memory_dir: input.roots.team,
    session_dir: input.sessionDir,
  });
}
