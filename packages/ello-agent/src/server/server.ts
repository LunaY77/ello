import type { Writable } from 'node:stream';

import type { Capability } from '../protocol/v1/index.js';

import { ServerConnection } from './connection/server-connection.js';
import type { RpcServices } from './methods/server-services.js';
import { RpcProcessor } from './rpc/processor.js';
import { RpcRouter } from './rpc/router.js';
import { ThreadManager } from './runtime/thread-manager.js';
import type { AppServerTransport } from './transport/transport.js';

export type AgentServerState = 'starting' | 'ready' | 'stopping' | 'stopped';

export interface AgentServerOptions {
  readonly version: string;
  readonly threads: ThreadManager;
  readonly transports: readonly ('stdio' | 'websocket' | 'unix')[];
  readonly stderr?: Writable;
  readonly closeResources?: () => void | Promise<void>;
  readonly services: RpcServices;
}

/** Server 进程的唯一生命周期所有者。 */
export class AgentServer {
  readonly protocolVersion = 1;
  private currentState: AgentServerState = 'starting';
  private readonly threads: ThreadManager;
  private readonly connections = new Map<string, ServerConnection>();
  private readonly processor: RpcProcessor;
  private readonly stderr: Writable;
  private readonly closeResources: () => void | Promise<void>;
  private readonly startedAt = Date.now();
  private readonly stoppedPromise: Promise<void>;
  private resolveStopped: () => void = () => undefined;

  constructor(private readonly options: AgentServerOptions) {
    this.threads = options.threads;
    this.stderr = options.stderr ?? process.stderr;
    this.closeResources = options.closeResources ?? (() => undefined);
    this.stoppedPromise = new Promise((resolve) => {
      this.resolveStopped = resolve;
    });
    const router = new RpcRouter({
      threads: this.threads,
      version: options.version,
      startedAt: this.startedAt,
      requestShutdown: (reason) => {
        setImmediate(() => void this.stop(reason));
      },
      services: options.services,
    });
    this.processor = new RpcProcessor({
      router,
      version: options.version,
      transports: options.transports,
    });
  }

  get state(): AgentServerState {
    return this.currentState;
  }

  async start(): Promise<void> {
    if (this.currentState !== 'starting') {
      throw new Error(`Cannot start AgentServer from ${this.currentState}.`);
    }
    await this.threads.initialize();
    this.currentState = 'ready';
  }

  async acceptTransport(
    transport: AppServerTransport,
    capabilities: readonly Capability[],
  ): Promise<void> {
    if (this.currentState !== 'ready') {
      throw new Error(
        `Cannot accept transport while Server is ${this.currentState}.`,
      );
    }
    if (this.connections.has(transport.connectionId)) {
      throw new Error(`Duplicate connection ${transport.connectionId}.`);
    }
    const connection = new ServerConnection(transport, capabilities);
    this.connections.set(connection.id, connection);
    try {
      await connection.run(this.processor);
    } catch (error) {
      this.log('connection.failed', {
        connectionId: connection.id,
        message: error instanceof Error ? error.message : String(error),
      });
    } finally {
      for (const threadId of connection.state.subscribedThreads) {
        await this.threads.unsubscribe(connection.id, threadId);
      }
      this.options.services.closeConnection?.(connection.id);
      this.connections.delete(connection.id);
    }
  }

  async stop(reason: string): Promise<void> {
    if (this.currentState === 'stopped') return;
    if (this.currentState === 'stopping') return this.stoppedPromise;
    this.currentState = 'stopping';
    this.log('server.stopping', { reason });
    const failures: unknown[] = [];
    await Promise.all(
      [...this.connections.values()].map(async (connection) => {
        try {
          await connection.close(reason);
        } catch (error) {
          failures.push(error);
        }
      }),
    );
    try {
      await this.threads.close();
    } catch (error) {
      failures.push(error);
    }
    try {
      await this.options.services.close();
    } catch (error) {
      failures.push(error);
    }
    try {
      await this.closeResources();
    } catch (error) {
      failures.push(error);
    }
    this.currentState = 'stopped';
    this.resolveStopped();
    if (failures.length > 0) {
      throw new AggregateError(failures, 'AgentServer shutdown failed.');
    }
  }

  waitUntilStopped(): Promise<void> {
    return this.stoppedPromise;
  }

  private log(event: string, details: Readonly<Record<string, unknown>>): void {
    this.stderr.write(
      `${JSON.stringify({
        level: 'info',
        event,
        at: new Date().toISOString(),
        ...details,
      })}\n`,
    );
  }
}
