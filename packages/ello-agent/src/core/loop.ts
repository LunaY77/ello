/**
 * 代理回合循环（kernel loop）。
 *
 * 整个运行时的心脏：把一次运行拆成若干「回合」，每个回合按
 * 「构建模型输入 → 调用模型 → 执行工具调用 → 结束回合」推进，循环直到自然完成、
 * 达到回合上限、被中断或卡在审批上。所有可变状态都收敛在 {@link RunSession} 里，
 * 本函数只负责按固定节奏驱动这些状态转移，因而保持 provider 无关。
 */
import { callModel } from './model-call.js';
import { buildModelInput } from './model-input.js';
import type { RunSession } from './run-session.js';
import { executeToolCalls } from './tool-execution.js';

/**
 * 驱动一次运行直到结束。
 *
 * 由 `Agent.stream` 在后台异步调起；过程中产生的事件经由 `run` 推入事件流，
 * 调用方据此实时消费。任何阶段抛出的异常都会被兜底捕获并转化为运行失败事件。
 */
export async function runAgentLoop(run: RunSession): Promise<void> {
  try {
    // 启动：加载历史会话、归一化输入、准备 resume（恢复）数据。
    await run.start();

    // 主循环：只要还允许开新回合就继续推进。
    while (run.canStartTurn()) {
      const turn = await run.startTurn();
      // 回合开始即检测到中断：跳过模型调用，标记为中断并立即收尾退出循环。
      if (turn.skipModel === 'interrupted') {
        await run.finishTurn(
          turn,
          undefined,
          undefined,
          { messages: [], toolCalls: [], pendingCount: 0 },
          'interrupted',
        );
        break;
      }

      // 正常回合三步：拼装本回合的模型输入、调用模型、执行模型请求的工具调用。
      const input = await buildModelInput(run);
      const assistant = await callModel(run, input);
      const toolResults = await executeToolCalls(run, assistant);

      // 结算本回合：累积新消息/工具调用/用量，并记录回合诊断。
      await run.finishTurn(
        turn,
        input.diagnostics,
        assistant.response,
        toolResults,
        assistant.stopReason,
      );

      // 依据本回合结果判定是否应当停止（完成/中断/待审批/无进展等）。
      if (run.shouldStopAfterTurn()) {
        break;
      }
    }

    // 收尾：必要时压缩会话、生成并落盘最终结果、广播完成事件。
    await run.finish();
  } catch (error) {
    // 兜底：把任意异常归一化为运行失败，保证 stream 总能终结。
    await run.fail(error);
  }
}
