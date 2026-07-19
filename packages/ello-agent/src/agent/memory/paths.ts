import path from 'node:path';

import type { CodingAgentConfig } from '../../config/index.js';

export type MemoryScope = 'private' | 'team';

export interface MemoryRoots {
  readonly private: string;
  readonly team: string;
}

export function memoryRoots(config: CodingAgentConfig): MemoryRoots {
  return {
    private: path.resolve(config.context.memory.private_dir),
    team: path.resolve(config.context.memory.team_dir),
  };
}

export function memoryRoot(roots: MemoryRoots, scope: MemoryScope): string {
  return roots[scope];
}

export function memoryIndexPath(
  roots: MemoryRoots,
  scope: MemoryScope,
): string {
  return path.join(memoryRoot(roots, scope), 'MEMORY.md');
}
