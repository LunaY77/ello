import type {
  AgentMessage,
  AgentRunContext,
  AgentRunResult,
  CreateAgentOptions,
  SessionCompactionReport,
} from '../public/types.js';

export async function loadSessionMessages(options: {
  readonly config: CreateAgentOptions;
  readonly sessionId?: string;
}): Promise<AgentMessage[]> {
  const messages: AgentMessage[] = [];
  if (options.config.session !== undefined && options.sessionId !== undefined) {
    messages.push(...(await options.config.session.load(options.sessionId)));
  }
  return messages;
}

export async function saveSessionResult(options: {
  readonly config: CreateAgentOptions;
  readonly result: AgentRunResult;
  readonly messagesToAppend: AgentMessage[];
}): Promise<void> {
  const sessionId =
    typeof options.result.metadata.sessionId === 'string'
      ? options.result.metadata.sessionId
      : undefined;
  if (options.config.session !== undefined && sessionId !== undefined) {
    await options.config.session.append(
      sessionId,
      options.messagesToAppend,
      options.result.metadata,
    );
  }
}

export async function compactSession(options: {
  readonly config: CreateAgentOptions;
  readonly sessionId?: string;
  readonly ctx: AgentRunContext;
}): Promise<SessionCompactionReport[]> {
  if (
    options.sessionId === undefined ||
    options.config.session === undefined ||
    options.config.compactor === undefined
  ) {
    return [];
  }
  const report = await options.config.compactor.maybeCompact(
    options.sessionId,
    options.config.session,
    options.ctx,
  );
  return report === null ? [] : [report];
}
