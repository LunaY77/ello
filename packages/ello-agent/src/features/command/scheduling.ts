/**
 * Command Run 的纯调度分组函数。
 *
 * 本模块只根据编译后的 step 与并发能力生成稳定分组，不执行 Command，也不持有运行时状态。
 */
import type { CompiledCommandFrame } from './types.js';

/** 按连续且相同的 step 把 Frame 分为严格 phase。 */
export function groupCommandPhases(
  frames: readonly CompiledCommandFrame[],
): readonly (readonly CompiledCommandFrame[])[] {
  const phases: CompiledCommandFrame[][] = [];
  for (const frame of frames) {
    const last = phases.at(-1);
    if (last === undefined || last[0]?.step !== frame.step)
      phases.push([frame]);
    else last.push(frame);
  }
  return phases;
}

/** 在一个 phase 内把兼容安全读取合并为并发 wave。 */
export function createCommandWaves<
  TCommand extends {
    readonly capabilities: { readonly concurrencySafe: boolean };
  },
>(commands: readonly TCommand[]): TCommand[][] {
  const waves: TCommand[][] = [];
  for (const command of commands) {
    const last = waves.at(-1);
    if (
      command.capabilities.concurrencySafe &&
      last !== undefined &&
      last.every((entry) => entry.capabilities.concurrencySafe)
    ) {
      last.push(command);
    } else {
      waves.push([command]);
    }
  }
  return waves;
}
