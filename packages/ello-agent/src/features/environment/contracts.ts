/**
 * Environment feature 的稳定契约。
 *
 * Environment 拥有独立身份与 generation；Agent 只通过绑定工作目录和 grant 的 Handle
 * 访问文件与进程。该契约不依赖 Thread、Run、工具权限或 Agent engine。
 */

export type EnvironmentReference = string;
export type EnvironmentGeneration = number;
export type EnvironmentPath = string;
export type ProcessReference = string;

export interface ExecutionLocation {
  readonly environmentRef: EnvironmentReference;
  readonly workingDirectory: EnvironmentPath;
}

export interface EnvironmentGrant {
  /** `none` 表示 Handle 不在 Environment 已有边界之外追加操作系统隔离。 */
  readonly isolation: 'none';
}

export interface EnvironmentFileStat {
  readonly kind: 'file' | 'directory' | 'symlink' | 'other';
  readonly size: number;
  readonly modifiedAtMs: number;
}

export interface EnvironmentFileSystem {
  /**
   * 在 Handle 的工作目录中解析 Environment Path。
   *
   * Args:
   * - `targetPath`: 绝对路径或相对 Handle 工作目录的路径。
   *
   * Returns:
   * - 返回 Environment 自身路径空间中的稳定绝对路径。
   */
  resolvePath(targetPath: string): EnvironmentPath;
  /**
   * 读取路径元数据。
   *
   * Args:
   * - `targetPath`: 要观察的 Environment Path。
   *
   * Returns:
   * - Promise 兑现为不泄漏宿主实现对象的普通元数据。
   */
  stat(targetPath: string): Promise<EnvironmentFileStat>;
  /**
   * 读取完整文件字节。
   *
   * Args:
   * - `targetPath`: 要读取的 Environment Path。
   *
   * Returns:
   * - Promise 兑现为独立字节快照。
   */
  readFile(targetPath: string): Promise<Uint8Array>;
  /**
   * 读取完整 UTF-8 文本。
   *
   * Args:
   * - `targetPath`: 要读取的 Environment Path。
   *
   * Returns:
   * - Promise 兑现为 UTF-8 文本。
   */
  readText(targetPath: string): Promise<string>;
  /**
   * 写入完整文件字节并按需创建父目录。
   *
   * Args:
   * - `targetPath`: 要写入的 Environment Path。
   * - `content`: 完整的新文件字节。
   *
   * Returns:
   * - Promise 在写入提交后兑现。
   */
  writeFile(targetPath: string, content: Uint8Array): Promise<void>;
  /**
   * 写入完整 UTF-8 文本并按需创建父目录。
   *
   * Args:
   * - `targetPath`: 要写入的 Environment Path。
   * - `content`: 完整的新文件文本。
   *
   * Returns:
   * - Promise 在写入提交后兑现。
   */
  writeText(targetPath: string, content: string): Promise<void>;
  /**
   * 列出目录的直接子项名称。
   *
   * Args:
   * - `targetPath`: 要列出的 Environment Path。
   *
   * Returns:
   * - Promise 兑现为按字典序排列的名称快照。
   */
  listDir(targetPath: string): Promise<string[]>;
  /**
   * 删除文件或空目录。
   *
   * Args:
   * - `targetPath`: 要删除的 Environment Path。
   *
   * Returns:
   * - Promise 在目标删除后兑现。
   */
  remove(targetPath: string): Promise<void>;
}

export type ProcessLifecycle = 'attached' | 'background';
export type ProcessSignal = 'SIGINT' | 'SIGTERM' | 'SIGKILL';

export interface ProcessLaunchRequest {
  /** 未提供 `args` 时按 shell 文本执行；提供时把 `command` 作为 executable。 */
  readonly command: string;
  readonly args?: readonly string[];
  readonly cwd?: EnvironmentPath;
  readonly env?: Readonly<Record<string, string>>;
  readonly input?: Uint8Array;
  readonly outputLimitBytes?: number;
}

export interface ExecRequest extends ProcessLaunchRequest {
  readonly maxRuntimeMs: number;
  readonly signal?: AbortSignal;
}

export type SpawnRequest = ProcessLaunchRequest &
  (
    | {
        readonly lifecycle?: 'attached';
        readonly maxRuntimeMs?: number;
      }
    | {
        readonly lifecycle: 'background';
        readonly maxRuntimeMs: number;
      }
  );

export interface ProcessOutputSnapshot {
  readonly data: Uint8Array;
  readonly totalBytes: number;
  /** 从输出开头丢弃的字节数；大于零表示有界缓存发生了截断。 */
  readonly truncatedBytes: number;
}

export interface ProcessOutputChunk extends ProcessOutputSnapshot {
  /** 当前数据在完整 stream 中的真实起点。 */
  readonly cursor: number;
  /** 下一次增量读取应携带的 cursor。 */
  readonly nextCursor: number;
  readonly complete: boolean;
}

export interface ProcessExit {
  readonly exitCode: number | null;
  readonly signal: string | null;
  readonly timedOut: boolean;
  readonly durationMs: number;
}

export interface ExecResult extends ProcessExit {
  readonly stdout: ProcessOutputSnapshot;
  readonly stderr: ProcessOutputSnapshot;
}

export interface InspectOptions {
  readonly stdoutCursor?: number;
  readonly stderrCursor?: number;
  readonly maxBytes?: number;
}

export interface ProcessObservation {
  readonly ref: ProcessReference;
  readonly status: 'running' | 'exited';
  readonly stdout: ProcessOutputChunk;
  readonly stderr: ProcessOutputChunk;
  readonly exit?: ProcessExit;
}

export interface WaitOptions {
  readonly timeoutMs?: number;
  readonly signal?: AbortSignal;
}

export interface EnvironmentProcesses {
  /**
   * 执行前台进程并收集有界 stdout、stderr 与退出状态。
   *
   * Args:
   * - `request`: 命令、工作目录、输入、输出上限和最大运行时间。
   *
   * Returns:
   * - Promise 在进程树退出且输出流关闭后兑现。
   */
  exec(request: ExecRequest): Promise<ExecResult>;
  /**
   * 启动受 Environment 登记的进程。
   *
   * Args:
   * - `request`: attached 或带最大运行时间的 background 启动请求。
   *
   * Returns:
   * - Promise 在进程成功启动后兑现为不透明引用。
   */
  spawn(request: SpawnRequest): Promise<ProcessReference>;
  /**
   * 观察进程状态并按 cursor 增量读取分流输出。
   *
   * Args:
   * - `ref`: 同一 Environment generation 内的进程引用。
   * - `options`: 两个 stream 的 cursor 和单次最大返回字节数。
   *
   * Returns:
   * - Promise 兑现为当前状态与输出快照。
   */
  inspect(
    ref: ProcessReference,
    options?: InspectOptions,
  ): Promise<ProcessObservation>;
  /**
   * 向进程 stdin 写入原始字节。
   *
   * Args:
   * - `ref`: 目标进程引用。
   * - `data`: 要写入但不自动关闭 stdin 的字节。
   *
   * Returns:
   * - Promise 在流接受数据后兑现。
   */
  write(ref: ProcessReference, data: Uint8Array): Promise<void>;
  /**
   * 关闭进程 stdin。
   *
   * Args:
   * - `ref`: 目标进程引用。
   *
   * Returns:
   * - Promise 在 stdin 完成关闭后兑现。
   */
  closeStdin(ref: ProcessReference): Promise<void>;
  /**
   * 等待进程终态但不改变其生命周期。
   *
   * Args:
   * - `ref`: 目标进程引用。
   * - `options`: 可选等待超时和取消信号；等待超时不会终止进程。
   *
   * Returns:
   * - Promise 在进程退出后兑现为退出状态。
   */
  wait(ref: ProcessReference, options?: WaitOptions): Promise<ProcessExit>;
  /**
   * 向整个进程树发送信号。
   *
   * Args:
   * - `ref`: 目标进程引用。
   * - `signal`: 允许发送的控制信号。
   *
   * Returns:
   * - Promise 在信号请求提交后兑现。
   */
  signal(ref: ProcessReference, signal: ProcessSignal): Promise<void>;
}

export interface EnvironmentHandle {
  readonly environmentRef: EnvironmentReference;
  readonly generation: EnvironmentGeneration;
  readonly workingDirectory: EnvironmentPath;
  readonly grant: EnvironmentGrant;
  readonly fileSystem: EnvironmentFileSystem;
  readonly processes: EnvironmentProcesses;
  /**
   * 生成当前 Handle 的稳定模型上下文说明。
   *
   * Args:
   * - 无：说明只读取 Handle 已绑定的身份、目录和能力。
   *
   * Returns:
   * - Promise 兑现为说明；没有说明时返回 `null`。
   */
  getInstructions(): Promise<string | null>;
  /**
   * 关闭使用关系并终止该 Handle 创建的 attached 进程。
   *
   * Args:
   * - 无：background 进程仍由 Environment 生命周期管理。
   *
   * Returns:
   * - Promise 在 Handle 独占资源释放后兑现。
   */
  close(): Promise<void>;
}

export interface Environments {
  /**
   * 为 Execution Location 建立绑定 generation 与 grant 的 Handle。
   *
   * Args:
   * - `location`: Environment Reference 与稳定工作目录。
   * - `grant`: 该 Handle 不可扩大的执行能力上限。
   *
   * Returns:
   * - Promise 在 Environment ready 且目录有效时兑现为 Handle。
   */
  attach(
    location: ExecutionLocation,
    grant: EnvironmentGrant,
  ): Promise<EnvironmentHandle>;
  /**
   * 关闭 Environment adapter 拥有的全部进程与句柄。
   *
   * Args:
   * - 无：关闭后不再接受 attach。
   *
   * Returns:
   * - Promise 在全部 generation 资源释放后兑现。
   */
  close(): Promise<void>;
}

export interface CreateLocalEnvironmentsOptions {
  readonly environmentRef?: EnvironmentReference;
  readonly shellExecutable?: string;
  readonly processOutputLimitBytes?: number;
}
