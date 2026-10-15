/**
 * 本文件负责 tool feature 的“command-history”模块职责。
 *
 * 状态由本模块声明的对象、闭包或 store 显式持有；跨 feature 依赖只能进入对方公开入口。
 * 外部输入在边界完成校验，非法状态和资源失败直接抛出，调用顺序由公开契约约束。
 */

/** LRU 容量上限；只需覆盖最近若干轮，超出后按最久未访问淘汰。 */
export const COMMAND_HISTORY_CAPACITY = 32;

/** 重复命令判定结果；`rounds` 是与上次执行相隔的轮数。 */
export interface DuplicateCommand {
  readonly rounds: number;
}

/**
 * 记录最近若干条 shell 命令与文件变更轮次的 LRU。
 *
 * 轮次由每次工具执行递增，因此「相隔几轮」等于两次执行的轮次差。只有在两次
 * 执行之间没有任何文件变更时才判定为重复：文件变更后同一命令的结果可能不同，
 * 此时重复执行是合理的。
 */
export class ShellCommandHistory {
  private readonly rounds = new Map<string, number>();
  private currentRound = 0;
  private lastFileChangeRound: number | null = null;

  /**
   * 创建 `ShellCommandHistory`，由该实例独占 工具 `command-history` 模块 中声明的可变状态和资源生命周期。
   *
   * Args:
   * - `capacity`: 保留的命令条数上限；必须为正整数，非法值直接失败。
   */
  constructor(private readonly capacity = COMMAND_HISTORY_CAPACITY) {
    if (!Number.isInteger(capacity) || capacity < 1) {
      throw new RangeError(
        `Shell command history capacity must be a positive integer: ${capacity}`,
      );
    }
  }

  /**
   * 推进轮次并登记一条 shell 命令，返回其重复情况。
   *
   * Args:
   * - `command`: 本轮执行的完整命令文本；空命令属于非法输入。
   *
   * Returns:
   * - 返回匹配值；命令未重复或期间发生过文件变更时显式返回 `null`。
   *
   * Throws:
   * - 命令为空时直接抛错，说明调用方传入了非法输入。
   */
  recordCommand(command: string): DuplicateCommand | null {
    if (command === '') {
      throw new Error('Shell command history cannot record an empty command.');
    }
    this.currentRound += 1;
    const previousRound = this.rounds.get(command);
    this.remember(command);
    if (previousRound === undefined) {
      return null;
    }
    if (
      this.lastFileChangeRound !== null &&
      this.lastFileChangeRound > previousRound
    ) {
      return null;
    }
    return { rounds: this.currentRound - previousRound };
  }

  /**
   * 推进轮次并登记本轮发生了文件变更。
   *
   * Args:
   * - 无：操作使用实例已经持有的轮次状态。
   *
   * Returns:
   * - 工具 `command-history` 模块 的同步状态变更完成后返回，不产生业务结果。
   */
  recordFileChange(): void {
    this.currentRound += 1;
    this.lastFileChangeRound = this.currentRound;
  }

  /**
   * 推进轮次，用于既非 shell 也未改动文件的工具调用。
   *
   * Args:
   * - 无：操作使用实例已经持有的轮次状态。
   *
   * Returns:
   * - 工具 `command-history` 模块 的同步状态变更完成后返回，不产生业务结果。
   */
  recordOtherCall(): void {
    this.currentRound += 1;
  }

  private remember(command: string): void {
    this.rounds.delete(command);
    this.rounds.set(command, this.currentRound);
    while (this.rounds.size > this.capacity) {
      const oldest = this.rounds.keys().next();
      if (oldest.done === true) {
        throw new Error('Shell command history lost its eviction candidate.');
      }
      this.rounds.delete(oldest.value);
    }
  }
}

/**
 * 生成重复命令提示行，附加在工具输出前。
 *
 * Args:
 * - `duplicate`: 重复判定结果；`rounds` 为与上次执行相隔的轮数。
 *
 * Returns:
 * - 返回 `duplicateCommandNotice` 计算出的声明结果；返回值不包含未声明的兜底状态。
 */
export function duplicateCommandNotice(duplicate: DuplicateCommand): string {
  return `Note: this identical command already ran ${duplicate.rounds} round(s) ago with no file changes in between, so this output repeats what you already have. Change the command or change a file before running it again.`;
}
