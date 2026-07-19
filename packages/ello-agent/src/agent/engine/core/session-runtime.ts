/**
 * 会话持久化与压缩的运行时胶水层。
 *
 * 把回合循环与可选的「会话存储」「会话压缩器」解耦：仅当配置里同时提供了
 * `transcript` 存储与 `sessionId` 时才真正读写历史，否则运行不持久化消息。
 * 因此一次性（无持久化）运行与带持久化的长会话共用同一套循环代码。
 */
import type {
  AgentMessage,
  AgentRunContext,
  AgentRunResult,
  CreateAgentOptions,
  SessionCompactionReport,
} from '../api/types.js';

/**
 * 运行开始时载入既有会话历史。
 *
 * 未配置会话存储或缺少 `sessionId` 时返回空数组，使运行从零开始。
 */
export async function loadSessionMessages(options: {
  readonly config: CreateAgentOptions;
  readonly sessionId?: string;
}): Promise<AgentMessage[]> {
  const messages: AgentMessage[] = [];
  if (
    options.config.transcript !== undefined &&
    options.sessionId !== undefined
  ) {
    messages.push(...(await options.config.transcript.load(options.sessionId)));
  }
  return messages;
}

/**
 * 运行结束时把本次新增的消息追加到会话存储。
 *
 * `sessionId` 取自结果元数据；只追加 `messagesToAppend`（即本次运行相对
 * 载入历史新产生的部分），避免重复写入已持久化的历史。
 */
export async function saveSessionResult(options: {
  readonly config: CreateAgentOptions;
  readonly result: AgentRunResult;
  readonly messagesToAppend: AgentMessage[];
}): Promise<void> {
  const sessionId =
    typeof options.result.metadata.sessionId === 'string'
      ? options.result.metadata.sessionId
      : undefined;
  if (options.config.transcript !== undefined && sessionId !== undefined) {
    await options.config.transcript.append(
      sessionId,
      options.messagesToAppend,
      options.result.metadata,
    );
  }
}

/**
 * 运行收尾时尝试压缩会话历史。
 *
 * 仅当 `sessionId`、会话存储与压缩器三者齐备时才调用压缩器的 `maybeCompact`，
 * 是否真正压缩由压缩器自行判定。返回压缩报告数组（未压缩时为空），用于运行诊断。
 */
export async function compactSession(options: {
  readonly config: CreateAgentOptions;
  readonly sessionId?: string;
  readonly ctx: AgentRunContext;
}): Promise<SessionCompactionReport[]> {
  if (
    options.sessionId === undefined ||
    options.config.transcript === undefined ||
    options.config.compaction === undefined
  ) {
    return [];
  }
  const report = await options.config.compaction.maybeCompact(
    options.sessionId,
    options.ctx,
  );
  return report === null ? [] : [report];
}
