import { randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { globalHomeDir } from '../config/index.js';
import type { JsonlSessionStore } from '../session/jsonl-store.js';

/**
 * 大 tool 输出预算替换（§2）。
 *
 * 当 tool.completed 输出超过 `maxChars` 时：
 * 1. 把完整输出写入 `artifact_dir/<artifactId>.txt`；
 * 2. 在 session JSONL 追加 `content-replacement` 记录（toolCallId → artifact）；
 * 3. 下一次 `store.load()` 投影时，模型看到的是 preview + stub。
 */
export interface ToolResultBudgetConfig {
  readonly enabled: boolean;
  readonly max_chars: number;
  readonly artifact_dir: string;
}

export interface ToolResultBudgetDeps {
  readonly sessionStore: JsonlSessionStore;
  readonly sessionId: () => string;
  readonly config: ToolResultBudgetConfig;
}

export interface ToolResultBudget {
  maybeReplace(toolCallId: string, output: string): Promise<boolean>;
}

export function createToolResultBudget(
  deps: ToolResultBudgetDeps,
): ToolResultBudget {
  const artifactDir = resolveArtifactDir(deps.config.artifact_dir);

  return {
    async maybeReplace(toolCallId: string, output: string): Promise<boolean> {
      if (!deps.config.enabled) {
        return false;
      }
      if (output.length <= deps.config.max_chars) {
        return false;
      }
      const artifactId = randomUUID();
      const artifactPath = path.join(artifactDir, `${artifactId}.txt`);
      await mkdir(artifactDir, { recursive: true });
      await writeFile(artifactPath, output, 'utf8');

      const preview = output.slice(0, 500);
      await deps.sessionStore.repository.appendContentReplacement(
        deps.sessionId(),
        {
          toolCallId,
          artifactId,
          artifactPath,
          preview,
          originalBytes: Buffer.byteLength(output, 'utf8'),
        },
      );
      return true;
    },
  };
}

function resolveArtifactDir(configured: string): string {
  if (configured.startsWith('~/')) {
    return path.join(globalHomeDir(), configured.slice(2));
  }
  return configured;
}
