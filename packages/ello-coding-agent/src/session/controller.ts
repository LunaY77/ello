import type { CodingAgentConfig } from '../config.js';
import type { JsonlSessionSummary } from '../jsonl-session-storage.js';
import type { TaskRecord } from '../task-manager.js';

import { listCodingAgentSessions } from './service.js';
import type { CodingAgentSession } from './session-class.js';
import type { CodingAgentEvent } from './types.js';

/**
 * 供 TUI 和 CLI 命令使用的 controller 门面。
 *
 * controller 将面向 UI 的编排与实时会话 runtime 分离，
 * 让 app 层无需了解会话持久化或工具执行内部细节。
 */
export class CodingAgentController {
  constructor(private currentSession: CodingAgentSession) {}

  get session(): CodingAgentSession {
    return this.currentSession;
  }

  /**
   * 将用户输入发送到活跃会话流。
   */
  submitUserMessage(
    input: string,
    onEvent?: (event: CodingAgentEvent) => void,
  ): Promise<void> {
    return this.currentSession.submit(input, onEvent);
  }

  /**
   * 中断当前正在执行的 run，但不关闭会话。
   */
  interrupt(): void {
    this.currentSession.interrupt();
  }

  /**
   * Resolve a deferred tool approval request.
   */
  approveToolCall(id: string, decision: 'approve' | 'reject'): Promise<void> {
    return this.currentSession.approveToolCall(id, decision);
  }

  rejectToolCall(id: string): Promise<void> {
    return this.currentSession.approveToolCall(id, 'reject');
  }

  /**
   * 使用审批面板中编辑后的输入批准工具调用。
   */
  editToolCall(id: string, inputOverride: unknown): Promise<void> {
    return this.currentSession.approveToolCall(id, 'approve', inputOverride);
  }

  /**
   * 当存在可恢复消息时，恢复最近一次被中断的 run。
   */
  resumeInterruptedRun(): Promise<void> {
    return this.currentSession.resumeInterruptedRun();
  }

  /**
   * 在保留历史的同时，用新模型重建活跃会话。
   */
  async switchModel(model: string): Promise<void> {
    this.currentSession = await recreateSession(this.currentSession, {
      model,
      sessionId: this.currentSession.sessionId,
    });
    this.currentSession.emit({ type: 'model_switched', model });
  }

  /**
   * 返回模型选择器候选项，并始终包含当前模型。
   */
  listModels(): string[] {
    return [
      this.currentSession.config.model,
      ...this.currentSession.config.modelCandidates,
    ].filter((model, index, models) => models.indexOf(model) === index);
  }

  /**
   * 切换到配置选择列表中的某个模型。
   */
  async switchModelByIndex(index: number): Promise<void> {
    const model = this.listModels()[index];
    if (model !== undefined) {
      await this.switchModel(model);
    }
  }

  /**
   * 切换到下一个配置的模型候选项。
   */
  async toggleModel(): Promise<void> {
    const models = this.listModels();
    const currentIndex = models.indexOf(this.currentSession.config.model);
    const nextModel = models[(currentIndex + 1) % models.length] ?? this.currentSession.config.model;
    await this.switchModel(nextModel);
  }

  async compact(): Promise<void> {
    await this.currentSession.compact();
  }

  /**
   * 重新打开一个已持久化会话，并将其设为活跃 runtime。
   */
  async resumeSession(sessionId: string): Promise<CodingAgentSession> {
    this.currentSession = await recreateSession(this.currentSession, { sessionId });
    return this.currentSession;
  }

  close(): Promise<void> {
    return this.currentSession.close();
  }

  listTasks(): TaskRecord[] {
    return this.currentSession.listTasks();
  }

  /**
   * 按当前配置加载已持久化会话列表。
   */
  async listSessions(): Promise<JsonlSessionSummary[]> {
    return listCodingAgentSessions(this.currentSession.config);
  }

  createTask(content: string, activeForm?: string): TaskRecord {
    return this.currentSession.createTask(content, activeForm);
  }

  updateTask(id: string, patch: Parameters<CodingAgentSession['updateTask']>[1]): TaskRecord {
    return this.currentSession.updateTask(id, patch);
  }
}

async function recreateSession(
  previous: CodingAgentSession,
  overrides: Partial<CodingAgentConfig>,
): Promise<CodingAgentSession> {
  const nextConfig = { ...previous.config, ...overrides };
  const previousLeafId = await previous.runtime.session?.getLeafId?.();
  await previous.close();
  const { createCodingAgentSession } = await import('./factory.js');
  const next = await createCodingAgentSession(nextConfig);
  if (next.sessionId !== previous.sessionId) {
    await next.branchFrom(previous.sessionId, previousLeafId ?? null);
  }
  return next;
}
