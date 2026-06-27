import { Buffer } from 'node:buffer';
import { randomUUID } from 'node:crypto';

import {
  createAgent,
  DeleteFileTool,
  EditFileTool,
  GlobTool,
  GrepTool,
  ListDirTool,
  LocalEnvironment,
  buildMcpServers,
  loadMcpConfigFile,
  MkdirTool,
  MoveCopyTool,
  ReadFileTool,
  ShellExecTool,
  Toolset,
  ToolSearchToolset,
  WebFetchTool,
  WebSearchTool,
  WriteFileTool,
} from '@ello/agent';

import type { CodingAgentConfig } from '../config.js';
import { JsonlSessionStorage } from '../jsonl-session-storage.js';
import { loadCodingMemory, renderMemoryForPrompt } from '../memory.js';
import { PermissionToolset } from '../permissions.js';
import { buildCodingSystemPrompt } from '../system-prompt.js';
import { TaskManager, TaskRecordSchema } from '../task-manager.js';

import { CodingAgentSession } from './session-class.js';

/**
 * 创建装配完整的 coding-agent 会话，并持久化初始元数据。
 */
export async function createCodingAgentSession(
  config: CodingAgentConfig,
): Promise<CodingAgentSession> {
  const sessionId = config.sessionId ?? randomUUID().replaceAll('-', '');
  const storage = await JsonlSessionStorage.open({
    sessionDir: config.sessionDir,
    sessionId,
  });
  const memory = await loadCodingMemory(config.cwd);
  const instructions = renderMemoryForPrompt(memory, config.cwd);
  const defaultToolset = new Toolset({
    tools: [
      ReadFileTool,
      ListDirTool,
      GrepTool,
      GlobTool,
      EditFileTool,
      WriteFileTool,
      MkdirTool,
      DeleteFileTool,
      MoveCopyTool,
      ShellExecTool,
      WebFetchTool,
      WebSearchTool,
    ],
  });
  const permissionContext = {
    approvalMode: config.approvalMode,
    rules: config.permissionRules,
    cwd: config.cwd,
    allowedPaths: config.allowedPaths,
  };
  const mcpToolsets = config.mcpConfigPath
    ? buildMcpServers(await loadMcpConfigFile(config.mcpConfigPath))
    : [];
  const runtime = createAgent({
    modelName: config.model,
    baseUrl: config.baseUrl,
    env: new LocalEnvironment({
      defaultPath: config.cwd,
      allowedPaths: config.allowedPaths,
    }),
    session: storage,
    systemPrompt: buildCodingSystemPrompt(instructions),
    systemPromptTemplateVars: { instructions },
    toolsets: [
      new PermissionToolset(defaultToolset, permissionContext),
      new PermissionToolset(new ToolSearchToolset(defaultToolset), permissionContext),
      ...mcpToolsets.map((toolset) => new PermissionToolset(toolset, permissionContext)),
    ],
  });
  await runtime.enter();

  const taskSnapshot = storage.getLatestTaskSnapshot();
  const initialTasks = Array.isArray(taskSnapshot)
    ? taskSnapshot.map((task: unknown) => TaskRecordSchema.parse(task))
    : [];
  const session = new CodingAgentSession(
    config,
    sessionId,
    runtime,
    storage,
    memory,
    new TaskManager(initialTasks),
  );

  session.emit({ type: 'session_started', sessionId, config });
  session.emit({
    type: 'memory_loaded',
    files: memory.files.map((file) => ({ scope: file.scope, path: file.path })),
  });
  await storage.appendMemoryManifest({
    files: memory.files.map((file) => ({
      scope: file.scope,
      path: file.path,
      bytes: Buffer.byteLength(file.content, 'utf8'),
    })),
  });
  await storage.updateMetadata({
    id: sessionId,
    cwd: config.cwd,
    model: config.model,
    approvalMode: config.approvalMode,
    mcpConfigPath: config.mcpConfigPath,
    mcpServers: mcpToolsets.map((toolset) => toolset.id),
    memoryFiles: memory.files.map((file) => file.path),
    updatedAt: new Date().toISOString(),
  });
  return session;
}
