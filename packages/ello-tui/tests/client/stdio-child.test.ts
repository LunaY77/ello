import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { PassThrough } from 'node:stream';

import {
  ELLO_PROTOCOL_VERSION,
  type InitializeParamsSchema,
} from '@ello/agent/protocol';
import { afterEach, describe, expect, it } from 'vitest';
import type { z } from 'zod';

import { AppServerClient } from '../../src/api/client.js';
import {
  LocalChildStderrRouter,
  StdioChildTransport,
} from '../../src/api/transports/stdio-child.js';

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { force: true, recursive: true })),
  );
});

describe('LocalChildStderrRouter', () => {
  it('过滤跨 chunk 的本地 Server info 生命周期日志', () => {
    const { output, router } = createRouter();

    router.push(Buffer.from('{"level":"info","event":"server.'));
    router.push(Buffer.from('stopping","reason":"stdio EOF"}\n'));
    router.end();

    expect(output()).toBe('');
  });

  it('保留 warning、error 和非 JSON stderr', () => {
    const { output, router } = createRouter();

    router.push(
      Buffer.from(
        [
          '{"level":"warn","event":"server.slow"}',
          '{"level":"error","event":"server.failed"}',
          'native stderr',
          'final partial',
        ].join('\n'),
      ),
    );
    router.end();

    expect(output()).toBe(
      [
        '{"level":"warn","event":"server.slow"}',
        '{"level":"error","event":"server.failed"}',
        'native stderr',
        'final partial',
      ].join('\n'),
    );
  });
});

describe('StdioChildTransport', () => {
  it('keeps the local child alive after a burst larger than the inbound budget', async () => {
    const directory = await mkdtemp(path.join(tmpdir(), 'ello-stdio-burst-'));
    temporaryDirectories.push(directory);
    const entryPath = path.join(directory, 'server.mjs');
    await writeFile(entryPath, stdioBurstServer(), 'utf8');
    const transport = new StdioChildTransport({
      entryPath,
      stderr: new PassThrough(),
    });
    const client = new AppServerClient({ transport });
    let received = 0;
    let resolveBurst = (): void => undefined;
    const burst = new Promise<void>((resolve) => {
      resolveBurst = resolve;
    });
    client.onNotification((notification) => {
      if (notification.method !== 'server/ready') return;
      received += 1;
      if (received === 300) resolveBurst();
    });

    try {
      await client.connect();
      await client.initialize(initializeParams);
      await burst;

      expect(received).toBe(300);
      expect(client.state).toBe('ready');
      await expect(client.request('server/read', {})).resolves.toMatchObject({
        state: 'ready',
      });
    } finally {
      await client.close();
    }
  });
});

const initializeParams: z.input<typeof InitializeParamsSchema> = {
  clientInfo: { name: 'test', title: 'Test Client', version: '1.0.0' },
  protocolVersion: ELLO_PROTOCOL_VERSION,
  capabilities: {
    experimentalApi: false,
    supportsServerRequests: true,
    supportsUserInput: true,
    optOutNotificationMethods: [],
    platform: 'automation',
  },
};

function createRouter(): {
  readonly router: LocalChildStderrRouter;
  readonly output: () => string;
} {
  const target = new PassThrough();
  const chunks: Buffer[] = [];
  target.on('data', (chunk: Buffer) => chunks.push(chunk));
  return {
    router: new LocalChildStderrRouter(target),
    output: () => Buffer.concat(chunks).toString('utf8'),
  };
}

function stdioBurstServer(): string {
  return `
import { createInterface } from 'node:readline';

const protocolVersion = ${JSON.stringify(ELLO_PROTOCOL_VERSION)};
const lines = createInterface({ input: process.stdin });
const send = (message) => process.stdout.write(JSON.stringify(message) + '\\n');

lines.on('line', (line) => {
  const message = JSON.parse(line);
  if (message.method === 'initialize') {
    send({
      jsonrpc: '2.0',
      id: message.id,
      result: {
        protocolVersion,
        serverInfo: { name: 'ello-agent', version: '1.0.0' },
        serverCapabilities: {
          transports: ['stdio'],
          methods: ['server/read'],
          notifications: [],
          serverRequests: [],
          granted: ['read'],
        },
      },
    });
    return;
  }
  if (message.method === 'initialized') {
    const burst = Array.from({ length: 300 }, () =>
      JSON.stringify({
        jsonrpc: '2.0',
        method: 'server/ready',
        params: { protocolVersion },
      }),
    );
    process.stdout.write(burst.join('\\n') + '\\n');
    return;
  }
  if (message.method === 'server/read') {
    send({
      jsonrpc: '2.0',
      id: message.id,
      result: {
        protocolVersion,
        version: '1.0.0',
        state: 'ready',
        uptimeMs: 1,
        capabilities: ['read'],
      },
    });
  }
});
`;
}
