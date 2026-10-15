/**
 * Command Run 的 step 级失败屏障计算。
 *
 * 屏障只从已经完成的 step 结果生成，并保留稳定的阻塞来源供结果与 TUI 展示。
 */
import type {
  CommandRecord,
  CommandRunBarrier,
  CompiledCommandFrame,
} from './types.js';

/** 在 step 完成后选择第一个确定性的 stopping outcome。 */
export function phaseBarrierFor(
  current: CommandRunBarrier | undefined,
  interruptedBy: string | undefined,
  results: readonly CommandRecord[],
  phase: readonly CompiledCommandFrame[],
): CommandRunBarrier | undefined {
  if (current !== undefined || interruptedBy !== undefined) return current;
  const candidate = [...results]
    .filter((record) => record.step === phase[0]?.step)
    .sort((left, right) => left.index - right.index)
    .find((record) => {
      if (record.status === 'denied') return true;
      if (record.status !== 'failed') return false;
      const frame = phase.find((entry) => entry.commandId === record.commandId);
      return frame?.onFailure !== 'continue';
    });
  if (
    candidate === undefined ||
    (candidate.status !== 'failed' && candidate.status !== 'denied')
  ) {
    return current;
  }
  return {
    step: candidate.step,
    commandId: candidate.commandId,
    commandName: candidate.name,
    status: candidate.status,
  };
}

/** 返回 blocked 记录使用的稳定来源与可读原因。 */
export function blockerFor(
  barrier: CommandRunBarrier | undefined,
  interruptedBy: string | undefined,
  results: readonly CommandRecord[],
): { readonly commandId: string; readonly message: string } {
  if (interruptedBy !== undefined) {
    const interrupted = results.find(
      (record) => record.commandId === interruptedBy,
    );
    return {
      commandId: interruptedBy,
      message:
        interrupted === undefined
          ? 'Blocked because the Command Run was interrupted.'
          : `Blocked by interrupted step ${interrupted.step} Command '${interrupted.name}' (${interrupted.commandId}).`,
    };
  }
  if (barrier !== undefined) {
    return {
      commandId: barrier.commandId,
      message: `Blocked by ${barrier.status} step ${barrier.step} Command '${barrier.commandName}' (${barrier.commandId}).`,
    };
  }
  return {
    commandId: 'command-run-barrier',
    message: 'Blocked by an earlier Command Run control boundary.',
  };
}
