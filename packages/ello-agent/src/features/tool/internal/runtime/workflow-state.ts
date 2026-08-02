/**
 * 本文件维护单次 Agent run 的工作阶段，供动态 prompt fragment 和工具恢复策略共享。
 */
import type { CodingToolResult } from './coding-tool.js';

export type AgentWorkflowPhase = 'explore' | 'implement' | 'verify' | 'recover';

/** 根据真实工具结果推进工作阶段，不依赖模型自行声明。 */
export class AgentWorkflowState {
  private phase: AgentWorkflowPhase = 'explore';

  /**
   * 观察一次成功工具结果并更新阶段。
   *
   * Args:
   * - `result`: coding tool 的结构化结果。
   */
  observeResult(result: CodingToolResult): void {
    if (
      result.metadata.kind === 'edit' ||
      (result.metadata.fileChanges?.length ?? 0) > 0
    ) {
      this.phase = 'implement';
      return;
    }
    if (
      result.metadata.kind === 'shell' &&
      typeof result.metadata.phase === 'string'
    ) {
      this.phase = 'verify';
      return;
    }
    if (this.phase === 'recover') this.phase = 'explore';
  }

  /** 任一工具异常先进入 recover，直到下一次有信息增益的成功调用。 */
  observeFailure(): void {
    this.phase = 'recover';
  }

  /**
   * 渲染当前阶段的短动态片段；稳定基础 prompt 不受阶段切换影响。
   *
   * Returns:
   * - 返回当前阶段和唯一行动重点。
   */
  instructions(): string {
    const guidance: Record<AgentWorkflowPhase, string> = {
      explore:
        'Establish evidence and locate the smallest relevant ownership boundary before editing.',
      implement:
        'Keep the change scoped, update tests with behavior, and move to targeted verification promptly.',
      verify:
        'Interpret the declared verification phase and exit code; broaden coverage only after targeted checks pass.',
      recover:
        'Use the structured error fingerprint and remaining retry budget; switch strategy when the budget reaches zero.',
    };
    return `<active-workflow phase="${this.phase}">${guidance[this.phase]}</active-workflow>`;
  }
}
