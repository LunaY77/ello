#!/usr/bin/env node
/**
 * 本文件负责 ello-agent 的“main”模块职责。
 *
 * 模块只持有其声明的状态与资源，并通过显式类型连接调用方。
 * 输入不满足协议时直接失败，异步资源必须在对应生命周期结束前完成释放。
 */
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

import { createApp } from './app.js';
import type { Capability } from './protocol/v1/index.js';
import {
  listenEndpoint,
  type ServerListener,
} from './server/transport/listeners.js';
import { StdioTransport } from './server/transport/stdio.js';

/**
 * 在 `main` 模块 中执行 `runAppServer` 完整流程，并在返回前完成其必要副作用。
 *
 * Args:
 * - `argv`: `runAppServer` 所需的业务值；函数按声明读取，不补造缺失内容；省略时使用声明中明确的调用语义。
 *
 * Returns:
 * - Promise 在 `main` 模块 的异步副作用完整提交后兑现，不返回业务值。
 *
 * Throws:
 * - 当 `main` 模块 的输入、状态或外部资源不满足契约时直接抛错，并保留底层失败原因。
 */
export async function runAppServer(
  argv = process.argv.slice(2),
): Promise<void> {
  const { values } = parseArgs({
    args: argv,
    options: {
      listen: { type: 'string' },
      root: { type: 'string' },
      'auth-token-env': { type: 'string' },
      capabilities: { type: 'string' },
    },
    strict: true,
    allowPositionals: false,
  });
  const listen = values.listen;
  if (listen === undefined) throw new Error('--listen is required.');
  const kind = endpointKind(listen);
  const authToken =
    values['auth-token-env'] === undefined
      ? undefined
      : readAuthToken(values['auth-token-env']);
  const capabilities = parseCapabilities(values.capabilities);
  const server = await createApp({
    transports: [kind],
    ...(values.root === undefined ? {} : { root: values.root }),
  });
  let stopping = false;
  const stop = (reason: string) => {
    if (stopping) return;
    stopping = true;
    void server.stop(reason).catch((error: unknown) => {
      writeFailure(error);
      process.exitCode = 1;
    });
  };
  const onSigterm = () => stop('SIGTERM');
  const onSigint = () => stop('SIGINT');
  process.once('SIGTERM', onSigterm);
  process.once('SIGINT', onSigint);
  try {
    await server.start();
    if (listen === 'stdio://') {
      const transport = new StdioTransport();
      await server.acceptTransport(transport, [
        'read',
        'submit',
        'approve',
        'write',
        'admin',
      ]);
      await server.stop('stdio EOF');
      return;
    }
    const listener = await listenEndpoint({
      endpoint: listen,
      server,
      ...(authToken === undefined ? {} : { authToken }),
      capabilities,
    });
    await waitForServerStop(server, listener);
  } finally {
    process.off('SIGTERM', onSigterm);
    process.off('SIGINT', onSigint);
  }
}

function endpointKind(listen: string): 'stdio' | 'websocket' | 'unix' {
  if (listen === 'stdio://') return 'stdio';
  if (listen.startsWith('ws://') || listen.startsWith('wss://')) {
    return 'websocket';
  }
  if (listen.startsWith('unix://')) return 'unix';
  throw new Error(`Unsupported listen endpoint: ${listen}`);
}

function parseCapabilities(
  value: string | undefined,
): ReadonlyArray<Capability> {
  if (value === undefined) {
    return ['read', 'submit', 'approve', 'write', 'admin'];
  }
  const capabilities: Array<Capability> = [];
  for (const entry of value.split(',').map((item) => item.trim())) {
    if (entry === '') continue;
    if (!isCapability(entry)) {
      throw new Error(`Invalid capability list ${value}.`);
    }
    if (!capabilities.includes(entry)) capabilities.push(entry);
  }
  if (capabilities.length === 0) {
    throw new Error(`Invalid capability list ${value}.`);
  }
  return capabilities;
}

function isCapability(value: string): value is Capability {
  return (
    value === 'read' ||
    value === 'submit' ||
    value === 'approve' ||
    value === 'write' ||
    value === 'admin'
  );
}

function readAuthToken(name: string): string {
  const value = process.env[name];
  if (value === undefined || value === '') {
    throw new Error(
      `Authentication token environment variable ${name} is empty.`,
    );
  }
  return value;
}

async function waitForServerStop(
  server: Awaited<ReturnType<typeof createApp>>,
  listener: ServerListener,
): Promise<void> {
  try {
    await server.waitUntilStopped();
  } finally {
    await listener.close();
  }
}

function writeFailure(error: unknown): void {
  process.stderr.write(
    `${JSON.stringify({
      level: 'error',
      event: 'server.failed',
      at: new Date().toISOString(),
      message: error instanceof Error ? error.message : String(error),
    })}\n`,
  );
}

const invokedPath = process.argv[1];
if (
  invokedPath !== undefined &&
  fileURLToPath(import.meta.url) === invokedPath
) {
  runAppServer().catch((error: unknown) => {
    writeFailure(error);
    process.exitCode = 1;
  });
}
