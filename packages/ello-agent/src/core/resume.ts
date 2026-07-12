/**
 * 审批恢复（resume-after-approval）的预处理。
 *
 * 当上一次运行因工具调用待审批而中止后，调用方带着审批决定再次发起运行；
 * 本模块负责在新运行真正开始前，把「已批准但尚无结果」的延迟工具调用补跑出
 * 真实输出，从而让续接的首个回合拿到完整的工具结果。
 */
import { normalizeAgentError } from '../public/errors.js';
import type { AgentRunOptions, DeferredRunResults } from '../public/types.js';

import type { RunSession } from './run-session.js';

/**
 * 预处理 resume 数据：为已批准的延迟工具调用补齐执行结果。
 *
 * 遍历所有延迟项，对其中「审批通过且 `toolResults` 里尚无对应输出」的工具调用，
 * 通过工具调度器实际执行一次，并把输出（或错误）回填进 `toolResults`。
 * 非审批类延迟项、被拒绝项、以及调用方已自带结果的项一律跳过。
 * 无延迟项时原样返回 `resume`。
 */
export async function prepareResume(
  run: RunSession,
  resume: AgentRunOptions['resume'],
): Promise<DeferredRunResults | undefined> {
  if (resume === undefined || resume.deferred === undefined) {
    return resume;
  }
  const toolResults: Record<string, unknown> = {
    ...(resume.toolResults ?? {}),
  };
  for (const item of resume.deferred) {
    if (item.kind !== 'approval') {
      continue;
    }
    // 解析审批决定：布尔值或带 approved 字段的对象，缺省视为未批准。
    const decision = resume.approvals?.[item.toolCallId];
    const approved =
      typeof decision === 'boolean' ? decision : (decision?.approved ?? false);
    if (!approved) {
      const reason = typeof decision === 'object' ? decision.reason : undefined;
      await run.events.emit({
        type: 'tool.failed',
        turnIndex: run.state.turn,
        toolCallId: item.toolCallId,
        error: normalizeAgentError(
          new Error(
            reason ?? `Tool '${item.toolName}' was denied by the user.`,
          ),
        ),
      });
      continue;
    }
    // 仅对「已批准且还没有结果」的项补跑，避免重复执行或执行被拒项。
    if (toolResults[item.toolCallId] !== undefined) {
      continue;
    }
    const result = await run.toolScheduler.executeApproved(
      {
        id: item.toolCallId,
        name: item.toolName,
        input: item.input,
      },
      {
        onToolStarted: (toolCallId, name, input) =>
          run.events.emit({
            type: 'tool.started',
            turnIndex: run.state.turn,
            toolCallId,
            name,
            input,
          }),
        onApprovalRequired: async () => {},
        onToolCompleted: (toolCallId, output) =>
          run.events.emit({
            type: 'tool.completed',
            turnIndex: run.state.turn,
            toolCallId,
            output,
          }),
        onToolFailed: (toolCallId, error) =>
          run.events.emit({
            type: 'tool.failed',
            turnIndex: run.state.turn,
            toolCallId,
            error: normalizeAgentError(error),
          }),
      },
    );
    // 失败则回填错误信息，成功则回填工具输出，供后续回合构建工具结果消息。
    toolResults[item.toolCallId] =
      result.error !== undefined
        ? { error: result.error.message }
        : result.output;
  }
  return { ...resume, toolResults };
}
