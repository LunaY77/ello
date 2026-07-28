import { readFile } from 'node:fs/promises';

import {
  NormalizedAgentEvidenceSchema,
  RoundSchema,
  type BenchmarkRound,
  type CodexAgentSpec,
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

type JsonRecord = Record<string, unknown>;

interface TerminalEvent {
  readonly kind: 'completed' | 'failed';
  readonly occurredAt: string | null;
  readonly usage?: {
    readonly inputTokens: number;
    readonly cachedInputTokens: number;
    readonly cacheWriteInputTokens: number;
    readonly outputTokens: number;
    readonly reasoningOutputTokens: number;
  };
  readonly error?: string;
}

interface ToolState {
  readonly type: string;
  readonly tool: NormalizedToolCall;
  readonly terminal: boolean;
}

export async function parseCodexEvidence(options: {
  readonly agent: CodexAgentSpec;
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
    'Codex stdout',
  ).map((record) => requiredRecord(record, 'Codex event'));
  const drift = new WireFormatDrift();
  let threadId: string | undefined;
  let turnStartedAt: string | null = null;
  let turnStarts = 0;
  let terminal: TerminalEvent | undefined;
  const toolStates = new Map<string, ToolState>();

  for (const record of records) {
    const type = requiredString(record.type, 'Codex event type');
    switch (type) {
      case 'thread.started':
        recordUnknown(drift, 'Codex thread.started', record, [
          'type',
          'thread_id',
          'timestamp',
        ]);
        if (threadId !== undefined) {
          throw evidenceError('Codex stdout contains multiple threads.');
        }
        threadId = requiredString(record.thread_id, 'Codex thread id');
        optionalTimestamp(record.timestamp, 'Codex thread timestamp');
        break;
      case 'turn.started':
        recordUnknown(drift, 'Codex turn.started', record, [
          'type',
          'turn_id',
          'timestamp',
        ]);
        turnStarts += 1;
        turnStartedAt = optionalTimestamp(
          record.timestamp,
          'Codex turn start timestamp',
        );
        optionalString(record.turn_id, 'Codex turn id');
        break;
      case 'turn.completed':
        ensureNoTerminal(terminal);
        terminal = parseCompletedEvent(drift, record);
        break;
      case 'turn.failed':
        ensureNoTerminal(terminal);
        terminal = parseFailedEvent(drift, record);
        break;
      case 'item.started':
      case 'item.updated':
      case 'item.completed':
        parseItemEvent(drift, record, type, toolStates);
        break;
      case 'error':
        parseErrorEvent(drift, record);
        break;
      default:
        throw evidenceError(`Unsupported Codex stream event: ${type}.`);
    }
  }

  if (threadId === undefined) {
    throw evidenceError('Codex stdout contains no thread.started event.');
  }
  if (turnStarts !== 1) {
    throw evidenceError(
      `Codex stdout requires one turn.started event; observed ${turnStarts}.`,
    );
  }
  if (!options.execution.process.timedOut && terminal === undefined) {
    throw evidenceError('Codex stdout contains no terminal turn event.');
  }

  const tools = finalizeTools(toolStates, options.execution.process.timedOut);
  const providerFailure = terminal?.kind === 'failed';
  const providerFailureMessage = providerFailure
    ? `Codex provider error: ${terminal?.error ?? 'turn failed'}`
    : null;
  const round = createRound({
    agent: options.agent,
    requestId: threadId,
    startedAt: turnStartedAt,
    terminal,
    timedOut: options.execution.process.timedOut,
    tools,
    providerFailureMessage,
  });
  const rounds = [round];
  if (options.persistRounds !== false) {
    await writeJsonLines(options.roundsPath, rounds);
  }
  const evidence = NormalizedAgentEvidenceSchema.parse({
    schema: 'ello.benchmark.agent-evidence.v1',
    agentId: options.agent.id,
    kind: options.agent.kind,
    observedModel: options.agent.model,
    terminalStatus: options.execution.process.timedOut
      ? 'timed_out'
      : providerFailure
        ? 'failed'
        : 'completed',
    providerFailure,
    parserCoverage: 'complete',
    terminalStopReason: null,
    unknownFields: drift.list(),
    rawSource: await fileEvidence(options.execution.stdoutPath),
    rounds: await fileEvidence(options.roundsPath),
    roundCount: rounds.length,
    usage: aggregateUsage(rounds),
    tools: summarizeTools(rounds),
  });
  return { evidence, rounds, tools, providerFailureMessage };
}

function createRound(options: {
  readonly agent: CodexAgentSpec;
  readonly requestId: string;
  readonly startedAt: string | null;
  readonly terminal: TerminalEvent | undefined;
  readonly timedOut: boolean;
  readonly tools: readonly NormalizedToolCall[];
  readonly providerFailureMessage: string | null;
}): BenchmarkRound {
  const completedAt = options.terminal?.occurredAt ?? null;
  const base = {
    schema: 'ello.benchmark.round.v2' as const,
    round: 1,
    requestId: options.requestId,
    provider: 'openai-responses',
    model: options.agent.model,
    startedAt: options.startedAt,
    firstTokenAt: null,
    completedAt,
    toolCalls: options.tools,
    durationMs: elapsedMilliseconds(options.startedAt, completedAt),
    firstTokenLatencyMs: null,
  };
  if (options.timedOut) {
    return RoundSchema.parse({
      ...base,
      completedAt: null,
      status: 'incomplete',
      usage: {
        status: 'unavailable',
        reason: 'Codex timed out before a complete turn.',
      },
      durationMs: null,
    });
  }
  if (options.terminal?.kind === 'failed') {
    return RoundSchema.parse({
      ...base,
      status: 'failed',
      error: options.providerFailureMessage ?? 'Codex turn failed.',
      usage: {
        status: 'unavailable',
        reason: 'Codex provider failure did not return complete token usage.',
      },
    });
  }
  const usage = options.terminal?.usage;
  if (usage === undefined) {
    throw evidenceError('Codex completed turn has no usage.');
  }
  return RoundSchema.parse({
    ...base,
    status: 'completed',
    usage: {
      status: 'complete',
      requests: 1,
      inputTokens: usage.inputTokens,
      outputTokens: usage.outputTokens,
      cacheReadTokens: usage.cachedInputTokens,
      cacheWriteTokens: usage.cacheWriteInputTokens,
      reasoningTokens: usage.reasoningOutputTokens,
      toolCalls: options.tools.length,
    },
  });
}

function parseCompletedEvent(
  drift: WireFormatDrift,
  record: JsonRecord,
): TerminalEvent {
  recordUnknown(drift, 'Codex turn.completed', record, [
    'type',
    'turn_id',
    'timestamp',
    'usage',
  ]);
  optionalString(record.turn_id, 'Codex completed turn id');
  const usage = requiredRecord(record.usage, 'Codex turn usage');
  recordUnknown(drift, 'Codex turn usage', usage, [
    'input_tokens',
    'cached_input_tokens',
    'cache_write_input_tokens',
    'output_tokens',
    'reasoning_output_tokens',
  ]);
  return {
    kind: 'completed',
    occurredAt: optionalTimestamp(
      record.timestamp,
      'Codex turn completion timestamp',
    ),
    usage: {
      inputTokens: requiredNonnegativeInteger(
        usage.input_tokens,
        'Codex input tokens',
      ),
      cachedInputTokens: requiredNonnegativeInteger(
        usage.cached_input_tokens,
        'Codex cached input tokens',
      ),
      cacheWriteInputTokens:
        usage.cache_write_input_tokens === undefined
          ? 0
          : requiredNonnegativeInteger(
              usage.cache_write_input_tokens,
              'Codex cache write input tokens',
            ),
      outputTokens: requiredNonnegativeInteger(
        usage.output_tokens,
        'Codex output tokens',
      ),
      reasoningOutputTokens: requiredNonnegativeInteger(
        usage.reasoning_output_tokens,
        'Codex reasoning output tokens',
      ),
    },
  };
}

function parseFailedEvent(
  drift: WireFormatDrift,
  record: JsonRecord,
): TerminalEvent {
  recordUnknown(drift, 'Codex turn.failed', record, [
    'type',
    'turn_id',
    'timestamp',
    'error',
  ]);
  optionalString(record.turn_id, 'Codex failed turn id');
  const error = requiredRecord(record.error, 'Codex turn error');
  recordUnknown(drift, 'Codex turn error', error, ['message']);
  return {
    kind: 'failed',
    occurredAt: optionalTimestamp(
      record.timestamp,
      'Codex turn failure timestamp',
    ),
    error: requiredString(error.message, 'Codex turn error message'),
  };
}

function parseErrorEvent(drift: WireFormatDrift, record: JsonRecord): void {
  recordUnknown(drift, 'Codex error', record, ['type', 'message', 'timestamp']);
  requiredString(record.message, 'Codex error message');
  optionalTimestamp(record.timestamp, 'Codex error timestamp');
}

function parseItemEvent(
  drift: WireFormatDrift,
  record: JsonRecord,
  eventType: 'item.started' | 'item.updated' | 'item.completed',
  states: Map<string, ToolState>,
): void {
  recordUnknown(drift, `Codex ${eventType}`, record, [
    'type',
    'timestamp',
    'item',
  ]);
  const occurredAt = optionalTimestamp(
    record.timestamp,
    `Codex ${eventType} timestamp`,
  );
  const item = requiredRecord(record.item, `Codex ${eventType} item`);
  const parsed = parseItem(drift, item, eventType, occurredAt);
  if (parsed === null) return;
  const previous = states.get(parsed.tool.id);
  if (previous !== undefined && previous.type !== parsed.type) {
    throw evidenceError(
      `Codex item ${parsed.tool.id} changed type from ${previous.type} to ${parsed.type}.`,
    );
  }
  if (previous?.terminal === true) {
    throw evidenceError(
      `Codex item ${parsed.tool.id} completed more than once.`,
    );
  }
  states.set(parsed.tool.id, {
    ...parsed,
    terminal: eventType === 'item.completed',
  });
}

function parseItem(
  drift: WireFormatDrift,
  item: JsonRecord,
  eventType: 'item.started' | 'item.updated' | 'item.completed',
  occurredAt: string | null,
): Omit<ToolState, 'terminal'> | null {
  const id = requiredString(item.id, 'Codex item id');
  const type = requiredString(item.type, 'Codex item type');
  const terminal = eventType === 'item.completed';
  switch (type) {
    case 'command_execution': {
      recordUnknown(drift, 'Codex command item', item, [
        'id',
        'type',
        'command',
        'aggregated_output',
        'exit_code',
        'status',
      ]);
      const status = requiredString(item.status, 'Codex command status');
      optionalText(item.aggregated_output, 'Codex command output');
      optionalInteger(item.exit_code, 'Codex command exit code');
      return {
        type,
        tool: {
          id,
          name: type,
          category: 'shell',
          status: terminal && status === 'completed' ? 'completed' : 'failed',
          startedAt: occurredAt,
          completedAt: terminal ? occurredAt : null,
          durationMs: null,
          command: requiredString(item.command, 'Codex command'),
          paths: [],
          mutating: true,
        },
      };
    }
    case 'file_change': {
      recordUnknown(drift, 'Codex file change item', item, [
        'id',
        'type',
        'changes',
        'status',
      ]);
      const status = requiredString(item.status, 'Codex file change status');
      const changes = requiredArray(item.changes, 'Codex file changes').map(
        (change, index) => {
          const value = requiredRecord(change, `Codex file change ${index}`);
          recordUnknown(drift, 'Codex file change', value, ['path', 'kind']);
          requiredString(value.kind, 'Codex file change kind');
          return requiredString(value.path, 'Codex file change path');
        },
      );
      return {
        type,
        tool: {
          id,
          name: type,
          category: 'edit',
          status: terminal && status === 'completed' ? 'completed' : 'failed',
          startedAt: occurredAt,
          completedAt: terminal ? occurredAt : null,
          durationMs: null,
          command: null,
          paths: changes,
          mutating: true,
        },
      };
    }
    case 'mcp_tool_call': {
      recordUnknown(drift, 'Codex MCP item', item, [
        'id',
        'type',
        'server',
        'tool',
        'arguments',
        'result',
        'error',
        'status',
      ]);
      const status = requiredString(item.status, 'Codex MCP status');
      return {
        type,
        tool: {
          id,
          name: `mcp:${requiredString(item.server, 'Codex MCP server')}/${requiredString(item.tool, 'Codex MCP tool')}`,
          category: 'other',
          status: terminal && status === 'completed' ? 'completed' : 'failed',
          startedAt: occurredAt,
          completedAt: terminal ? occurredAt : null,
          durationMs: null,
          command: null,
          paths: [],
          mutating: false,
        },
      };
    }
    case 'collab_tool_call': {
      recordUnknown(drift, 'Codex collaboration item', item, [
        'id',
        'type',
        'tool',
        'sender_thread_id',
        'receiver_thread_ids',
        'prompt',
        'agents_states',
        'status',
      ]);
      const status = requiredString(item.status, 'Codex collaboration status');
      return {
        type,
        tool: {
          id,
          name: `collab:${requiredString(item.tool, 'Codex collaboration tool')}`,
          category: 'other',
          status: terminal && status === 'completed' ? 'completed' : 'failed',
          startedAt: occurredAt,
          completedAt: terminal ? occurredAt : null,
          durationMs: null,
          command: null,
          paths: [],
          mutating: false,
        },
      };
    }
    case 'web_search':
      recordUnknown(drift, 'Codex web search item', item, [
        'id',
        'type',
        'query',
        'action',
      ]);
      return {
        type,
        tool: {
          id,
          name: 'web_search',
          category: 'search',
          status: terminal ? 'completed' : 'failed',
          startedAt: occurredAt,
          completedAt: terminal ? occurredAt : null,
          durationMs: null,
          command: null,
          paths: [],
          mutating: false,
        },
      };
    case 'agent_message':
      recordUnknown(drift, 'Codex agent message item', item, [
        'id',
        'type',
        'text',
      ]);
      requiredString(item.text, 'Codex agent message');
      return null;
    case 'reasoning':
      recordUnknown(drift, 'Codex reasoning item', item, [
        'id',
        'type',
        'text',
      ]);
      requiredString(item.text, 'Codex reasoning');
      return null;
    case 'todo_list':
      recordUnknown(drift, 'Codex todo item', item, ['id', 'type', 'items']);
      requiredArray(item.items, 'Codex todo items');
      return null;
    case 'error':
      recordUnknown(drift, 'Codex item error', item, ['id', 'type', 'message']);
      requiredString(item.message, 'Codex item error message');
      return null;
    default:
      throw evidenceError(`Unsupported Codex item type: ${type}.`);
  }
}

function finalizeTools(
  states: ReadonlyMap<string, ToolState>,
  timedOut: boolean,
): NormalizedToolCall[] {
  const tools: NormalizedToolCall[] = [];
  for (const state of states.values()) {
    if (!state.terminal && !timedOut) {
      throw evidenceError(`Incomplete Codex tool item: ${state.tool.id}.`);
    }
    tools.push(state.tool);
  }
  return tools;
}

function ensureNoTerminal(terminal: TerminalEvent | undefined): void {
  if (terminal !== undefined) {
    throw evidenceError('Codex stdout contains multiple terminal turn events.');
  }
}

function recordUnknown(
  drift: WireFormatDrift,
  label: string,
  value: JsonRecord,
  known: readonly string[],
): void {
  const fields = Object.keys(value).filter((key) => !known.includes(key));
  drift.record(label, fields);
}

function requiredRecord(value: unknown, label: string): JsonRecord {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw evidenceError(`Missing ${label}.`);
  }
  return value as JsonRecord;
}

function requiredArray(value: unknown, label: string): readonly unknown[] {
  if (!Array.isArray(value)) throw evidenceError(`Missing ${label}.`);
  return value;
}

function requiredString(value: unknown, label: string): string {
  if (typeof value !== 'string' || value === '') {
    throw evidenceError(`Missing ${label}.`);
  }
  return value;
}

function optionalString(value: unknown, label: string): string | undefined {
  if (value === undefined || value === null) return undefined;
  return requiredString(value, label);
}

function optionalText(value: unknown, label: string): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'string') throw evidenceError(`Invalid ${label}.`);
  return value;
}

function optionalTimestamp(value: unknown, label: string): string | null {
  const timestamp = optionalString(value, label);
  if (timestamp === undefined) return null;
  if (Number.isNaN(Date.parse(timestamp))) {
    throw evidenceError(`Invalid ${label}.`);
  }
  return timestamp;
}

function requiredNonnegativeInteger(value: unknown, label: string): number {
  if (!Number.isInteger(value) || (value as number) < 0) {
    throw evidenceError(`Invalid ${label}.`);
  }
  return value as number;
}

function optionalInteger(value: unknown, label: string): number | undefined {
  if (value === undefined || value === null) return undefined;
  if (!Number.isInteger(value)) throw evidenceError(`Invalid ${label}.`);
  return value as number;
}

function elapsedMilliseconds(
  startedAt: string | null,
  completedAt: string | null,
): number | null {
  if (startedAt === null || completedAt === null) return null;
  const elapsed = Date.parse(completedAt) - Date.parse(startedAt);
  if (elapsed < 0) throw evidenceError('Negative Codex turn duration.');
  return elapsed;
}

function evidenceError(message: string): AgentAdapterError {
  return new AgentAdapterError('agent_evidence', message);
}
