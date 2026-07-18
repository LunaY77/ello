import { readFile } from 'node:fs/promises';

import { describe, expect, it } from 'vitest';

import {
  CLIENT_REQUEST_SCHEMAS,
  ELLO_PROTOCOL_VERSION,
  RpcMessageSchema,
  SERVER_NOTIFICATION_SCHEMAS,
  SERVER_REQUEST_SCHEMAS,
  parseServerNotificationParams,
  parseServerRequestParams,
  parseServerRequestResult,
} from '../protocol/v1/index.js';

interface ProtocolFixture {
  readonly protocolVersion: number;
  readonly clientRequests: Readonly<Record<string, Readonly<Record<string, unknown>>>>;
  readonly serverNotifications: readonly string[];
  readonly serverRequests: readonly string[];
  readonly wireSamples: {
    readonly stringIdRequest: unknown;
    readonly numberIdRequest: unknown;
    readonly clientNotification: unknown;
    readonly successResponse: unknown;
    readonly errorResponse: unknown;
    readonly serverNotification: {
      readonly method: 'server/ready';
      readonly params: unknown;
    };
    readonly serverRequest: {
      readonly method: 'item/commandExecution/requestApproval';
      readonly params: unknown;
    };
    readonly serverRequestResult: unknown;
  };
}

describe('Ello protocol v1 fixtures', () => {
  it('固定完整方法目录，任何 schema 增删都会触发 fixture drift', async () => {
    const fixture = await loadFixture();

    expect(fixture.protocolVersion).toBe(ELLO_PROTOCOL_VERSION);
    expect(Object.keys(fixture.clientRequests)).toEqual(
      Object.keys(CLIENT_REQUEST_SCHEMAS),
    );
    expect(fixture.serverNotifications).toEqual(
      Object.keys(SERVER_NOTIFICATION_SCHEMAS),
    );
    expect(fixture.serverRequests).toEqual(Object.keys(SERVER_REQUEST_SCHEMAS));
  });

  it('每个稳定 Client method 都接受规范 fixture 并拒绝 unknown field', async () => {
    const fixture = await loadFixture();

    for (const [method, schema] of Object.entries(CLIENT_REQUEST_SCHEMAS)) {
      const params = fixture.clientRequests[method];
      expect(params, `${method} fixture`).toBeDefined();
      expect(schema.safeParse(params).success, `${method} valid params`).toBe(true);
      expect(
        schema.safeParse({ ...params, unknownFixtureField: true }).success,
        `${method} strict params`,
      ).toBe(false);
    }
  });

  it('覆盖 string/number/null id、notification 和 Server Request 双向 schema', async () => {
    const { wireSamples } = await loadFixture();

    expect(RpcMessageSchema.parse(wireSamples.stringIdRequest)).toBeDefined();
    expect(RpcMessageSchema.parse(wireSamples.numberIdRequest)).toBeDefined();
    expect(RpcMessageSchema.parse(wireSamples.clientNotification)).toBeDefined();
    expect(RpcMessageSchema.parse(wireSamples.successResponse)).toBeDefined();
    expect(RpcMessageSchema.parse(wireSamples.errorResponse)).toBeDefined();
    expect(RpcMessageSchema.parse(wireSamples.serverNotification)).toBeDefined();
    expect(RpcMessageSchema.parse(wireSamples.serverRequest)).toBeDefined();
    expect(
      parseServerNotificationParams(
        wireSamples.serverNotification.method,
        wireSamples.serverNotification.params,
      ),
    ).toEqual({ protocolVersion: 1 });
    expect(
      parseServerRequestParams(
        wireSamples.serverRequest.method,
        wireSamples.serverRequest.params,
      ),
    ).toMatchObject({ threadId: 'thr_fixture', command: ['pnpm', 'test'] });
    expect(
      parseServerRequestResult(
        wireSamples.serverRequest.method,
        wireSamples.serverRequestResult,
      ),
    ).toEqual({ decision: 'accept' });
  });
});

async function loadFixture(): Promise<ProtocolFixture> {
  return JSON.parse(
    await readFile(
      new URL('../protocol/v1/fixtures/catalog.json', import.meta.url),
      'utf8',
    ),
  ) as ProtocolFixture;
}
