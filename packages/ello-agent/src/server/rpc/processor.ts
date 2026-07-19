import { ZodError, type z } from 'zod';

import { ConfigValidationError } from '../../config/index.js';
import {
  AppServerError,
  CLIENT_REQUEST_SCHEMAS,
  ELLO_PROTOCOL_VERSION,
  RpcNotificationSchema,
  RpcRequestSchema,
  RpcResponseSchema,
  SERVER_NOTIFICATION_SCHEMAS,
  SERVER_REQUEST_SCHEMAS,
  parseClientNotificationParams,
  parseClientParams,
  parseClientResult,
  toRpcError,
  type ClientMethod,
  type InitializeResultSchema,
  type RpcRequest,
} from '../../protocol/v1/index.js';
import type { ServerConnection } from '../connection/server-connection.js';

import { isClientMethod, RpcRouter } from './router.js';

type InitializeResult = z.output<typeof InitializeResultSchema>;

export interface RpcProcessorOptions {
  readonly router: RpcRouter;
  readonly version: string;
  readonly transports: readonly ('stdio' | 'websocket' | 'unix')[];
}

/** JSON 解析、握手 gate、schema 验证和错误映射只在这一层发生。 */
export class RpcProcessor {
  private readonly decoder = new TextDecoder('utf-8', { fatal: true });

  constructor(private readonly options: RpcProcessorOptions) {}

  async process(
    connection: ServerConnection,
    bytes: Uint8Array,
  ): Promise<void> {
    let value: unknown;
    try {
      value = JSON.parse(this.decoder.decode(bytes));
    } catch (error) {
      await this.sendError(
        connection,
        null,
        new AppServerError({
          type: 'parseError',
          message: 'Invalid JSON.',
          cause: error,
        }),
      );
      return;
    }
    const response = RpcResponseSchema.safeParse(value);
    if (response.success) {
      try {
        connection.serverRequests.resolve(response.data);
      } catch (error) {
        await connection.close(errorMessage(error));
      }
      return;
    }
    const request = RpcRequestSchema.safeParse(value);
    if (request.success) {
      await this.processRequest(connection, request.data);
      return;
    }
    const notification = RpcNotificationSchema.safeParse(value);
    if (notification.success) {
      await this.processNotification(
        connection,
        notification.data.method,
        notification.data.params,
      );
      return;
    }
    await this.sendError(
      connection,
      requestIdFrom(value),
      new AppServerError({
        type: 'invalidRequest',
        message: 'Invalid JSON-RPC request.',
        details: { issues: request.error.issues },
      }),
    );
  }

  private async processRequest(
    connection: ServerConnection,
    request: RpcRequest,
  ): Promise<void> {
    const release =
      request.method === 'initialize'
        ? undefined
        : connection.holdUnsolicited();
    try {
      if (request.method === 'initialize') {
        await this.initialize(connection, request);
        return;
      }
      if (connection.state.phase !== 'ready') {
        throw new AppServerError({
          type: 'notInitialized',
          message: 'Connection has not completed initialize/initialized.',
        });
      }
      if (!isClientMethod(request.method)) {
        throw new AppServerError({
          type: 'methodNotFound',
          message: `Unknown method ${request.method}.`,
          details: { method: request.method },
        });
      }
      const result = await this.options.router.dispatch(
        connection,
        request.method,
        request.params,
      );
      await connection.sendResult(
        request.id,
        validateResult(request.method, result),
      );
    } catch (error) {
      await this.sendError(connection, request.id, normalizeError(error));
    } finally {
      await release?.().catch((error: unknown) =>
        connection.close(errorMessage(error)),
      );
    }
  }

  private async initialize(
    connection: ServerConnection,
    request: RpcRequest,
  ): Promise<void> {
    if (connection.state.phase !== 'connected') {
      throw new AppServerError({
        type: 'alreadyInitialized',
        message: 'initialize may only be sent once.',
      });
    }
    const rawVersion = request.params.protocolVersion;
    if (rawVersion !== ELLO_PROTOCOL_VERSION) {
      const error = new AppServerError({
        type: 'protocolMismatch',
        message: `Unsupported protocol version ${String(rawVersion)}.`,
        details: { supported: ELLO_PROTOCOL_VERSION, received: rawVersion },
      });
      await this.sendError(connection, request.id, error);
      await connection.close(error.message);
      return;
    }
    const params = validateInitializeParams(request.params);
    connection.state.initialize(params);
    const result: InitializeResult = {
      protocolVersion: ELLO_PROTOCOL_VERSION,
      serverInfo: { name: 'ello-agent', version: this.options.version },
      serverCapabilities: {
        transports: this.options.transports,
        methods: Object.keys(CLIENT_REQUEST_SCHEMAS),
        notifications: Object.keys(SERVER_NOTIFICATION_SCHEMAS),
        serverRequests: Object.keys(SERVER_REQUEST_SCHEMAS),
        granted: [...connection.state.capabilities],
      },
    };
    await connection.sendResult(request.id, result);
  }

  private async processNotification(
    connection: ServerConnection,
    method: string,
    params: unknown,
  ): Promise<void> {
    if (method !== 'initialized') {
      await connection.close(`Unknown Client notification ${method}.`);
      return;
    }
    if (connection.state.phase !== 'awaitingInitialized') {
      await connection.close('initialized notification is out of order.');
      return;
    }
    parseClientNotificationParams('initialized', params);
    connection.state.ready();
    await connection.sendNotification({
      method: 'server/ready',
      params: { protocolVersion: ELLO_PROTOCOL_VERSION },
    });
  }

  private sendError(
    connection: ServerConnection,
    id: string | number | null,
    error: AppServerError,
  ): Promise<void> {
    return connection.sendError(id, toRpcError(error));
  }
}

function normalizeError(error: unknown): AppServerError {
  if (error instanceof AppServerError) return error;
  if (error instanceof ConfigValidationError) {
    return new AppServerError({
      type: 'configInvalid',
      message: error.message,
      details: { issues: error.issues },
      cause: error,
    });
  }
  return new AppServerError({
    type: 'internal',
    message: errorMessage(error),
    cause: error,
  });
}

function validateInitializeParams(rawParams: unknown) {
  try {
    return parseClientParams('initialize', rawParams);
  } catch (error) {
    if (!(error instanceof ZodError)) throw error;
    throw new AppServerError({
      type: 'invalidParams',
      message: 'Request params do not match the protocol schema.',
      details: { method: 'initialize', issues: error.issues },
      cause: error,
    });
  }
}

function validateResult<M extends ClientMethod>(method: M, result: unknown) {
  try {
    return parseClientResult(method, result);
  } catch (error) {
    if (!(error instanceof ZodError)) throw error;
    throw new AppServerError({
      type: 'responseValidationFailed',
      message: `Server result for ${method} does not match the protocol schema.`,
      details: { method, issues: error.issues },
      cause: error,
    });
  }
}

function requestIdFrom(value: unknown): string | number | null {
  if (typeof value !== 'object' || value === null || !('id' in value))
    return null;
  const id = value.id;
  return typeof id === 'string' || typeof id === 'number' ? id : null;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
