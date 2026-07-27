/**
 * benchmark 启动 job 私有的 App Server，并通过 Unix socket 暴露标准 listener 生命周期。
 *
 * App Server state root 与任务 workspace 分离，关闭按 listener 后 server 的顺序执行。
 */
import path from 'node:path';

import { createApp } from '@ello/agent';
import type { Capability } from '@ello/agent/protocol';
import {
  listenEndpoint,
  type AgentRuntime,
  type ServerListener,
} from '@ello/agent/runtime';

export interface BenchmarkServerOptions {
  readonly root: string;
  readonly socketPath: string;
  readonly runtime: AgentRuntime;
  readonly capabilities?: ReadonlyArray<Capability>;
}

export interface BenchmarkServer {
  readonly endpoint: string;
  close(): Promise<void>;
}

export async function startBenchmarkServer(
  options: BenchmarkServerOptions,
): Promise<BenchmarkServer> {
  const socketPath = path.resolve(options.socketPath);
  const endpoint = `unix://${encodeURIComponent(socketPath)}`;
  const server = await createApp({
    root: path.resolve(options.root),
    transports: ['unix'],
    agentRuntime: options.runtime,
  });
  let listener: ServerListener | undefined;
  try {
    await server.start();
    listener = await listenEndpoint({
      endpoint,
      server,
      capabilities: options.capabilities ?? [
        'read',
        'submit',
        'approve',
        'write',
        'admin',
      ],
    });
  } catch (error) {
    await server.stop('benchmark server startup failed');
    throw error;
  }
  return {
    endpoint,
    async close() {
      const failures: unknown[] = [];
      try {
        await listener.close();
      } catch (error) {
        failures.push(error);
      }
      try {
        await server.stop('benchmark run completed');
      } catch (error) {
        failures.push(error);
      }
      if (failures.length > 0) {
        throw new AggregateError(
          failures,
          'Benchmark App Server shutdown failed.',
        );
      }
    },
  };
}
