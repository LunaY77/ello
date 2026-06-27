import type { ModelMessage } from 'ai';

import type { AgentRuntimeRunInput } from '../agents.js';
import {
  createCompactionEntry,
  createMessageEntry,
  createModelChangeEntry,
  type SessionEntry,
  type SessionStorage,
} from '../session/index.js';

import { normalizeRunMessages } from './messages.js';

export async function loadSessionHistory(
  session: SessionStorage | null,
): Promise<ModelMessage[] | null> {
  if (session === null) {
    return null;
  }

  const leafId = await session.getLeafId();
  const entries = await session.getPathToRoot(leafId);
  return entries
    .filter(
      (entry): entry is Extract<SessionEntry, { type: 'message' }> =>
        entry.type === 'message',
    )
    .map((entry) => entry.message as ModelMessage);
}

export async function persistSessionRun(
  session: SessionStorage | null,
  input: AgentRuntimeRunInput,
  result: { responseMessages: ModelMessage[] },
): Promise<void> {
  if (session === null) {
    return;
  }

  for (const message of normalizeRunMessages(input).concat(
    result.responseMessages,
  )) {
    await session.appendEntry(
      createMessageEntry({
        message: message as Record<string, unknown>,
      }),
    );
  }
}

export async function persistModelChange(
  session: SessionStorage | null,
  modelName: string,
): Promise<void> {
  if (session === null) {
    return;
  }

  await session.appendEntry(
    createModelChangeEntry({
      modelName,
    }),
  );
}

export async function persistCompactionIfNeeded(
  session: SessionStorage | null,
  before: ModelMessage[],
  after: ModelMessage[],
): Promise<void> {
  if (session === null || after.length >= before.length) {
    return;
  }

  await session.appendEntry(
    createCompactionEntry({
      summary: 'Context was compacted',
      firstKeptEntryId: '',
      tokensBefore: before.length,
      details: {
        originalMessageCount: before.length,
        compactedMessageCount: after.length,
      },
    }),
  );
}
