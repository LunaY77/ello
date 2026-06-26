/**
 * Shell 命令执行结果。
 */
export interface ShellResult {
  /** 进程退出码, -1 表示超时。 */
  exitCode: number;
  /** 标准输出文本。 */
  stdout: string;
  /** 标准错误文本。 */
  stderr: string;
}

/**
 * 文件系统操作抽象接口。
 */
export interface FileOperator {
  /**
   * 读取文本文件内容。
   *
   * Args:
   *   path: 文件路径, 支持相对路径或绝对路径。
   *
   * Returns:
   *   文件的 UTF-8 文本内容。
   */
  readText(path: string): Promise<string>;

  /**
   * 写入文本文件, 父目录不存在时自动创建。
   *
   * Args:
   *   path: 目标文件路径。
   *   content: 要写入的 UTF-8 文本内容。
   */
  writeText(path: string, content: string): Promise<void>;

  /**
   * 列出目录下的文件和子目录名称。
   *
   * Args:
   *   path: 目录路径。
   *
   * Returns:
   *   排序后的文件名列表。
   */
  listDir(path: string): Promise<string[]>;

  /** 释放资源。 */
  close?(): Promise<void>;
}

/**
 * Shell 命令执行抽象接口。
 */
export interface Shell {
  /**
   * 执行 shell 命令并等待完成。
   *
   * Args:
   *   command: 要执行的 shell 命令字符串。
   *   options.cwd: 工作目录; 未传入时使用默认目录。
   *   options.timeout: 超时毫秒数; 未传入时不设超时。
   *
   * Returns:
   *   包含 exitCode, stdout, stderr 的执行结果。
   */
  run(
    command: string,
    options?: { cwd?: string; timeout?: number },
  ): Promise<ShellResult>;

  /** 释放资源。 */
  close?(): Promise<void>;
}

/**
 * Agent 与外部世界的能力边界。
 *
 * 子类通过 setup 和 teardown 管理 fileOperator 与 shell 的生命周期。
 */
export abstract class Environment {
  protected fileOperatorValue: FileOperator | null = null;
  protected shellValue: Shell | null = null;
  private enteredValue = false;

  /** 返回环境是否已进入。 */
  get entered(): boolean {
    return this.enteredValue;
  }

  /**
   * 返回文件操作器。
   *
   * Raises:
   *   Error: 环境未进入时抛出。
   */
  get fileOperator(): FileOperator | null {
    if (!this.enteredValue) {
      throw new Error('Environment has not been entered.');
    }
    return this.fileOperatorValue;
  }

  /**
   * 返回 Shell 实例。
   *
   * Raises:
   *   Error: 环境未进入时抛出。
   */
  get shell(): Shell | null {
    if (!this.enteredValue) {
      throw new Error('Environment has not been entered.');
    }
    return this.shellValue;
  }

  /** 初始化环境资源。 */
  protected abstract setup(): Promise<void>;

  /** 清理环境资源。 */
  protected abstract teardown(): Promise<void>;

  /**
   * 返回环境上下文指令, 供注入到 system prompt。
   */
  async getContextInstructions(): Promise<string> {
    if (!this.enteredValue) {
      throw new Error('Environment has not been entered.');
    }
    return '';
  }

  /**
   * 进入环境生命周期。
   *
   * Returns:
   *   当前 Environment 实例。
   */
  async enter(): Promise<this> {
    if (this.enteredValue) {
      throw new Error('Environment has already been entered.');
    }
    this.enteredValue = true;
    await this.setup();
    return this;
  }

  /** 退出环境生命周期并释放资源。 */
  async exit(): Promise<void> {
    try {
      await this.teardown();
    } finally {
      await this.fileOperatorValue?.close?.();
      await this.shellValue?.close?.();
      this.fileOperatorValue = null;
      this.shellValue = null;
      this.enteredValue = false;
    }
  }
}
