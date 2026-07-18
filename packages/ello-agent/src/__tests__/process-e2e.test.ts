import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { once } from 'node:events';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer, type Server as HttpServer } from 'node:http';
import { createServer as createNetServer } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import WebSocket from 'ws';

const packageDir = fileURLToPath(new URL('../../', import.meta.url));
const entryPath = path.join(packageDir, 'dist/server/entry.js');
const execFile = promisify((await import('node:child_process')).execFile);
const roots = new Set<string>();
const children = new Set<ChildProcessWithoutNullStreams>();
const modelServers = new Set<MockChatServer>();

beforeAll(async () => {
  await execFile('pnpm', ['build'], { cwd: packageDir });
}, 60_000);

afterAll(async () => {
  await Promise.all(
    [...roots].map((root) => rm(root, { force: true, recursive: true })),
  );
});

afterEach(async () => {
  await Promise.allSettled([...children].map(terminateChild));
  await Promise.allSettled([...modelServers].map((server) => server.close()));
});

describe.sequential('actual App Server process', () => {
  it('stdio build 只输出 JSON-RPC，并正常处理 EOF 关停', async () => {
    const root = await temporaryRoot('ello-stdio-e2e-');
    const processPeer = new StdioProcessPeer(
      spawnServer(['--listen', 'stdio://', '--root', root], root),
    );

    await initialize(processPeer);
    const read = await rpc(processPeer, 2, 'server/read', {});
    expect(read.result).toMatchObject({ state: 'ready', protocolVersion: 1 });

    processPeer.endInput();
    const [code, signal] = await processPeer.exited();
    expect({ code, signal }).toEqual({ code: 0, signal: null });
    expect(processPeer.stdoutLines.length).toBeGreaterThan(0);
    for (const line of processPeer.stdoutLines) {
      expect(() => JSON.parse(line)).not.toThrow();
    }
    for (const line of processPeer.stderrLines) {
      expect(() => JSON.parse(line)).not.toThrow();
    }
  }, 30_000);

  it('真实 WebSocket 慢连接过载时不阻塞另一客户端', async () => {
    const root = await temporaryRoot('ello-slow-client-e2e-');
    const cwd = path.join(root, 'watched');
    await mkdir(cwd, { recursive: true });
    const port = await freePort();
    const child = spawnServer(
      ['--listen', `ws://127.0.0.1:${port}`, '--root', root],
      root,
    );
    await waitUntilReady(port, child);
    const slow = await WebSocketPeer.connect(`ws://127.0.0.1:${port}`);
    const fast = await WebSocketPeer.connect(`ws://127.0.0.1:${port}`);
    await initialize(slow);
    await initialize(fast);
    await rpc(slow, 2, 'fs/watch', { cwd, paths: ['.'] });

    slow.pauseIncoming();
    await writeFileBurst(cwd, 12_000);
    expect((await rpc(fast, 2, 'server/read', {})).result).toMatchObject({
      state: 'ready',
    });

    await new Promise((resolve) => setTimeout(resolve, 1_200));
    const closed = slow.waitClosed();
    slow.resumeIncoming();
    // reader 一直暂停，Server 的 close handshake 超时后会 terminate，客户端观察到 1006。
    await expect(closed).resolves.toMatchObject({ code: 1006 });
    expect((await rpc(fast, 3, 'server/read', {})).result).toMatchObject({
      state: 'ready',
    });

    await rpc(fast, 4, 'server/shutdown', {
      reason: 'slow client E2E complete',
    });
    await expect(waitForExit(child)).resolves.toEqual([0, null]);
    await fast.close();
  }, 60_000);

  it('active turn 收到 SIGTERM 后重启为 interrupted', async () => {
    const root = await temporaryRoot('ello-sigterm-e2e-');
    const cwd = path.join(root, 'workspace');
    await mkdir(cwd, { recursive: true });
    const modelServer = await MockChatServer.start([
      toolStep('call_pending', 'bash', {
        command: 'printf pending',
        timeoutMs: 1_000,
      }),
    ]);
    await writeConfig(root, modelServer.baseUrl);
    const firstPort = await freePort();
    const firstChild = spawnServer(
      ['--listen', `ws://127.0.0.1:${firstPort}`, '--root', root],
      root,
    );
    await waitUntilReady(firstPort, firstChild);
    const firstClient = await WebSocketPeer.connect(
      `ws://127.0.0.1:${firstPort}`,
    );
    await initialize(firstClient);
    const started = await rpc(firstClient, 2, 'thread/start', {
      cwd,
      subscribe: true,
    });
    const threadId = readThreadId(started);
    await rpc(firstClient, 3, 'turn/start', {
      threadId,
      input: [{ type: 'text', text: 'wait for approval' }],
    });
    await waitForServerRequest(
      firstClient,
      'item/commandExecution/requestApproval',
      [],
    );

    firstChild.kill('SIGTERM');
    await expect(waitForExit(firstChild)).resolves.toEqual([0, null]);

    const secondPort = await freePort();
    const secondChild = spawnServer(
      ['--listen', `ws://127.0.0.1:${secondPort}`, '--root', root],
      root,
    );
    await waitUntilReady(secondPort, secondChild);
    const secondClient = await WebSocketPeer.connect(
      `ws://127.0.0.1:${secondPort}`,
    );
    await initialize(secondClient);
    const recovered = await rpc(secondClient, 2, 'thread/read', {
      threadId,
      includeTurns: true,
      includeItems: true,
    });
    if (recovered.result?.turns?.[0]?.status !== 'interrupted') {
      throw await processDiagnosticError(
        secondClient,
        threadId,
        modelServer,
        new Error('SIGTERM recovery did not interrupt the active turn.'),
      );
    }
    expect(recovered.result).toMatchObject({
      thread: { id: threadId, status: 'interrupted' },
      turns: [{ status: 'interrupted' }],
      pendingServerRequests: [],
    });

    await rpc(secondClient, 3, 'server/shutdown', {
      reason: 'SIGTERM recovery E2E complete',
    });
    await expect(waitForExit(secondChild)).resolves.toEqual([0, null]);
    await Promise.allSettled([firstClient.close(), secondClient.close()]);
    await modelServer.close();
  }, 60_000);

  it('WebSocket build 完成真实 turn、断线恢复、管理 RPC 与隔离关停', async () => {
    const root = await temporaryRoot('ello-websocket-e2e-');
    const cwd = path.join(root, 'workspace');
    await mkdir(cwd, { recursive: true });
    const modelServer = await MockChatServer.start([
      toolStep('call_bash', 'bash', {
        command: 'printf command-ok',
        timeoutMs: 1_000,
      }),
      toolStep('call_write', 'write', {
        path: 'e2e.txt',
        content: 'written by process e2e\n',
        reason: 'verify file change',
      }),
      toolStep('call_input', 'request_user_input', {
        questions: [
          {
            id: 'continue_choice',
            header: 'Continue',
            question: 'Continue the process E2E turn?',
            options: [
              { label: 'Proceed', description: 'Finish the test turn.' },
              { label: 'Stop', description: 'Stop before completion.' },
            ],
            multiSelect: false,
          },
        ],
      }),
      { type: 'text', deltas: ['process ', 'complete'] },
    ]);
    await writeConfig(root, modelServer.baseUrl);
    const port = await freePort();
    const token = 'process-e2e-token';
    const child = spawnServer(
      [
        '--listen',
        `ws://127.0.0.1:${port}`,
        '--root',
        root,
        '--auth-token-env',
        'ELLO_E2E_AUTH_TOKEN',
      ],
      root,
      { ELLO_E2E_AUTH_TOKEN: token },
    );
    const stderr = collectLines(child.stderr);
    await waitUntilReady(port, child);

    await expect(
      WebSocketPeer.connect(`ws://127.0.0.1:${port}`),
    ).rejects.toThrow(/401/u);

    const controller = await WebSocketPeer.connect(
      `ws://127.0.0.1:${port}`,
      token,
    );
    const observer = await WebSocketPeer.connect(
      `ws://127.0.0.1:${port}`,
      token,
    );
    await initialize(controller);
    await initialize(observer);

    const controllerStart = await rpc(controller, 2, 'thread/start', {
      cwd,
      subscribe: true,
    });
    const threadId = readThreadId(controllerStart);
    const observerStart = await rpc(observer, 2, 'thread/start', {
      cwd,
      name: 'observer-only',
      subscribe: true,
    });
    const observerThreadId = readThreadId(observerStart);
    expect(observerThreadId).not.toBe(threadId);

    const observerTrace: RpcMessage[] = [];
    const goal = await rpc(controller, 3, 'thread/goal/set', {
      threadId,
      objective: 'finish process E2E',
      tokenBudget: 10_000,
    });
    expect(goal.result).toMatchObject({
      goal: { objective: 'finish process E2E' },
    });
    await rpc(observer, 3, 'server/read', {}, observerTrace);
    expect(
      observerTrace.some((message) => threadIdOf(message) === threadId),
    ).toBe(false);

    const turnTrace: RpcMessage[] = [];
    const turnStarted = await rpc(
      controller,
      4,
      'turn/start',
      {
        threadId,
        input: [{ type: 'text', text: 'run the process E2E flow' }],
      },
      turnTrace,
    );
    const turnId = readTurnId(turnStarted);
    let commandApproval: RpcMessage;
    try {
      commandApproval = await waitForServerRequest(
        controller,
        'item/commandExecution/requestApproval',
        turnTrace,
      );
    } catch (error) {
      const diagnostic = await rpc(controller, 90, 'thread/read', {
        threadId,
        includeTurns: true,
        includeItems: true,
      });
      const exported = await rpc(controller, 91, 'thread/export', {
        threadId,
        format: 'jsonl',
      });
      throw new Error(
        `${errorMessage(error)}; modelRequests=${modelServer.requests.length}; snapshot=${JSON.stringify(diagnostic.result)}; log=${String(exported.result?.content)}`,
        { cause: error },
      );
    }

    await controller.close();
    const resumedController = await WebSocketPeer.connect(
      `ws://127.0.0.1:${port}`,
      token,
    );
    await initialize(resumedController);
    await resumedController.send(
      request(5, 'thread/resume', {
        threadId,
        subscribe: true,
      }),
    );
    const resumeResponse = await nextMessage(
      resumedController,
      'thread/resume response',
      turnTrace,
    );
    expect(resumeResponse).toMatchObject({
      id: 5,
      result: { thread: { id: threadId } },
    });
    const resumeSeq = readResultSeq(resumeResponse);
    const replayedApproval = await nextMessage(
      resumedController,
      'replayed command approval',
      turnTrace,
    );
    expect(replayedApproval).toMatchObject({
      id: commandApproval.id,
      method: 'item/commandExecution/requestApproval',
      params: { threadId, turnId },
    });
    turnTrace.push(resumeResponse, replayedApproval);
    const resumedTraceStart = turnTrace.length;
    await respond(resumedController, replayedApproval, { decision: 'accept' });

    let fileApproval: RpcMessage;
    try {
      fileApproval = await waitForServerRequest(
        resumedController,
        'item/fileChange/requestApproval',
        turnTrace,
      );
    } catch (error) {
      throw await processDiagnosticError(
        resumedController,
        threadId,
        modelServer,
        error,
      );
    }
    await respond(resumedController, fileApproval, { decision: 'accept' });

    const userInput = await waitForServerRequest(
      resumedController,
      'item/tool/requestUserInput',
      turnTrace,
    );
    await respond(resumedController, userInput, {
      status: 'submitted',
      answers: [{ questionId: 'continue_choice', selected: ['Proceed'] }],
    });

    await waitForNotification(resumedController, 'turn/completed', turnTrace);
    expectContinuousThreadSequence(
      turnTrace.slice(resumedTraceStart),
      threadId,
      resumeSeq,
    );
    expect(
      turnTrace.some(
        (message) =>
          message.method === 'item/agentMessage/delta' &&
          typeof message.params?.delta === 'string',
      ),
    ).toBe(true);
    expect(
      turnTrace.some(
        (message) =>
          message.method === 'item/completed' &&
          message.params?.item?.type === 'fileChange' &&
          Array.isArray(message.params.item.changes) &&
          message.params.item.changes.length > 0,
      ),
    ).toBe(true);
    expect(await readFile(path.join(cwd, 'e2e.txt'), 'utf8')).toBe(
      'written by process e2e\n',
    );

    const snapshot = await rpc(resumedController, 6, 'thread/read', {
      threadId,
      includeTurns: true,
      includeItems: true,
    });
    if (snapshot.result?.turns?.[0]?.status !== 'completed') {
      throw await processDiagnosticError(
        resumedController,
        threadId,
        modelServer,
        new Error('Real process turn did not complete.'),
      );
    }
    expect(snapshot.result).toMatchObject({
      thread: { id: threadId },
      turns: [{ id: turnId, status: 'completed' }],
      pendingServerRequests: [],
    });

    const fork = await rpc(resumedController, 7, 'thread/fork', {
      threadId,
      lastTurnId: turnId,
      subscribe: false,
    });
    expect(fork.result).toMatchObject({
      thread: { rootId: threadId, forkedFromId: threadId },
      turns: [{ status: 'completed' }],
    });
    expect(readThreadId(fork)).not.toBe(threadId);

    const config = await rpc(resumedController, 8, 'config/read', {
      cwd,
      includeSources: true,
    });
    expect(config.result).toMatchObject({ config: { active_profile: 'main' } });
    const models = await rpc(resumedController, 9, 'model/list', { cwd });
    expect(readDataIds(models)).toContain('mock/test');
    const task = await rpc(resumedController, 10, 'task/create', {
      boardId: 'process-e2e',
      subject: 'verify RPC',
      description: 'created through the real process',
      blockedBy: [],
      metadata: {},
    });
    expect(task.result).toMatchObject({ task: { subject: 'verify RPC' } });
    const tasks = await rpc(resumedController, 11, 'task/list', {
      boardId: 'process-e2e',
      limit: 20,
    });
    expect((tasks.result?.data as unknown[] | undefined)?.length).toBe(1);
    expect(
      (await rpc(resumedController, 12, 'workspace/list', {})).result,
    ).toEqual({ data: [] });
    expect((await rpc(resumedController, 13, 'repo/list', {})).result).toEqual({
      data: [],
    });

    await rpc(observer, 4, 'server/read', {}, observerTrace);
    expect(
      observerTrace.some((message) => threadIdOf(message) === threadId),
    ).toBe(false);

    await resumedController.close();
    const reader = await WebSocketPeer.connect(`ws://127.0.0.1:${port}`, token);
    await initialize(reader);
    const resumed = await rpc(reader, 14, 'thread/resume', {
      threadId,
      subscribe: false,
    });
    expect(resumed.result).toMatchObject({
      thread: { id: threadId },
      turns: [{ id: turnId, status: 'completed' }],
    });

    const shutdown = await rpc(reader, 15, 'server/shutdown', {
      reason: 'process E2E complete',
    });
    expect(shutdown.result).toEqual({ ok: true });
    const [code, signal] = await waitForExit(child);
    expect({ code, signal }).toEqual({ code: 0, signal: null });
    await Promise.allSettled([reader.close(), observer.close()]);
    await modelServer.close();

    expect(modelServer.requests).toHaveLength(4);
    expect(
      modelServer.requests[0]?.tools?.some(
        (tool) => tool.function?.name === 'bash',
      ),
    ).toBe(true);
    for (const line of stderr) expect(() => JSON.parse(line)).not.toThrow();
  }, 60_000);
});

type JsonObject = Record<string, unknown>;

interface RpcMessage extends JsonObject {
  readonly jsonrpc: '2.0';
  readonly id?: string | number | null;
  readonly method?: string;
  readonly params?: JsonObject;
  readonly result?: JsonObject;
  readonly error?: JsonObject;
}

interface RpcPeer {
  send(message: RpcMessage): Promise<void>;
  next(timeoutMs?: number): Promise<RpcMessage>;
}

class StdioProcessPeer implements RpcPeer {
  readonly stdoutLines: string[] = [];
  readonly stderrLines: string[] = [];
  private readonly messages = new AsyncQueue<RpcMessage>();

  constructor(private readonly child: ChildProcessWithoutNullStreams) {
    splitLines(child.stdout, (line) => {
      this.stdoutLines.push(line);
      this.messages.push(JSON.parse(line) as RpcMessage);
    });
    splitLines(child.stderr, (line) => this.stderrLines.push(line));
    child.once('exit', () => this.messages.end());
    child.once('error', (error) => this.messages.fail(error));
  }

  send(message: RpcMessage): Promise<void> {
    return writeStream(this.child.stdin, `${JSON.stringify(message)}\n`);
  }

  next(timeoutMs?: number): Promise<RpcMessage> {
    return this.messages.next(timeoutMs);
  }

  endInput(): void {
    this.child.stdin.end();
  }

  exited(): Promise<readonly [number | null, NodeJS.Signals | null]> {
    return waitForExit(this.child);
  }
}

class WebSocketPeer implements RpcPeer {
  private readonly messages = new AsyncQueue<RpcMessage>();
  private closeResult:
    | { readonly code: number; readonly reason: string }
    | undefined;

  private constructor(private readonly socket: WebSocket) {
    socket.on('message', (data) => {
      this.messages.push(JSON.parse(data.toString()) as RpcMessage);
    });
    socket.once('close', (code, reason) => {
      this.closeResult = { code, reason: reason.toString() };
      this.messages.end();
    });
    socket.once('error', (error) => this.messages.fail(error));
  }

  static async connect(
    endpoint: string,
    token?: string,
  ): Promise<WebSocketPeer> {
    const socket = new WebSocket(endpoint, {
      ...(token === undefined
        ? {}
        : { headers: { authorization: `Bearer ${token}` } }),
    });
    await new Promise<void>((resolve, reject) => {
      const onOpen = () => {
        socket.off('error', onError);
        resolve();
      };
      const onError = (error: Error) => {
        socket.off('open', onOpen);
        reject(error);
      };
      socket.once('open', onOpen);
      socket.once('error', onError);
    });
    return new WebSocketPeer(socket);
  }

  send(message: RpcMessage): Promise<void> {
    return new Promise((resolve, reject) => {
      this.socket.send(JSON.stringify(message), (error) => {
        if (error === undefined || error === null) resolve();
        else reject(error);
      });
    });
  }

  next(timeoutMs?: number): Promise<RpcMessage> {
    return this.messages.next(timeoutMs);
  }

  async close(): Promise<void> {
    if (this.socket.readyState === WebSocket.CLOSED) return;
    const closed = once(this.socket, 'close');
    this.socket.close();
    await closed;
  }

  pauseIncoming(): void {
    socketStream(this.socket).pause();
  }

  resumeIncoming(): void {
    socketStream(this.socket).resume();
  }

  async waitClosed(
    timeoutMs = 5_000,
  ): Promise<{ readonly code: number; readonly reason: string }> {
    if (this.closeResult !== undefined) return this.closeResult;
    return Promise.race([
      once(this.socket, 'close').then(([code, reason]) => ({
        code: code as number,
        reason: (reason as Buffer).toString(),
      })),
      new Promise<never>((_resolve, reject) => {
        setTimeout(
          () =>
            reject(new Error(`Slow WebSocket stayed open for ${timeoutMs}ms.`)),
          timeoutMs,
        );
      }),
    ]);
  }
}

class AsyncQueue<T> {
  private readonly values: T[] = [];
  private readonly waiters: Array<{
    readonly resolve: (value: T) => void;
    readonly reject: (error: Error) => void;
  }> = [];
  private failure: Error | undefined;
  private ended = false;

  push(value: T): void {
    const waiter = this.waiters.shift();
    if (waiter === undefined) this.values.push(value);
    else waiter.resolve(value);
  }

  fail(error: Error): void {
    this.failure = error;
    for (const waiter of this.waiters.splice(0)) waiter.reject(error);
  }

  end(): void {
    this.ended = true;
    const error = new Error('RPC peer closed before the next message.');
    for (const waiter of this.waiters.splice(0)) waiter.reject(error);
  }

  next(timeoutMs = 10_000): Promise<T> {
    const value = this.values.shift();
    if (value !== undefined) return Promise.resolve(value);
    if (this.failure !== undefined) return Promise.reject(this.failure);
    if (this.ended) return Promise.reject(new Error('RPC peer is closed.'));
    return new Promise<T>((resolve, reject) => {
      const waiter = {
        resolve: (next: T) => {
          clearTimeout(timer);
          resolve(next);
        },
        reject: (error: Error) => {
          clearTimeout(timer);
          reject(error);
        },
      };
      const timer = setTimeout(() => {
        const index = this.waiters.indexOf(waiter);
        if (index !== -1) this.waiters.splice(index, 1);
        reject(
          new Error(`Timed out waiting for RPC message after ${timeoutMs}ms.`),
        );
      }, timeoutMs);
      this.waiters.push(waiter);
    });
  }
}

type ModelStep =
  | {
      readonly type: 'tool';
      readonly id: string;
      readonly name: string;
      readonly arguments: JsonObject;
    }
  | { readonly type: 'text'; readonly deltas: readonly string[] };

class MockChatServer {
  private constructor(
    readonly baseUrl: string,
    private readonly server: HttpServer,
    readonly requests: JsonObject[],
  ) {}

  static async start(steps: ModelStep[]): Promise<MockChatServer> {
    const queuedSteps = [...steps];
    const requests: JsonObject[] = [];
    const server = createServer(async (request, response) => {
      if (request.method !== 'POST' || request.url !== '/v1/chat/completions') {
        response.statusCode = 404;
        response.end('not found');
        return;
      }
      const body = await readRequestBody(request);
      const parsed = JSON.parse(body) as JsonObject;
      requests.push(parsed);
      const step = queuedSteps.shift();
      if (step === undefined) {
        response.statusCode = 500;
        response.end('no mock model step');
        return;
      }
      response.writeHead(200, {
        'content-type': 'text/event-stream',
        'cache-control': 'no-cache',
        connection: 'keep-alive',
      });
      for (const chunk of chatChunks(step, requests.length)) {
        response.write(`data: ${JSON.stringify(chunk)}\n\n`);
      }
      response.end('data: [DONE]\n\n');
    });
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', () => {
        server.off('error', reject);
        resolve();
      });
    });
    const address = server.address();
    if (address === null || typeof address === 'string') {
      throw new Error('Mock model server has no TCP address.');
    }
    const instance = new MockChatServer(
      `http://127.0.0.1:${address.port}/v1`,
      server,
      requests,
    );
    modelServers.add(instance);
    return instance;
  }

  close(): Promise<void> {
    modelServers.delete(this);
    if (!this.server.listening) return Promise.resolve();
    return new Promise((resolve, reject) => {
      this.server.close((error) => {
        if (error === undefined || error === null) resolve();
        else reject(error);
      });
    });
  }
}

function toolStep(
  id: string,
  name: string,
  argumentsValue: JsonObject,
): ModelStep {
  return { type: 'tool', id, name, arguments: argumentsValue };
}

function chatChunks(step: ModelStep, index: number): JsonObject[] {
  const base = {
    id: `chatcmpl_${index}`,
    created: 1_784_351_596,
    model: 'test',
  };
  const finish = (reason: 'stop' | 'tool_calls') => ({
    ...base,
    choices: [{ index: 0, delta: {}, finish_reason: reason }],
    usage: {
      prompt_tokens: 10,
      completion_tokens: 4,
      total_tokens: 14,
      prompt_tokens_details: { cached_tokens: 0 },
      completion_tokens_details: { reasoning_tokens: 0 },
    },
  });
  if (step.type === 'tool') {
    return [
      {
        ...base,
        choices: [
          {
            index: 0,
            delta: {
              role: 'assistant',
              tool_calls: [
                {
                  index: 0,
                  id: step.id,
                  type: 'function',
                  function: {
                    name: step.name,
                    arguments: JSON.stringify(step.arguments),
                  },
                },
              ],
            },
            finish_reason: null,
          },
        ],
      },
      finish('tool_calls'),
    ];
  }
  return [
    ...step.deltas.map((delta) => ({
      ...base,
      choices: [
        {
          index: 0,
          delta: { role: 'assistant', content: delta },
          finish_reason: null,
        },
      ],
    })),
    finish('stop'),
  ];
}

async function initialize(peer: RpcPeer): Promise<void> {
  const response = await rpc(peer, 1, 'initialize', {
    clientInfo: { name: 'process-e2e', title: 'Process E2E', version: '1.0.0' },
    protocolVersion: 1,
    capabilities: {
      experimentalApi: false,
      supportsServerRequests: true,
      supportsUserInput: true,
      optOutNotificationMethods: [],
      platform: 'automation',
    },
  });
  expect(response.result).toMatchObject({ protocolVersion: 1 });
  await peer.send({ jsonrpc: '2.0', method: 'initialized', params: {} });
  expect(await peer.next()).toMatchObject({
    method: 'server/ready',
    params: { protocolVersion: 1 },
  });
}

async function rpc(
  peer: RpcPeer,
  id: number,
  method: string,
  params: JsonObject,
  trace: RpcMessage[] = [],
): Promise<RpcMessage> {
  await peer.send(request(id, method, params));
  while (true) {
    const message = await nextMessage(peer, `${method} response`, trace);
    if (message.id === id && message.method === undefined) {
      if (message.error !== undefined) {
        throw new Error(`${method} failed: ${JSON.stringify(message.error)}`);
      }
      return message;
    }
    trace.push(message);
  }
}

async function waitForServerRequest(
  peer: RpcPeer,
  method: string,
  trace: RpcMessage[],
): Promise<RpcMessage> {
  while (true) {
    const message = await nextMessage(peer, `${method} Server Request`, trace);
    trace.push(message);
    if (message.method === method && typeof message.id === 'string')
      return message;
  }
}

async function waitForNotification(
  peer: RpcPeer,
  method: string,
  trace: RpcMessage[],
): Promise<RpcMessage> {
  while (true) {
    const message = await nextMessage(peer, `${method} notification`, trace);
    trace.push(message);
    if (message.method === method && message.id === undefined) return message;
  }
}

function respond(
  peer: RpcPeer,
  requestMessage: RpcMessage,
  result: JsonObject,
): Promise<void> {
  if (typeof requestMessage.id !== 'string') {
    throw new Error('Server Request has no string id.');
  }
  return peer.send({ jsonrpc: '2.0', id: requestMessage.id, result });
}

async function processDiagnosticError(
  peer: RpcPeer,
  threadId: string,
  modelServer: MockChatServer,
  error: unknown,
): Promise<Error> {
  const diagnostic = await rpc(peer, 90, 'thread/read', {
    threadId,
    includeTurns: true,
    includeItems: true,
  });
  const exported = await rpc(peer, 91, 'thread/export', {
    threadId,
    format: 'jsonl',
  });
  return new Error(
    `${errorMessage(error)}; modelRequests=${modelServer.requests.length}; snapshot=${JSON.stringify(diagnostic.result)}; log=${String(exported.result?.content)}`,
    { cause: error },
  );
}

async function nextMessage(
  peer: RpcPeer,
  label: string,
  trace: readonly RpcMessage[] = [],
): Promise<RpcMessage> {
  try {
    return await peer.next();
  } catch (error) {
    const observed = trace.map(describeMessage).join(', ');
    throw new Error(
      `${label} failed after [${observed || 'no messages'}]: ${errorMessage(error)}`,
      { cause: error },
    );
  }
}

function describeMessage(message: RpcMessage): string {
  if (
    message.method === 'item/started' ||
    message.method === 'item/completed'
  ) {
    const item = message.params?.item;
    return `${message.method}:${String(item?.type)}:${String(item?.status ?? '')}:${String(item?.message ?? '')}`;
  }
  if (message.method !== undefined) return message.method;
  return message.error === undefined
    ? `response:${String(message.id)}`
    : `error:${String(message.id)}:${String(message.error.data?.type)}`;
}

function request(id: number, method: string, params: JsonObject): RpcMessage {
  return { jsonrpc: '2.0', id, method, params };
}

function readThreadId(message: RpcMessage): string {
  const value = message.result?.thread?.id;
  if (typeof value !== 'string')
    throw new Error('RPC result has no thread id.');
  return value;
}

function readTurnId(message: RpcMessage): string {
  const value = message.result?.turn?.id;
  if (typeof value !== 'string') throw new Error('RPC result has no turn id.');
  return value;
}

function readResultSeq(message: RpcMessage): number {
  const value = message.result?.seq;
  if (typeof value !== 'number') throw new Error('RPC result has no seq.');
  return value;
}

function expectContinuousThreadSequence(
  trace: readonly RpcMessage[],
  threadId: string,
  initialSeq: number,
): void {
  const observed = trace.flatMap((message) => {
    if (
      message.id !== undefined ||
      message.params?.threadId !== threadId ||
      typeof message.params.seq !== 'number'
    ) {
      return [];
    }
    return [message.params.seq];
  });
  expect(observed.length).toBeGreaterThan(0);
  expect(observed).toEqual(
    observed.map((_seq, index) => initialSeq + index + 1),
  );
}

function readDataIds(message: RpcMessage): string[] {
  const data = message.result?.data;
  if (!Array.isArray(data)) throw new Error('RPC result has no data array.');
  return data.flatMap((entry) =>
    typeof entry === 'object' && entry !== null && typeof entry.id === 'string'
      ? [entry.id]
      : [],
  );
}

function threadIdOf(message: RpcMessage): string | undefined {
  return typeof message.params?.threadId === 'string'
    ? message.params.threadId
    : undefined;
}

async function writeConfig(root: string, baseUrl: string): Promise<void> {
  await writeFile(
    path.join(root, 'config.yaml'),
    [
      'active_profile: main',
      'provider:',
      '  mock:',
      '    kind: openai-compatible',
      '    api_key: test',
      `    base_url: ${baseUrl}`,
      'models:',
      '  mock:',
      '    test:',
      '      provider: mock',
      '      api_id: test',
      '      endpoint: chat',
      '      tool_call: true',
      'profile:',
      '  main:',
      '    models:',
      '      primary: mock/test',
      '      small: mock/test',
      '      compact: mock/test',
      '      title: mock/test',
      '      review: mock/test',
      `workspace:\n  mount: ${path.join(root, 'workspaces')}`,
      'initial_mode: ask-before-changes',
      '',
    ].join('\n'),
    'utf8',
  );
}

function spawnServer(
  args: string[],
  root: string,
  environment: NodeJS.ProcessEnv = {},
): ChildProcessWithoutNullStreams {
  const child = spawn(process.execPath, [entryPath, ...args], {
    env: { ...process.env, ...environment, ELLO_HOME: root },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  children.add(child);
  child.once('exit', () => children.delete(child));
  return child;
}

async function temporaryRoot(prefix: string): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), prefix));
  roots.add(root);
  return root;
}

async function writeFileBurst(directory: string, count: number): Promise<void> {
  const batchSize = 500;
  for (let offset = 0; offset < count; offset += batchSize) {
    await Promise.all(
      Array.from({ length: Math.min(batchSize, count - offset) }, (_, index) =>
        writeFile(path.join(directory, `event-${offset + index}.txt`), 'x'),
      ),
    );
  }
}

async function freePort(): Promise<number> {
  const server = createNetServer();
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      server.off('error', reject);
      resolve();
    });
  });
  const address = server.address();
  if (address === null || typeof address === 'string') {
    throw new Error('Temporary TCP server has no address.');
  }
  await new Promise<void>((resolve, reject) => {
    server.close((error) => {
      if (error === undefined || error === null) resolve();
      else reject(error);
    });
  });
  return address.port;
}

async function waitUntilReady(
  port: number,
  child: ChildProcessWithoutNullStreams,
): Promise<void> {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null || child.signalCode !== null) {
      throw new Error(`App Server exited before ready: ${child.exitCode}.`);
    }
    try {
      const response = await fetch(`http://127.0.0.1:${port}/readyz`);
      if (response.ok) return;
    } catch {
      // Listener creation races this poll; retry until the fixed deadline.
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error('Timed out waiting for App Server /readyz.');
}

function waitForExit(
  child: ChildProcessWithoutNullStreams,
): Promise<readonly [number | null, NodeJS.Signals | null]> {
  if (child.exitCode !== null || child.signalCode !== null) {
    return Promise.resolve([child.exitCode, child.signalCode]);
  }
  return once(child, 'exit').then(
    ([code, signal]) =>
      [code as number | null, signal as NodeJS.Signals | null] as const,
  );
}

async function terminateChild(
  child: ChildProcessWithoutNullStreams,
): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  child.kill('SIGTERM');
  const exited = await Promise.race([
    waitForExit(child).then(() => true),
    new Promise<false>((resolve) => setTimeout(() => resolve(false), 2_000)),
  ]);
  if (!exited) child.kill('SIGKILL');
}

function collectLines(stream: NodeJS.ReadableStream): string[] {
  const lines: string[] = [];
  splitLines(stream, (line) => lines.push(line));
  return lines;
}

function splitLines(
  stream: NodeJS.ReadableStream,
  onLine: (line: string) => void,
): void {
  let buffered = '';
  stream.setEncoding('utf8');
  stream.on('data', (chunk: string) => {
    buffered += chunk;
    let newline = buffered.indexOf('\n');
    while (newline !== -1) {
      const line = buffered.slice(0, newline);
      buffered = buffered.slice(newline + 1);
      if (line !== '') onLine(line);
      newline = buffered.indexOf('\n');
    }
  });
  stream.once('end', () => {
    if (buffered !== '') onLine(buffered);
  });
}

function writeStream(
  stream: NodeJS.WritableStream,
  text: string,
): Promise<void> {
  return new Promise((resolve, reject) => {
    stream.write(text, (error) => {
      if (error === null || error === undefined) resolve();
      else reject(error);
    });
  });
}

function socketStream(socket: WebSocket): NodeJS.ReadWriteStream {
  const stream = (
    socket as unknown as { readonly _socket?: NodeJS.ReadWriteStream }
  )._socket;
  if (stream === undefined)
    throw new Error('WebSocket has no underlying socket.');
  return stream;
}

async function readRequestBody(stream: NodeJS.ReadableStream): Promise<string> {
  let body = '';
  stream.setEncoding('utf8');
  for await (const chunk of stream) body += chunk;
  return body;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
