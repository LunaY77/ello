import type {
  AgentMessage,
  AgentRunContext,
  AgentRunResult,
  AgentSessionExtension,
  CreateAgentOptions,
  SessionCompactionReport,
} from '../public/types.js';

import { asSessionExtension } from './events.js';

export async function loadSessionMessages(options: {
  readonly config: CreateAgentOptions;
  readonly extensions: readonly AgentSessionExtension[];
  readonly sessionId?: string;
}): Promise<AgentMessage[]> {
  const messages: AgentMessage[] = [];
  if (options.config.session !== undefined && options.sessionId !== undefined) {
    messages.push(...(await options.config.session.load(options.sessionId)));
  }
  for (const extension of options.extensions) {
    messages.push(...((await extension.loadMessages?.()) ?? []));
  }
  return messages;
}

export async function saveSessionResult(options: {
  readonly config: CreateAgentOptions;
  readonly extensions: readonly AgentSessionExtension[];
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
  for (const extension of options.extensions) {
    await extension.saveResult?.(options.result);
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

export function sessionExtensions(
  extensions: readonly import('../public/types.js').AgentExtension[],
): AgentSessionExtension[] {
  return extensions.map(asSessionExtension);
}
