import { createInterface } from 'node:readline/promises';

import type { CodingAgentConfig } from '../config.js';
import type { ApprovalDecision } from '../product/events.js';
import { CodingAgentRuntime } from '../product/runtime.js';

/** RPC 请求协议。 */
export type RpcRequest =
  | { readonly id: string; readonly method: 'submit'; readonly params: { readonly prompt: string } }
  | { readonly id: string; readonly method: 'approve'; readonly params: { readonly requestId: string; readonly decision: ApprovalDecision } }
  | { readonly id: string; readonly method: 'switchModel'; readonly params: { readonly model: string } }
  | { readonly id: string; readonly method: 'newSession'; readonly params?: Record<string, never> }
  | { readonly id: string; readonly method: 'resumeSession'; readonly params: { readonly sessionId: string } }
  | { readonly id: string; readonly method: 'fork'; readonly params: { readonly entryId?: string; readonly reason?: string } }
  | { readonly id: string; readonly method: 'export'; readonly params?: { readonly format?: 'jsonl' | 'html' } }
  | { readonly id: string; readonly method: 'tree'; readonly params?: Record<string, never> }
  | { readonly id: string; readonly method: 'compact'; readonly params?: Record<string, never> }
  | { readonly id: string; readonly method: 'close'; readonly params?: Record<string, never> };

/** stdio 依赖，便于测试注入。 */
export interface RpcIo {
  readonly stdin: NodeJS.ReadableStream;
  readonly stdout: Pick<NodeJS.WriteStream, 'write'>;
}

/**
 * 启动双向 JSONL/RPC 模式。
 *
 * 每一行输入是一个 JSON request；runtime 产生的产品事件逐行输出为
 * `{type:"event"}`，请求完成输出 `{type:"response"}`。
 */
export async function runRpcServer(config: CodingAgentConfig, io: RpcIo): Promise<void> {
  const runtime = await CodingAgentRuntime.create({ config });
  const unsubscribe = runtime.events.subscribe((event) => {
    io.stdout.write(`${JSON.stringify({ type: 'event', event })}\n`);
  });
  const rl = createInterface({ input: io.stdin });
  try {
    for await (const line of rl) {
      if (!line.trim()) continue;
      const request = JSON.parse(line) as RpcRequest;
      try {
        let result: unknown = null;
        if (request.method === 'submit') {
          await runtime.submit(request.params.prompt);
        } else if (request.method === 'approve') {
          await runtime.approve(request.params.requestId, request.params.decision);
        } else if (request.method === 'switchModel') {
          await runtime.switchModel(request.params.model);
        } else if (request.method === 'newSession') {
          result = await runtime.newSession();
        } else if (request.method === 'resumeSession') {
          await runtime.resumeSession(request.params.sessionId);
        } else if (request.method === 'fork') {
          await runtime.fork(request.params.entryId ?? '', { reason: request.params.reason ?? 'rpc' });
        } else if (request.method === 'export') {
          result = await runtime.exportSession(request.params?.format ?? 'jsonl');
        } else if (request.method === 'tree') {
          result = await runtime.sessionTree();
        } else if (request.method === 'compact') {
          await runtime.compact();
        } else if (request.method === 'close') {
          await runtime.close();
        }
        io.stdout.write(`${JSON.stringify({ type: 'response', id: request.id, ok: true, result })}\n`);
      } catch (error) {
        io.stdout.write(`${JSON.stringify({ type: 'response', id: request.id, ok: false, error: error instanceof Error ? error.message : String(error) })}\n`);
      }
      if (request.method === 'close') break;
    }
  } finally {
    unsubscribe();
    await runtime.close();
  }
}
