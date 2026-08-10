import { readFile } from 'node:fs/promises';

import {
  EventCaptureSchema,
  RoundSchema,
  type BenchmarkRound,
  type EventCapture,
  type NormalizedToolCall,
  type UsageEvidence,
} from '../domain/contract/index.js';

import { aggregateUsage } from './agent/evidence.js';
import { writeJsonLines } from './io.js';

export interface NormalizedRounds {
  readonly rounds: readonly BenchmarkRound[];
  readonly usage: UsageEvidence;
  readonly providerFailure: boolean;
  readonly providerFailureMessage: string | null;
  readonly runFailureMessage: string | null;
  readonly tools: readonly NormalizedToolCall[];
  readonly toolsetFingerprints: readonly string[];
}

export async function normalizeEventCapture(options: {
  readonly eventLogPath: string;
  readonly roundsPath: string;
  readonly allowIncomplete: boolean;
}): Promise<NormalizedRounds> {
  const normalized = normalizeEventCaptureSource(
    await readFile(options.eventLogPath, 'utf8'),
    options.allowIncomplete,
  );
  await writeJsonLines(options.roundsPath, normalized.rounds);
  return normalized;
}

export function normalizeEventCaptureSource(
  source: string,
  allowIncomplete: boolean,
): NormalizedRounds {
  const captures = parseJsonLines(source);
  const starts = new Map<string, EventCapture>();
  const order: string[] = [];
  const completed = new Map<string, EventCapture>();
  const failed = new Map<string, EventCapture>();
  for (const capture of captures) {
    if (capture.event === 'model.started') {
      const id = modelCallId(capture);
      if (starts.has(id))
        throw new Error(`Duplicate model.started event: ${id}`);
      starts.set(id, capture);
      order.push(id);
    } else if (capture.event === 'model.completed') {
      const id = modelCallId(capture);
      if (completed.has(id) || failed.has(id)) {
        throw new Error(`Duplicate model terminal event: ${id}`);
      }
      completed.set(id, capture);
    } else if (capture.event === 'model.failed') {
      const id = modelCallId(capture);
      if (completed.has(id) || failed.has(id)) {
        throw new Error(`Duplicate model terminal event: ${id}`);
      }
      failed.set(id, capture);
    }
  }
  if (order.length === 0)
    throw new Error('Event capture contains no model call.');
  const toolGroups = normalizeElloTools(captures, allowIncomplete);
  const toolOwnerByTurn = new Map<string, string>();
  for (const id of order) {
    if (!completed.has(id)) continue;
    const start = starts.get(id);
    if (start === undefined) throw new Error(`Missing model start: ${id}`);
    toolOwnerByTurn.set(modelTurnKey(start), id);
  }
  const rounds = order.map((id, index) => {
    const start = starts.get(id);
    if (start === undefined) throw new Error(`Missing model start: ${id}`);
    const terminal = completed.get(id) ?? failed.get(id);
    if (terminal === undefined && !allowIncomplete) {
      throw new Error(`Incomplete model call without client timeout: ${id}`);
    }
    const turnKey = modelTurnKey(start);
    return createRound(
      index + 1,
      start,
      terminal,
      toolOwnerByTurn.get(turnKey) === id
        ? (toolGroups.byTurn.get(turnKey) ?? [])
        : [],
    );
  });
  for (const id of [...completed.keys(), ...failed.keys()]) {
    if (!starts.has(id))
      throw new Error(`Model terminal event has no start: ${id}`);
  }
  const terminalRun = captures.findLast(
    (capture) =>
      capture.event === 'run.completed' ||
      capture.event === 'run.failed' ||
      capture.event === 'run.interrupted',
  );
  const runFailureMessage =
    terminalRun?.event === 'run.failed'
      ? runFailureDiagnostic(terminalRun)
      : null;
  const terminalRunId =
    terminalRun === undefined
      ? undefined
      : requiredString(terminalRun.payload.runId, 'terminal run id');
  const providerFailures = [...failed.entries()].filter(([, capture]) =>
    terminalRunId === undefined
      ? true
      : requiredString(capture.payload.runId, 'failed model run id') ===
        terminalRunId,
  );
  const providerFailure =
    terminalRun === undefined
      ? providerFailures.length > 0
      : terminalRun.event === 'run.failed' && providerFailures.length > 0;
  return {
    rounds,
    usage: aggregateUsage(rounds),
    providerFailure,
    providerFailureMessage: providerFailure
      ? `Ello provider error: ${providerFailures
          .map(([, capture]) =>
            modelFailureMessage(
              requiredRecord(capture.payload.error, 'model error'),
            ),
          )
          .join(' | ')}`
      : null,
    runFailureMessage,
    tools: toolGroups.tools,
    toolsetFingerprints: [
      ...new Set(
        order.map((id) => {
          const start = starts.get(id);
          if (start === undefined)
            throw new Error(`Missing model start: ${id}`);
          const diagnostics = requiredRecord(
            start.payload.diagnostics,
            'model diagnostics',
          );
          return requiredString(
            diagnostics.toolsetFingerprint,
            'toolset fingerprint',
          );
        }),
      ),
    ],
  };
}

function runFailureDiagnostic(capture: EventCapture): string {
  const error = requiredRecord(capture.payload.error, 'run error');
  return `${requiredString(error.name, 'run error name')}: ${requiredString(error.message, 'run error message')}`;
}

function createRound(
  round: number,
  start: EventCapture,
  terminal: EventCapture | undefined,
  toolCalls: readonly NormalizedToolCall[],
): BenchmarkRound {
  const identity = requiredRecord(start.payload.identity, 'model identity');
  const startedAt = requiredString(start.payload.occurredAt, 'model startedAt');
  const base = {
    schema: 'ello.benchmark.round.v2' as const,
    round,
    requestId: requiredString(identity.modelCallId, 'model call id'),
    agentName: requiredString(identity.agentName, 'agent name'),
    modelSelector: requiredModelSelector(identity.modelSelector),
    configuredModel: requiredString(
      identity.configuredModel,
      'configured model',
    ),
    protocol: requiredModelProtocol(identity.protocol),
    apiModel: requiredString(identity.apiModel, 'api model'),
    startedAt,
    firstTokenAt: null,
    toolCalls,
    firstTokenLatencyMs: null,
  };
  if (terminal === undefined) {
    return RoundSchema.parse({
      ...base,
      completedAt: null,
      status: 'incomplete',
      usage: {
        status: 'unavailable',
        reason: 'Ello model call timed out before terminal usage evidence.',
      },
      durationMs: null,
    });
  }
  const completedAt = requiredString(
    terminal.payload.occurredAt,
    'model completedAt',
  );
  const durationMs = elapsedMilliseconds(startedAt, completedAt);
  if (terminal.event === 'model.failed') {
    const error = requiredRecord(terminal.payload.error, 'model error');
    return RoundSchema.parse({
      ...base,
      completedAt,
      status: 'failed',
      error: modelFailureMessage(error),
      usage: {
        status: 'unavailable',
        reason: 'Ello provider failure did not return complete usage evidence.',
      },
      durationMs,
    });
  }
  if (terminal.event !== 'model.completed') {
    throw new Error(`Unsupported model terminal event: ${terminal.event}`);
  }
  const response = requiredRecord(terminal.payload.response, 'model response');
  const usage = requiredRecord(response.usage, 'model usage');
  const firstTokenAt = optionalString(terminal.payload.firstTokenAt) ?? null;
  return RoundSchema.parse({
    ...base,
    completedAt,
    firstTokenAt,
    status: 'completed',
    finishReason: requiredString(response.finishReason, 'model finish reason'),
    usage: {
      status: 'complete',
      requests: 1,
      inputTokens: requiredNonnegativeInteger(
        usage.inputTokens,
        'input tokens',
      ),
      outputTokens: requiredNonnegativeInteger(
        usage.outputTokens,
        'output tokens',
      ),
      cacheReadTokens: requiredNonnegativeInteger(
        usage.cacheReadTokens,
        'cache read tokens',
      ),
      cacheWriteTokens: requiredNonnegativeInteger(
        usage.cacheWriteTokens,
        'cache write tokens',
      ),
      reasoningTokens: null,
      toolCalls: toolCalls.length,
    },
    durationMs,
    firstTokenLatencyMs:
      firstTokenAt === null
        ? null
        : elapsedMilliseconds(startedAt, firstTokenAt),
  });
}

function modelFailureMessage(error: Record<string, unknown>): string {
  const message = `${requiredString(error.name, 'error name')}: ${requiredString(error.message, 'error message')}`;
  const cause = error.cause;
  if (typeof cause !== 'object' || cause === null) return message;
  const code = Reflect.get(cause, 'code');
  return typeof code === 'string' && code !== ''
    ? `${message} [${code}]`
    : message;
}

function normalizeElloTools(
  captures: readonly EventCapture[],
  allowIncomplete: boolean,
): {
  readonly tools: readonly NormalizedToolCall[];
  readonly byTurn: ReadonlyMap<string, readonly NormalizedToolCall[]>;
} {
  const starts = new Map<string, EventCapture>();
  const terminals = new Map<string, EventCapture>();
  const providerCallTurns = new Map<string, string>();
  const commandRunTurns = new Map<string, string>();
  for (const capture of captures) {
    if (capture.event !== 'model.completed') continue;
    const response = requiredRecord(capture.payload.response, 'model response');
    const toolCalls = Array.isArray(response.toolCalls)
      ? response.toolCalls
      : [];
    for (const toolCall of toolCalls) {
      const call = requiredRecord(toolCall, 'model tool call');
      providerCallTurns.set(
        requiredString(call.id, 'model tool call id'),
        modelTurnKey(capture),
      );
    }
  }
  for (const capture of captures) {
    const commandEvent = readCommandEvent(capture);
    if (commandEvent?.type !== 'command_run.started') continue;
    const providerToolCallId = requiredString(
      commandEvent.providerToolCallId,
      'provider tool call id',
    );
    const owner = providerCallTurns.get(providerToolCallId);
    if (owner !== undefined) {
      commandRunTurns.set(
        requiredString(commandEvent.commandRunId, 'command run id'),
        owner,
      );
    }
  }
  for (const capture of captures) {
    const commandEvent = readCommandEvent(capture);
    if (
      capture.event === 'tool.started' ||
      commandEvent?.type === 'command.started'
    ) {
      const id =
        commandEvent === undefined
          ? requiredString(capture.payload.toolCallId, 'tool call id')
          : requiredString(
              requiredRecord(commandEvent.record, 'command record').commandId,
              'command id',
            );
      if (starts.has(id)) throw new Error(`Duplicate tool start event: ${id}`);
      starts.set(id, capture);
    }
    if (
      capture.event === 'tool.completed' ||
      capture.event === 'tool.failed' ||
      commandEvent?.type === 'command.completed' ||
      commandEvent?.type === 'command.failed'
    ) {
      const id =
        commandEvent === undefined
          ? requiredString(capture.payload.toolCallId, 'tool call id')
          : requiredString(
              requiredRecord(commandEvent.record, 'command record').commandId,
              'command id',
            );
      if (terminals.has(id))
        throw new Error(`Duplicate tool terminal event: ${id}`);
      terminals.set(id, capture);
    }
  }
  for (const [id, terminal] of terminals) {
    if (starts.has(id)) continue;
    const record = readCommandRecord(terminal);
    if (record !== undefined) {
      starts.set(id, terminal);
    }
  }
  const tools: NormalizedToolCall[] = [];
  const byTurn = new Map<string, NormalizedToolCall[]>();
  for (const [id, start] of starts) {
    const terminal = terminals.get(id);
    if (terminal === undefined && !allowIncomplete) {
      throw new Error(`Incomplete Ello tool call: ${id}`);
    }
    const startRecord = readCommandRecord(start);
    const terminalRecord =
      terminal === undefined ? undefined : readCommandRecord(terminal);
    const name = requiredString(
      startRecord?.name ?? start.payload.name,
      'tool name',
    );
    const input = requiredRecord(
      startRecord?.input ?? start.payload.input,
      'tool input',
    );
    const startedAt =
      startRecord === undefined
        ? requiredString(start.payload.occurredAt, 'tool startedAt')
        : (optionalString(startRecord.startedAt) ?? null);
    const completedAt =
      terminal === undefined
        ? null
        : requiredString(
            terminalRecord?.completedAt ?? terminal.payload.occurredAt,
            'tool completedAt',
          );
    const terminalCommandEvent =
      terminal === undefined ? undefined : readCommandEvent(terminal);
    const tool = normalizeElloTool({
      id,
      name,
      input,
      status:
        terminal?.event === 'tool.completed' ||
        terminalCommandEvent?.type === 'command.completed'
          ? 'completed'
          : 'failed',
      startedAt,
      completedAt,
    });
    tools.push(tool);
    const turnKey =
      commandTurnKey(start, commandRunTurns) ?? eventTurnKey(start, 'tool');
    const current = byTurn.get(turnKey) ?? [];
    current.push(tool);
    byTurn.set(turnKey, current);
  }
  for (const id of terminals.keys()) {
    if (!starts.has(id))
      throw new Error(`Tool terminal event has no start: ${id}`);
  }
  return { tools, byTurn };
}

function readCommandEvent(
  capture: EventCapture,
): Record<string, unknown> | undefined {
  if (capture.event !== 'command.event') return undefined;
  return requiredRecord(capture.payload.event, 'command event');
}

function readCommandRecord(
  capture: EventCapture,
): Record<string, unknown> | undefined {
  const event = readCommandEvent(capture);
  if (event === undefined) return undefined;
  return requiredRecord(event.record, 'command record');
}

function commandTurnKey(
  capture: EventCapture,
  commandRunTurns: ReadonlyMap<string, string>,
): string | undefined {
  const commandEvent = readCommandEvent(capture);
  if (commandEvent === undefined) return undefined;
  const record = requiredRecord(commandEvent.record, 'command record');
  const commandRunId = requiredString(record.commandRunId, 'command run id');
  const owner = commandRunTurns.get(commandRunId);
  if (owner === undefined) {
    throw new Error(
      `Command Run has no completed model owner: ${commandRunId}`,
    );
  }
  return owner;
}

function normalizeElloTool(options: {
  readonly id: string;
  readonly name: string;
  readonly input: Record<string, unknown>;
  readonly status: 'completed' | 'failed';
  readonly startedAt: string | null;
  readonly completedAt: string | null;
}): NormalizedToolCall {
  const common = {
    id: options.id,
    name: options.name,
    status: options.status,
    startedAt: options.startedAt,
    completedAt: options.completedAt,
    durationMs:
      options.startedAt === null || options.completedAt === null
        ? null
        : elapsedMilliseconds(options.startedAt, options.completedAt),
  };
  if (options.name === 'bash' || options.name === 'test') {
    return {
      ...common,
      category: 'shell',
      command: requiredString(options.input.command, 'bash command'),
      paths: [],
      mutating: true,
    };
  }
  if (options.name === 'read') {
    return {
      ...common,
      category: 'read',
      command: null,
      paths: [requiredString(options.input.filePath, 'read file path')],
      mutating: false,
    };
  }
  if (options.name === 'grep' || options.name === 'glob') {
    return {
      ...common,
      category: 'search',
      command: null,
      paths: [requiredString(options.input.filePath, 'search file path')],
      mutating: false,
    };
  }
  if (['write', 'edit'].includes(options.name)) {
    return {
      ...common,
      category: 'edit',
      command: null,
      paths: [requiredString(options.input.filePath, 'edit file path')],
      mutating: true,
    };
  }
  if (options.name === 'apply_patch') {
    return {
      ...common,
      category: 'edit',
      command: null,
      paths: patchPaths(
        requiredString(options.input.patch, 'apply_patch input'),
        options.status === 'failed',
      ),
      mutating: true,
    };
  }
  return {
    ...common,
    category: 'other',
    command: null,
    paths: [],
    mutating: options.name.startsWith('task_'),
  };
}

function patchPaths(source: string, allowEmpty: boolean): string[] {
  const paths = [
    ...source.matchAll(/^\*\*\* (?:Add|Update|Delete) File: (.+)$/gmu),
  ].map((match) => requiredString(match[1], 'apply_patch file path'));
  if (paths.length === 0 && !allowEmpty) {
    throw new Error('apply_patch contains no file path.');
  }
  return paths;
}

function parseJsonLines(source: string): EventCapture[] {
  const lines = source.split(/\r?\n/u).filter((line) => line !== '');
  return lines.map((line, index) => {
    try {
      return EventCaptureSchema.parse(JSON.parse(line) as unknown);
    } catch (error) {
      throw new Error(`Invalid event capture line ${index + 1}.`, {
        cause: error,
      });
    }
  });
}

function modelCallId(capture: EventCapture): string {
  const identity = requiredRecord(capture.payload.identity, 'model identity');
  return requiredString(identity.modelCallId, 'model call id');
}

function modelTurnKey(capture: EventCapture): string {
  const identity = requiredRecord(capture.payload.identity, 'model identity');
  return turnKey(
    requiredString(identity.runId, 'model run id'),
    requiredInteger(identity.turnIndex, 'model turn index'),
  );
}

function eventTurnKey(capture: EventCapture, label: string): string {
  return turnKey(
    requiredString(capture.payload.runId, `${label} run id`),
    requiredInteger(capture.payload.turnIndex, `${label} turn index`),
  );
}

function turnKey(runId: string, turnIndex: number): string {
  return `${runId}\u0000${turnIndex}`;
}

function elapsedMilliseconds(start: string, end: string): number {
  const elapsed = Date.parse(end) - Date.parse(start);
  if (elapsed < 0)
    throw new Error(`Negative event duration: ${start} to ${end}.`);
  return elapsed;
}

function requiredRecord(
  value: unknown,
  label: string,
): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error(`Missing ${label}.`);
  }
  return value as Record<string, unknown>;
}

function requiredString(value: unknown, label: string): string {
  if (typeof value !== 'string' || value === '')
    throw new Error(`Missing ${label}.`);
  return value;
}

function optionalString(value: unknown): string | undefined {
  if (value === undefined) return undefined;
  return requiredString(value, 'optional string');
}

function requiredModelSelector(
  value: unknown,
): 'primary_model' | 'auxiliary_model' {
  if (value === 'primary_model' || value === 'auxiliary_model') return value;
  throw new Error('Missing model selector.');
}

function requiredModelProtocol(
  value: unknown,
): 'openai' | 'anthropic' | 'openai-compatible' {
  if (
    value === 'openai' ||
    value === 'anthropic' ||
    value === 'openai-compatible'
  ) {
    return value;
  }
  throw new Error('Missing model protocol.');
}

function requiredInteger(value: unknown, label: string): number {
  if (!Number.isInteger(value)) throw new Error(`Invalid ${label}.`);
  return value as number;
}

function requiredNonnegativeInteger(value: unknown, label: string): number {
  const result = requiredInteger(value, label);
  if (result < 0) throw new Error(`Invalid ${label}.`);
  return result;
}
