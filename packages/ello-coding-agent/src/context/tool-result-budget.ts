import type { JsonlSessionStore } from '../session/jsonl-store.js';
import type { ArtifactStore } from '../storage/artifact-store.js';

/**
 * 大 tool 输出预算替换（§2）。
 *
 * 当 tool.completed 输出超过 `maxChars` 时：
 * 1. 把完整输出写入统一 ArtifactStore；
 * 2. 在 session JSONL 追加 `content-replacement` 记录（toolCallId → artifact）；
 * 3. replacement snapshot 立即更新，后续模型回合看到 preview + stub。
 */
export interface ToolResultBudgetConfig {
  readonly enabled: boolean;
  readonly max_chars: number;
}

export interface ToolResultBudgetDeps {
  readonly sessionStore: JsonlSessionStore;
  readonly artifacts: ArtifactStore;
  readonly sessionId: () => string;
  readonly config: ToolResultBudgetConfig;
}

export interface ToolResultBudget {
  maybeReplace(toolCallId: string, output: string): Promise<boolean>;
}

export function createToolResultBudget(
  deps: ToolResultBudgetDeps,
): ToolResultBudget {
  return {
    async maybeReplace(toolCallId: string, output: string): Promise<boolean> {
      if (!deps.config.enabled) {
        return false;
      }
      if (output.length <= deps.config.max_chars) {
        return false;
      }
      const sessionId = deps.sessionId();
      const owner = {
        kind: 'tool-result' as const,
        id: `${sessionId}:${toolCallId}`,
        relation: 'full-output',
      };
      const artifact = await deps.artifacts.put({
        kind: 'tool-result',
        content: output,
        contentType: 'text/plain; charset=utf-8',
        owner,
      });
      const preview = output.slice(0, 500);
      try {
        await deps.sessionStore.appendContentReplacement(sessionId, {
          toolCallId,
          artifactId: artifact.id,
          preview,
          originalBytes: artifact.byteSize,
          sha256: artifact.sha256,
        });
      } catch (error) {
        await deps.artifacts.releaseOwner(owner);
        throw error;
      }
      return true;
    },
  };
}
