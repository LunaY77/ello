import { readFile } from 'node:fs/promises';

import {
  NormalizedAgentEvidenceSchema,
  RoundSchema,
  type BenchmarkRound,
  type ClaudeCodeAgentSpec,
  type NormalizedAgentEvidence,
  type NormalizedToolCall,
} from '../../contracts.js';
import { writeJsonLines } from '../../io.js';
import type { AgentProcessExecution } from '../adapter.js';
import { AgentAdapterError } from '../adapter.js';
import {
  aggregateUsage,
  fileEvidence,
  parseJsonLines,
  summarizeTools,
} from '../evidence.js';
import { WireFormatDrift } from '../wire-format-drift.js';

export async function parseClaudeCodeEvidence(options: {
  readonly agent: ClaudeCodeAgentSpec;
  readonly execution: AgentProcessExecution;
  readonly roundsPath: string;
  readonly persistRounds?: boolean;
}): Promise<{
  readonly evidence: NormalizedAgentEvidence;
  readonly rounds: readonly BenchmarkRound[];
  readonly tools: readonly NormalizedToolCall[];
  readonly providerFailureMessage: string | null;
}> {
  const records = parseJsonLines(
    await readFile(options.execution.stdoutPath, 'utf8'),
    'Claude Code stdout',
  ).map(requiredObject);
  const systemEvents = records.filter(
    (record) => record.type === 'system' && record.subtype === 'init',
  );
  const resultEvents = records.filter((record) => record.type === 'result');
  if (systemEvents.length !== 1) {
    throw new AgentAdapterError(
      'agent_evidence',
      `Claude Code stdout requires one system init event; observed ${systemEvents.length}.`,
    );
  }
  if (!options.execution.process.timedOut && resultEvents.length !== 1) {
    throw new AgentAdapterError(
      'agent_evidence',
      `Claude Code stdout requires one result event; observed ${resultEvents.length}.`,
    );
  }
  const drift = new WireFormatDrift();
  const system = parseSystemEvent(
    drift,
    requiredRecord(systemEvents[0], 'Claude system event'),
  );
  if (system.selectedModel !== options.agent.model) {
    throw new AgentAdapterError(
      'agent_evidence',
      `Claude Code selected model mismatch: expected ${options.agent.model}, observed ${system.selectedModel}.`,
    );
  }
  const toolResults = parseToolResults(records);
  const result = resultEvents[0];
  const terminal =
    result === undefined ? undefined : parseResultEvent(drift, result);
  const providerFailure = terminal?.providerFailure ?? false;
  const providerFailureMessage = providerFailure
    ? diagnoseClaudeCodeProviderFailureRecords(records)
    : null;
  const rounds: BenchmarkRound[] = [];
  const tools: NormalizedToolCall[] = [];
  const observedModels = new Set<string>();
  for (const record of records) {
    switch (record.type) {
      case 'system':
        break;
      case 'assistant': {
        const parsed = parseAssistantEvent(
          drift,
          record,
          toolResults,
          options.execution.process.timedOut,
        );
        if (parsed.providerErrorCode !== null) break;
        observedModels.add(parsed.model);
        tools.push(...parsed.tools);
        rounds.push(
          RoundSchema.parse({
            schema: 'ello.benchmark.round.v2',
            round: rounds.length + 1,
            requestId: parsed.messageId,
            provider: 'anthropic',
            model: parsed.model,
            startedAt: null,
            firstTokenAt: null,
            completedAt: null,
            status: 'completed',
            ...(parsed.stopReason === null
              ? {}
              : { finishReason: parsed.stopReason }),
            usage: {
              status: 'complete',
              requests: 1,
              inputTokens: parsed.usage.inputTokens,
              outputTokens: parsed.usage.outputTokens,
              cacheReadTokens: parsed.usage.cacheReadTokens,
              cacheWriteTokens: parsed.usage.cacheWriteTokens,
              reasoningTokens: null,
              toolCalls: parsed.tools.length,
            },
            toolCalls: parsed.tools,
            durationMs: null,
            firstTokenLatencyMs: null,
          }),
        );
        break;
      }
      case 'user':
        parseUserEvent(drift, record);
        break;
      case 'result':
        break;
      case 'tool_progress':
        // 长命令的心跳事件，不承载 usage、tool 或 round 证据。仍校验字段集，
        // 上游新增字段会进 drift 而不是让整份 evidence 失败。
        parseToolProgressEvent(drift, record);
        break;
      default:
        throw new AgentAdapterError(
          'agent_evidence',
          `Unsupported Claude Code stream event: ${String(record.type)}.`,
        );
    }
  }
  if (observedModels.size > 1) {
    throw new AgentAdapterError(
      'agent_evidence',
      `Claude Code run used ${observedModels.size} models: ${[...observedModels].join(', ')}.`,
    );
  }
  const observedModel =
    [...observedModels][0] ??
    (providerFailure || options.execution.process.timedOut
      ? system.selectedModel
      : undefined);
  if (observedModel === undefined) {
    throw new AgentAdapterError(
      'agent_evidence',
      'Claude Code stdout contains no assistant model call.',
    );
  }
  if (providerFailure || options.execution.process.timedOut) {
    rounds.push(
      RoundSchema.parse({
        schema: 'ello.benchmark.round.v2',
        round: rounds.length + 1,
        requestId: providerFailure ? 'claude-failed-1' : 'claude-timeout-1',
        provider: 'anthropic',
        model: observedModel,
        startedAt: null,
        firstTokenAt: null,
        completedAt: null,
        status: providerFailure ? 'failed' : 'incomplete',
        ...(providerFailure ? { error: providerFailureMessage } : {}),
        usage: {
          status: 'unavailable',
          reason: providerFailure
            ? 'Provider failure did not return complete token usage.'
            : 'Timed out before a complete assistant response.',
        },
        toolCalls: [],
        durationMs: null,
        firstTokenLatencyMs: null,
      }),
    );
  }
  if (rounds.length === 0) {
    throw new AgentAdapterError(
      'agent_evidence',
      'Claude Code stdout contains no model round.',
    );
  }
  if (options.persistRounds !== false) {
    await writeJsonLines(options.roundsPath, rounds);
  }
  const terminalStatus = options.execution.process.timedOut
    ? 'timed_out'
    : providerFailure
      ? 'failed'
      : 'completed';
  const evidence = NormalizedAgentEvidenceSchema.parse({
    schema: 'ello.benchmark.agent-evidence.v1',
    agentId: options.agent.id,
    kind: options.agent.kind,
    observedModel,
    terminalStatus,
    providerFailure,
    parserCoverage: 'complete',
    terminalStopReason: terminal?.stopReason ?? null,
    unknownFields: drift.list(),
    rawSource: await fileEvidence(options.execution.stdoutPath),
    rounds: await fileEvidence(options.roundsPath),
    roundCount: rounds.length,
    usage: aggregateUsage(rounds),
    tools: summarizeTools(rounds),
  });
  return { evidence, rounds, tools, providerFailureMessage };
}

export function diagnoseClaudeCodeProviderFailure(source: string): string {
  const records = parseJsonLines(source, 'Claude Code stdout').map(
    requiredObject,
  );
  return diagnoseClaudeCodeProviderFailureRecords(records);
}

function diagnoseClaudeCodeProviderFailureRecords(
  records: readonly Record<string, unknown>[],
): string {
  const terminal = records.find((record) => record.type === 'result');
  if (terminal === undefined || terminal.is_error !== true) {
    throw new AgentAdapterError(
      'agent_evidence',
      'Claude Code stdout has no terminal provider failure.',
    );
  }
  const assistantErrors = records
    .filter(
      (record) => record.type === 'assistant' && record.error !== undefined,
    )
    .map((record) => requiredString(record.error, 'Claude assistant error'));
  if (assistantErrors.length > 1) {
    throw new AgentAdapterError(
      'agent_evidence',
      `Claude Code stdout has multiple provider error codes: ${assistantErrors.join(', ')}.`,
    );
  }
  const code =
    assistantErrors[0] ??
    requiredString(terminal.subtype, 'Claude provider failure subtype');
  const result = optionalString(
    terminal.result,
    'Claude provider failure result',
  );
  return result === null
    ? `Claude Code provider error ${code}.`
    : `Claude Code provider error ${code}: ${result}`;
}

function parseSystemEvent(
  drift: WireFormatDrift,
  event: Record<string, unknown>,
): {
  readonly selectedModel: string;
} {
  assertKeys(
    drift,
    event,
    [
      'type',
      'subtype',
      'cwd',
      'session_id',
      'tools',
      'mcp_servers',
      'model',
      'permissionMode',
      'slash_commands',
      'apiKeySource',
      'claude_code_version',
      'output_style',
      'agents',
      'skills',
      'plugins',
      'uuid',
      'fast_mode_state',
      'capabilities',
      'analytics_disabled',
      'product_feedback_disabled',
      'memory_paths',
    ],
    'Claude system event',
    [
      'type',
      'subtype',
      'cwd',
      'session_id',
      'tools',
      'mcp_servers',
      'model',
      'permissionMode',
      'claude_code_version',
    ],
  );
  if (event.subtype !== 'init') {
    throw new AgentAdapterError(
      'agent_evidence',
      `Claude system subtype must be init: ${String(event.subtype)}.`,
    );
  }
  const tools = requiredStringArray(event.tools, 'Claude enabled tools');
  const expectedTools = new Set([
    'Bash',
    'Edit',
    'Read',
    'Write',
    'Glob',
    'Grep',
  ]);
  const observedTools = new Set(tools);
  if (
    tools.length !== expectedTools.size ||
    observedTools.size !== tools.length ||
    tools.some((tool) => !expectedTools.has(tool))
  ) {
    throw new AgentAdapterError(
      'agent_evidence',
      `Claude enabled tools mismatch: ${tools.join(', ')}.`,
    );
  }
  if (requiredArray(event.mcp_servers, 'Claude MCP servers').length !== 0) {
    throw new AgentAdapterError(
      'agent_environment',
      'Claude Code initialized an MCP server.',
    );
  }
  if (event.permissionMode !== 'bypassPermissions') {
    throw new AgentAdapterError(
      'agent_evidence',
      `Claude permission mode mismatch: ${String(event.permissionMode)}.`,
    );
  }
  return {
    selectedModel: requiredString(event.model, 'Claude selected model'),
  };
}

function parseAssistantEvent(
  drift: WireFormatDrift,
  event: Record<string, unknown>,
  toolResults: ReadonlyMap<string, { readonly failed: boolean }>,
  timedOut: boolean,
): {
  readonly model: string;
  readonly messageId: string;
  readonly stopReason: string | null;
  readonly usage: ClaudeUsage;
  readonly tools: readonly NormalizedToolCall[];
  readonly providerErrorCode: string | null;
} {
  assertKeys(
    drift,
    event,
    [
      'type',
      'message',
      'parent_tool_use_id',
      'session_id',
      'uuid',
      'timestamp',
      'error',
    ],
    'Claude assistant event',
    ['type', 'message', 'session_id'],
  );
  const message = requiredRecord(event.message, 'Claude assistant message');
  assertKeys(
    drift,
    message,
    [
      'model',
      'id',
      'type',
      'role',
      'content',
      'stop_reason',
      'stop_sequence',
      'usage',
      'container',
      'context_management',
      'stop_details',
    ],
    'Claude assistant message',
    ['model', 'id', 'type', 'role', 'content', 'stop_reason', 'usage'],
  );
  if (message.type !== 'message' || message.role !== 'assistant') {
    throw new AgentAdapterError(
      'agent_evidence',
      'Claude assistant message type or role is invalid.',
    );
  }
  const usage = parseClaudeUsage(drift, message.usage);
  const content = requiredArray(message.content, 'Claude assistant content');
  const tools = content.flatMap((block, index) => {
    const item = requiredRecord(block, 'Claude assistant content block');
    const type = requiredString(item.type, 'Claude content block type');
    if (type === 'text') {
      assertKeys(
        drift,
        item,
        ['type', 'text', 'citations'],
        'Claude text block',
        ['type', 'text'],
      );
      requiredString(item.text, 'Claude text');
      return [];
    }
    if (type === 'thinking') {
      assertKeys(
        drift,
        item,
        ['type', 'thinking', 'signature'],
        'Claude thinking block',
        ['type', 'thinking'],
      );
      return [];
    }
    if (type === 'redacted_thinking') {
      assertKeys(
        drift,
        item,
        ['type', 'data'],
        'Claude redacted thinking block',
      );
      return [];
    }
    if (type !== 'tool_use') {
      // Anthropic adds content block types over time. An unrecognized block
      // contributes no tool call and is reported as drift.
      drift.record('Claude assistant content', [type]);
      return [];
    }
    assertKeys(
      drift,
      item,
      ['type', 'id', 'name', 'input'],
      'Claude tool_use block',
    );
    const id = requiredString(item.id, 'Claude tool use ID');
    const result = toolResults.get(id);
    if (result === undefined && !timedOut) {
      throw new AgentAdapterError(
        'agent_evidence',
        `Claude tool call has no result: ${id}.`,
      );
    }
    return [
      normalizeClaudeTool(
        drift,
        id,
        requiredString(item.name, 'Claude tool name'),
        requiredRecord(item.input, 'Claude tool input'),
        result?.failed ?? true,
        index,
      ),
    ];
  });
  return {
    model: requiredString(message.model, 'Claude observed model'),
    messageId: requiredString(message.id, 'Claude message ID'),
    // stream-json carries stop_reason as null on assistant events. The stop
    // reason for the run appears only on the terminal result event.
    stopReason: optionalString(message.stop_reason, 'Claude stop reason'),
    usage,
    tools,
    providerErrorCode: optionalString(
      event.error,
      'Claude assistant provider error',
    ),
  };
}

function parseToolProgressEvent(
  drift: WireFormatDrift,
  event: Record<string, unknown>,
): void {
  assertKeys(
    drift,
    event,
    [
      'type',
      'tool_use_id',
      'tool_name',
      'parent_tool_use_id',
      'elapsed_time_seconds',
      'heartbeat',
      'session_id',
      'uuid',
    ],
    'Claude tool_progress event',
    ['type', 'tool_use_id', 'tool_name', 'session_id'],
  );
}

function parseUserEvent(
  drift: WireFormatDrift,
  event: Record<string, unknown>,
): void {
  assertKeys(
    drift,
    event,
    [
      'type',
      'message',
      'parent_tool_use_id',
      'session_id',
      'uuid',
      'tool_use_result',
      'timestamp',
    ],
    'Claude user event',
    ['type', 'message', 'session_id'],
  );
  const message = requiredRecord(event.message, 'Claude user message');
  assertKeys(drift, message, ['role', 'content'], 'Claude user message');
  if (message.role !== 'user') {
    throw new AgentAdapterError(
      'agent_evidence',
      'Claude user event role is invalid.',
    );
  }
  for (const block of requiredArray(message.content, 'Claude user content')) {
    const item = requiredRecord(block, 'Claude user content block');
    if (item.type !== 'tool_result') {
      drift.record('Claude user content', [String(item.type)]);
      continue;
    }
    assertKeys(
      drift,
      item,
      ['type', 'tool_use_id', 'content', 'is_error'],
      'Claude tool_result block',
      ['type', 'tool_use_id', 'content'],
    );
  }
}

function parseResultEvent(
  drift: WireFormatDrift,
  event: Record<string, unknown>,
): {
  readonly providerFailure: boolean;
  readonly stopReason: string | null;
} {
  assertKeys(
    drift,
    event,
    [
      'type',
      'subtype',
      'is_error',
      'duration_ms',
      'duration_api_ms',
      'num_turns',
      'result',
      'session_id',
      'total_cost_usd',
      'usage',
      'modelUsage',
      'permission_denials',
      'uuid',
      'errors',
      'api_error_status',
      'fast_mode_state',
      'stop_reason',
      'terminal_reason',
      'time_to_request_ms',
      'ttft_ms',
      'ttft_stream_ms',
    ],
    'Claude result event',
    [
      'type',
      'subtype',
      'is_error',
      'duration_ms',
      'num_turns',
      'session_id',
      'usage',
    ],
  );
  parseClaudeUsage(drift, event.usage);
  if (typeof event.is_error !== 'boolean') {
    throw new AgentAdapterError(
      'agent_evidence',
      'Claude result is_error must be boolean.',
    );
  }
  if (event.is_error === false && event.subtype !== 'success') {
    throw new AgentAdapterError(
      'agent_evidence',
      `Claude successful result subtype mismatch: ${String(event.subtype)}.`,
    );
  }
  return {
    providerFailure: event.is_error,
    stopReason: optionalString(event.stop_reason, 'Claude result stop reason'),
  };
}

function parseToolResults(
  records: readonly Record<string, unknown>[],
): ReadonlyMap<string, { readonly failed: boolean }> {
  const results = new Map<string, { readonly failed: boolean }>();
  for (const event of records.filter((record) => record.type === 'user')) {
    const message = requiredRecord(event.message, 'Claude user message');
    for (const block of requiredArray(message.content, 'Claude user content')) {
      const item = requiredRecord(block, 'Claude tool result');
      if (item.type !== 'tool_result') continue;
      const id = requiredString(item.tool_use_id, 'Claude tool result ID');
      if (results.has(id)) {
        throw new AgentAdapterError(
          'agent_evidence',
          `Duplicate Claude tool result: ${id}.`,
        );
      }
      if (item.is_error !== undefined && typeof item.is_error !== 'boolean') {
        throw new AgentAdapterError(
          'agent_evidence',
          `Claude tool result is_error is invalid: ${id}.`,
        );
      }
      results.set(id, { failed: item.is_error === true });
    }
  }
  return results;
}

function normalizeClaudeTool(
  drift: WireFormatDrift,
  id: string,
  name: string,
  input: Record<string, unknown>,
  failed: boolean,
  _index: number,
): NormalizedToolCall {
  const common = {
    id,
    name,
    status: failed ? ('failed' as const) : ('completed' as const),
    startedAt: null,
    completedAt: null,
    durationMs: null,
  };
  switch (name) {
    case 'Bash':
      assertKeys(
        drift,
        input,
        [
          'command',
          'description',
          'timeout',
          'run_in_background',
          'dangerouslyDisableSandbox',
        ],
        'Claude Bash input',
        ['command'],
      );
      return {
        ...common,
        category: 'shell',
        command: requiredString(input.command, 'Claude Bash command'),
        paths: [],
        mutating: true,
      };
    case 'Read':
      assertKeys(
        drift,
        input,
        ['file_path', 'offset', 'limit', 'pages'],
        'Claude Read input',
        ['file_path'],
      );
      return {
        ...common,
        category: 'read',
        command: null,
        paths: [requiredString(input.file_path, 'Claude Read path')],
        mutating: false,
      };
    case 'Edit':
      assertKeys(
        drift,
        input,
        ['file_path', 'old_string', 'new_string', 'replace_all'],
        'Claude Edit input',
        ['file_path', 'old_string', 'new_string'],
      );
      return {
        ...common,
        category: 'edit',
        command: null,
        paths: [requiredString(input.file_path, 'Claude Edit path')],
        mutating: true,
      };
    case 'Write':
      assertKeys(drift, input, ['file_path', 'content'], 'Claude Write input');
      return {
        ...common,
        category: 'edit',
        command: null,
        paths: [requiredString(input.file_path, 'Claude Write path')],
        mutating: true,
      };
    case 'Glob':
      assertKeys(drift, input, ['pattern', 'path'], 'Claude Glob input', [
        'pattern',
      ]);
      return {
        ...common,
        category: 'search',
        command: null,
        paths:
          input.path === undefined
            ? []
            : [requiredString(input.path, 'Claude Glob path')],
        mutating: false,
      };
    case 'Grep':
      assertKeys(
        drift,
        input,
        [
          'pattern',
          'path',
          'glob',
          'type',
          'output_mode',
          '-A',
          '-B',
          '-C',
          '-n',
          '-i',
          'head_limit',
          'offset',
          'multiline',
        ],
        'Claude Grep input',
        ['pattern'],
      );
      return {
        ...common,
        category: 'search',
        command: null,
        paths:
          input.path === undefined
            ? []
            : [requiredString(input.path, 'Claude Grep path')],
        mutating: false,
      };
    default:
      return {
        ...common,
        category: 'other',
        command: null,
        paths: [],
        mutating: true,
      };
  }
}

interface ClaudeUsage {
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly cacheWriteTokens: number | null;
  readonly cacheReadTokens: number | null;
}

function parseClaudeUsage(drift: WireFormatDrift, value: unknown): ClaudeUsage {
  const usage = requiredRecord(value, 'Claude usage');
  assertKeys(
    drift,
    usage,
    [
      'input_tokens',
      'output_tokens',
      'cache_creation_input_tokens',
      'cache_read_input_tokens',
      'server_tool_use',
      'service_tier',
      'cache_creation',
      'inference_geo',
      'speed',
      'iterations',
    ],
    'Claude usage',
    ['input_tokens', 'output_tokens'],
  );
  const nonCachedInputTokens = requiredNonnegativeInteger(
    usage.input_tokens,
    'Claude input tokens',
  );
  const outputTokens = requiredNonnegativeInteger(
    usage.output_tokens,
    'Claude output tokens',
  );
  for (const [field, item] of [
    ['cache_creation_input_tokens', usage.cache_creation_input_tokens],
    ['cache_read_input_tokens', usage.cache_read_input_tokens],
  ] as const) {
    if (item !== undefined && item !== null) {
      requiredNonnegativeInteger(item, `Claude ${field}`);
    }
  }
  const cacheWriteTokens = optionalNonnegativeInteger(
    usage.cache_creation_input_tokens,
    'Claude cache creation input tokens',
  );
  const cacheReadTokens = optionalNonnegativeInteger(
    usage.cache_read_input_tokens,
    'Claude cache read input tokens',
  );
  // Anthropic reports input_tokens independently from both prompt-cache
  // components.  The benchmark's inputTokens is a total, so make the
  // components additive before persisting normalized evidence.
  return {
    inputTokens:
      nonCachedInputTokens + (cacheWriteTokens ?? 0) + (cacheReadTokens ?? 0),
    outputTokens,
    cacheWriteTokens,
    cacheReadTokens,
  };
}

function optionalNonnegativeInteger(
  value: unknown,
  label: string,
): number | null {
  return value === undefined || value === null
    ? null
    : requiredNonnegativeInteger(value, label);
}

function assertKeys(
  drift: WireFormatDrift,
  value: unknown,
  allowed: readonly string[],
  label: string,
  required: readonly string[] = allowed,
): asserts value is Record<string, unknown> {
  const record = requiredRecord(value, label);
  const allowedSet = new Set(allowed);
  drift.record(
    label,
    Object.keys(record).filter((key) => !allowedSet.has(key)),
  );
  for (const key of required) {
    if (!Object.hasOwn(record, key)) {
      throw new AgentAdapterError(
        'agent_evidence',
        `${label} is missing field ${key}.`,
      );
    }
  }
}

function requiredObject(value: unknown): Record<string, unknown> {
  return requiredRecord(value, 'Claude JSONL record');
}

function requiredRecord(
  value: unknown,
  label: string,
): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new AgentAdapterError(
      'agent_evidence',
      `${label} must be an object.`,
    );
  }
  return value as Record<string, unknown>;
}

function requiredArray(value: unknown, label: string): unknown[] {
  if (!Array.isArray(value)) {
    throw new AgentAdapterError('agent_evidence', `${label} must be an array.`);
  }
  return value;
}

function requiredStringArray(value: unknown, label: string): string[] {
  return requiredArray(value, label).map((item) => requiredString(item, label));
}

function requiredString(value: unknown, label: string): string {
  if (typeof value !== 'string' || value === '') {
    throw new AgentAdapterError('agent_evidence', `${label} must be a string.`);
  }
  return value;
}

function optionalString(value: unknown, label: string): string | null {
  return value === undefined || value === null
    ? null
    : requiredString(value, label);
}

function requiredNonnegativeInteger(value: unknown, label: string): number {
  if (!Number.isInteger(value) || (value as number) < 0) {
    throw new AgentAdapterError(
      'agent_evidence',
      `${label} must be a nonnegative integer.`,
    );
  }
  return value as number;
}
