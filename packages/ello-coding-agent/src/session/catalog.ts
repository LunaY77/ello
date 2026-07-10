import { appendFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

import type { AgentMessage } from '@ello/agent';
import { z } from 'zod';

const CatalogRecordSchema = z
  .object({
    sessionId: z.string(),
    cwd: z.string(),
    path: z.string(),
    createdAt: z.string(),
    title: z.string().optional(),
    messageCount: z.number().int().nonnegative(),
    lastUserText: z.string().optional(),
    lastAssistantText: z.string().optional(),
    lastToolText: z.string().optional(),
    updatedAt: z.string(),
    sourceFileMtime: z.string(),
  })
  .strict();

export type SessionCatalogRecord = z.infer<typeof CatalogRecordSchema>;

export class SessionCatalog {
  private readonly file: string;

  constructor(private readonly sessionDir: string) {
    this.file = path.join(sessionDir, 'catalog.jsonl');
  }

  async upsert(record: SessionCatalogRecord): Promise<void> {
    await mkdir(this.sessionDir, { recursive: true });
    await appendFile(this.file, `${JSON.stringify(record)}\n`, 'utf8');
  }

  async get(sessionId: string): Promise<SessionCatalogRecord | null> {
    return (await this.latest()).get(sessionId) ?? null;
  }

  async list(): Promise<readonly SessionCatalogRecord[]> {
    return [...(await this.latest()).values()]
      .filter((record) => record.messageCount > 0)
      .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
  }

  async recordMessages(
    base: SessionCatalogRecord,
    messages: readonly AgentMessage[],
    sourceFileMtime: string,
  ): Promise<void> {
    let lastUserText = base.lastUserText;
    let lastAssistantText = base.lastAssistantText;
    let lastToolText = base.lastToolText;
    for (const message of messages) {
      const text = messageText(message);
      if (message.role === 'user') lastUserText = text;
      else if (message.role === 'assistant') lastAssistantText = text;
      else if (message.role === 'tool') lastToolText = text;
    }
    await this.upsert({
      ...base,
      messageCount: base.messageCount + messages.length,
      ...(lastUserText !== undefined ? { lastUserText } : {}),
      ...(lastAssistantText !== undefined ? { lastAssistantText } : {}),
      ...(lastToolText !== undefined ? { lastToolText } : {}),
      updatedAt: sourceFileMtime,
      sourceFileMtime,
    });
  }

  async replace(records: readonly SessionCatalogRecord[]): Promise<void> {
    await mkdir(this.sessionDir, { recursive: true });
    await writeFile(
      this.file,
      records.length === 0
        ? ''
        : `${records.map((record) => JSON.stringify(record)).join('\n')}\n`,
      'utf8',
    );
  }

  private async latest(): Promise<Map<string, SessionCatalogRecord>> {
    let text: string;
    try {
      text = await readFile(this.file, 'utf8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        return new Map();
      }
      throw error;
    }
    const latest = new Map<string, SessionCatalogRecord>();
    for (const [index, line] of text.split(/\n+/u).filter(Boolean).entries()) {
      let value: unknown;
      try {
        value = JSON.parse(line);
      } catch (error) {
        throw new Error(
          `Invalid JSON in session catalog at line ${index + 1}.`,
          {
            cause: error,
          },
        );
      }
      const parsed = CatalogRecordSchema.safeParse(value);
      if (!parsed.success) {
        throw new Error(
          `Invalid session catalog line ${index + 1}: ${parsed.error.message}`,
        );
      }
      latest.set(parsed.data.sessionId, parsed.data);
    }
    return latest;
  }
}

function messageText(message: AgentMessage): string {
  return typeof message.content === 'string'
    ? message.content.slice(0, 500)
    : JSON.stringify(message.content).slice(0, 500);
}
