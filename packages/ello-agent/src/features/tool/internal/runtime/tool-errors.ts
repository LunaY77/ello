/**
 * 本文件统一 coding 工具的失败诊断与重试预算。
 *
 * 工具实现只需要抛出原始错误；适配层在这里生成稳定指纹、错误码和下一步策略，
 * 避免每个工具自行拼接一套无法统计的错误文本。
 */
import { createHash } from 'node:crypto';

/** 工具失败后提供给模型、事件流和测试的稳定诊断。 */
export interface ToolFailureDiagnostic {
  readonly code: string;
  readonly fingerprint: string;
  readonly retryable: boolean;
  readonly attempt: number;
  readonly attemptsRemaining: number;
  readonly strategy: 'retry_with_context' | 'switch_strategy' | 'stop';
  readonly message: string;
}

/** 携带结构化诊断的工具执行错误。 */
export class CodingToolExecutionError extends Error {
  readonly diagnostic: ToolFailureDiagnostic;

  /**
   * 创建可被 engine 原样记录的工具错误。
   *
   * Args:
   * - `toolName`: 发生失败的稳定工具名。
   * - `diagnostic`: 已完成指纹和预算计算的诊断。
   * - `cause`: 工具抛出的原始错误；保留给日志和调试链路。
   */
  constructor(
    toolName: string,
    diagnostic: ToolFailureDiagnostic,
    cause: unknown,
  ) {
    super(renderFailure(toolName, diagnostic), { cause });
    this.name = 'CodingToolExecutionError';
    this.diagnostic = diagnostic;
  }
}

/** 同一个 run 内共享的失败预算；相同指纹最多建议重试两次。 */
export class ToolFailureTracker {
  private readonly attempts = new Map<string, number>();

  /**
   * 把原始工具异常转换成带稳定重试语义的错误。
   *
   * Args:
   * - `toolName`: 发生失败的工具名。
   * - `error`: 工具实现抛出的原始异常。
   *
   * Returns:
   * - 返回包含错误码、指纹、剩余预算和建议策略的执行错误。
   */
  create(toolName: string, error: unknown): CodingToolExecutionError {
    if (error instanceof CodingToolExecutionError) return error;
    const message = errorMessage(error);
    const code = classifyCode(error, message);
    const retryable = isRetryable(code);
    const fingerprint = createHash('sha256')
      .update(`${toolName}\0${code}\0${normalizeMessage(message)}`)
      .digest('hex')
      .slice(0, 16);
    const attempt = (this.attempts.get(fingerprint) ?? 0) + 1;
    this.attempts.set(fingerprint, attempt);
    const attemptsRemaining = retryable ? Math.max(0, 2 - attempt) : 0;
    const strategy = !retryable
      ? 'stop'
      : attemptsRemaining > 0
        ? 'retry_with_context'
        : 'switch_strategy';
    return new CodingToolExecutionError(
      toolName,
      {
        code,
        fingerprint,
        retryable: retryable && attemptsRemaining > 0,
        attempt,
        attemptsRemaining,
        strategy,
        message,
      },
      error,
    );
  }
}

function renderFailure(
  toolName: string,
  diagnostic: ToolFailureDiagnostic,
): string {
  return [
    `${toolName} failed [${diagnostic.code}; fingerprint=${diagnostic.fingerprint}; attempt=${diagnostic.attempt}; remaining=${diagnostic.attemptsRemaining}; strategy=${diagnostic.strategy}]`,
    diagnostic.message,
  ].join('\n');
}

function classifyCode(error: unknown, message: string): string {
  const errno =
    typeof error === 'object' && error !== null && 'code' in error
      ? Reflect.get(error, 'code')
      : undefined;
  if (typeof errno === 'string' && errno !== '') return errno;
  if (/permission|denied|outside (?:the )?allowed/iu.test(message)) {
    return 'PERMISSION_DENIED';
  }
  if (/not found|no such file|enoent/iu.test(message)) return 'PATH_NOT_FOUND';
  if (/timed? ?out|timeout/iu.test(message)) return 'TIMEOUT';
  if (/invalid|must |expected |unrecognized/iu.test(message)) {
    return 'INVALID_INPUT';
  }
  if (/stale|changed since|failed to find|occurs \d+ times/iu.test(message)) {
    return 'STALE_CONTEXT';
  }
  return 'TOOL_EXECUTION_FAILED';
}

function isRetryable(code: string): boolean {
  return !['PERMISSION_DENIED', 'INVALID_INPUT'].includes(code);
}

function normalizeMessage(message: string): string {
  return message
    .toLocaleLowerCase()
    .replaceAll(/\b[0-9a-f]{16,}\b/gu, '<hash>')
    .replaceAll(/\d+/gu, '<n>')
    .replaceAll(/\s+/gu, ' ')
    .trim()
    .slice(0, 500);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
