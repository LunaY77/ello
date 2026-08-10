/**
 * Command Run 的调度、审批和恢复实现。
 *
 * 该模块只接受已有领域能力的结构化定义，不依赖 Agent engine 或旧调度器。
 */
import { environmentExecutionGateFor } from '../environment/index.js';

import {
  compileDetails,
  compileFrames,
  digest,
  renderCatalogPrompt,
  type CatalogCommand,
  type CommandRegistrySnapshot,
  type NormalizedApproval,
  type ResolvedCommand,
} from './catalog.js';
import { createEventExecution } from './event-stream.js';
import { blockerFor, phaseBarrierFor } from './failure-barrier.js';
import { projectCommandRunResult } from './result-projector.js';
import { createCommandWaves, groupCommandPhases } from './scheduling.js';
import { createCommandRunInputSchema } from './schema.js';
import type {
  CommandApprovalRecord,
  CommandCapabilities,
  CommandRecord,
  CommandRunCheckpoint,
  CommandRunContext,
  CommandRunEvent,
  CommandRunInput,
  CommandRunRuntime,
  CommandRunTransition,
  CommandRunBarrier,
  CommandContext,
  CompiledCommandFrame,
  CommandRunResult,
  PendingCommandInteraction,
  ResumeCommandRun,
} from './types.js';

interface PreparedCommand {
  readonly frame: CompiledCommandFrame;
  readonly definition: CatalogCommand;
  readonly resolved: ResolvedCommand;
  readonly context: CommandContext;
  readonly capabilities: CommandCapabilities;
  readonly approval: NormalizedApproval;
}

type PreparationResult =
  | { readonly type: 'prepared'; readonly command: PreparedCommand }
  | {
      readonly type: 'failed';
      readonly frame: CompiledCommandFrame;
      readonly logicalName: string;
      readonly error: string;
      readonly interrupted: boolean;
    };

interface RuntimeState {
  readonly commandRunId: string;
  readonly providerToolCallId: string;
  readonly inputDigest: string;
  readonly frames: readonly CompiledCommandFrame[];
  readonly results: CommandRecord[];
  readonly approvals: CommandApprovalRecord[];
  phaseCursor: number;
  barrier?: CommandRunBarrier;
  interruptedBy?: string;
}

const COMMAND_RUN_DESCRIPTION =
  'Execute one Command Run: an ordered batch of Command Frames validated as a whole before any Command starts. Steps then execute in ascending order, and the runtime schedules the Commands inside one step.';

/** 创建当前 Agent 的 Command Run runtime。 */
export function createCommandRunRuntime(
  registry: CommandRegistrySnapshot,
): CommandRunRuntime {
  const catalog = registry.inline;
  const inputSchema = createCommandRunInputSchema(
    [...catalog.keys()].sort((left, right) => left.localeCompare(right)),
  );
  const catalogRevision = registry.revision;
  return {
    modelTool: {
      name: 'command_run',
      description: `${COMMAND_RUN_DESCRIPTION}\n\n${renderCatalogPrompt(catalog)}`,
      input: inputSchema,
    },
    catalogRevision,
    start(request) {
      return createEventExecution(async (emit) => {
        const commandRunId = `command-run:${request.providerToolCallId}`;
        let parsed: CommandRunInput;
        try {
          parsed = inputSchema.parse(request.input);
        } catch (error) {
          const failed = compileFailure(request.providerToolCallId, error);
          await emitCompileFailure(
            emit,
            commandRunId,
            request.providerToolCallId,
            failed,
          );
          return failed;
        }
        let frames: readonly CompiledCommandFrame[];
        try {
          frames = compileFrames(commandRunId, parsed.commands, catalog);
        } catch (error) {
          const failed = compileFailure(request.providerToolCallId, error);
          await emitCompileFailure(
            emit,
            commandRunId,
            request.providerToolCallId,
            failed,
          );
          return failed;
        }
        const state: RuntimeState = {
          commandRunId,
          providerToolCallId: request.providerToolCallId,
          inputDigest: digest(frames.map((frame) => frame.input)),
          frames,
          results: [],
          approvals: [],
          phaseCursor: 0,
        };
        await emit({
          type: 'command_run.started',
          commandRunId,
          providerToolCallId: request.providerToolCallId,
          commands: frames,
          occurredAt: now(),
        });
        return executeState(
          state,
          request.context,
          catalog,
          catalogRevision,
          emit,
        );
      });
    },
    resume(request) {
      return createEventExecution(async (emit) => {
        validateCheckpoint(request.checkpoint, catalogRevision);
        const state = restoreState(request.checkpoint);
        const resumedRecords = applyResumeDecisions(state, request);
        await emit({
          type: 'command_run.started',
          commandRunId: state.commandRunId,
          providerToolCallId: state.providerToolCallId,
          commands: state.frames,
          occurredAt: now(),
        });
        for (const record of resumedRecords) {
          await emit({
            type:
              record.status === 'completed'
                ? 'command.completed'
                : record.status === 'blocked'
                  ? 'command.blocked'
                  : record.status === 'denied'
                    ? 'command.denied'
                    : 'command.failed',
            record,
            occurredAt: record.completedAt ?? now(),
          });
        }
        return executeState(
          state,
          request.context,
          catalog,
          catalogRevision,
          emit,
        );
      });
    },
  };
}

async function executeState(
  state: RuntimeState,
  context: CommandRunContext,
  catalog: ReadonlyMap<string, CatalogCommand>,
  catalogRevision: string,
  emit: (event: CommandRunEvent) => Promise<void>,
): Promise<CommandRunTransition> {
  const phases = groupCommandPhases(state.frames);
  while (state.phaseCursor < phases.length) {
    const phase = phases[state.phaseCursor];
    if (phase === undefined)
      throw new Error('Command phase cursor is invalid.');
    const remaining = phase.filter(
      (frame) =>
        !state.results.some((record) => record.commandId === frame.commandId),
    );
    if (remaining.length === 0) {
      commitBarrier(state, phase);
      state.phaseCursor += 1;
      continue;
    }
    if (context.signal.aborted || state.interruptedBy !== undefined) {
      state.interruptedBy ??= 'command-run-interrupted';
      for (const frame of remaining) {
        await recordBlockedFrame(state, frame, emit);
      }
      state.phaseCursor += 1;
      continue;
    }

    const blockedByEarlierStep =
      state.barrier === undefined
        ? []
        : remaining.filter((frame) => frame.onFailure !== 'diagnose');
    for (const frame of blockedByEarlierStep) {
      await recordBlockedFrame(state, frame, emit);
    }
    const framesToPrepare = remaining.filter(
      (frame) => !blockedByEarlierStep.includes(frame),
    );
    const preparation = await Promise.all(
      framesToPrepare.map((frame) =>
        prepareCommand(state, frame, context, catalog),
      ),
    );
    const preparationFailures = preparation.filter(
      (result): result is Extract<PreparationResult, { type: 'failed' }> =>
        result.type === 'failed',
    );
    for (const failure of preparationFailures) {
      await recordPreparationFailure(state, failure, emit);
    }
    const firstInterruptedPreparation = preparationFailures.find(
      (failure) => failure.interrupted,
    );
    if (firstInterruptedPreparation !== undefined || context.signal.aborted) {
      state.interruptedBy ??=
        firstInterruptedPreparation?.frame.commandId ??
        'command-run-interrupted';
      await recordUnfinishedPhaseFrames(state, phase, emit);
      state.phaseCursor += 1;
      continue;
    }
    const prepared = preparation.flatMap((result) =>
      result.type === 'prepared' ? [result.command] : [],
    );
    const unsafeDiagnostics = prepared.filter(
      (command) => state.barrier !== undefined && !isSafeDiagnostic(command),
    );
    for (const command of unsafeDiagnostics) {
      await recordBlocked(state, command, emit);
    }
    const eligiblePrepared = prepared.filter(
      (command) => !unsafeDiagnostics.includes(command),
    );
    const disabled = eligiblePrepared.filter(
      (command) => !command.capabilities.enabled,
    );
    for (const command of disabled) {
      await recordFailure(
        state,
        command,
        `Command '${command.resolved.logicalName}' is disabled.`,
        'failed',
        emit,
      );
    }
    const denied = eligiblePrepared.filter(
      (command) =>
        command.capabilities.enabled && command.approval.action === 'denied',
    );
    for (const command of denied) {
      await recordFailure(
        state,
        command,
        command.approval.reason ??
          `Command '${command.resolved.logicalName}' is denied.`,
        'denied',
        emit,
      );
    }
    const preparedToRun = eligiblePrepared.filter(
      (command) => !disabled.includes(command) && !denied.includes(command),
    );
    const pendingApprovals = preparedToRun.filter(
      (command) => command.approval.action === 'required',
    );
    if (pendingApprovals.length > 0) {
      return suspendForApprovals(
        state,
        pendingApprovals,
        catalogRevision,
        emit,
      );
    }
    const deferred = preparedToRun.find((command) => command.resolved.deferred);
    if (deferred !== undefined) {
      return suspendForDeferred(state, deferred, catalogRevision, emit);
    }
    for (const wave of createCommandWaves(preparedToRun)) {
      if (context.signal.aborted || state.interruptedBy !== undefined) {
        state.interruptedBy ??= 'command-run-interrupted';
        for (const command of wave) await recordBlocked(state, command, emit);
        continue;
      }
      const records = await Promise.all(
        wave.map((command) => executeCommand(state, command, emit)),
      );
      const interrupted = records.find(
        (record) => record.status === 'interrupted',
      );
      if (interrupted !== undefined || context.signal.aborted)
        state.interruptedBy ??=
          interrupted?.commandId ?? 'command-run-interrupted';
    }
    if (state.interruptedBy !== undefined)
      await recordUnfinishedPhaseFrames(state, phase, emit);
    else commitBarrier(state, phase);
    state.phaseCursor += 1;
  }
  await emit({
    type: 'command_run.completed',
    commandRunId: state.commandRunId,
    occurredAt: now(),
  });
  const result = resultFor(state);
  return {
    type: 'completed',
    result,
    observation: projectCommandRunResult(result),
  };
}

async function prepareCommand(
  state: RuntimeState,
  frame: CompiledCommandFrame,
  runContext: CommandRunContext,
  catalog: ReadonlyMap<string, CatalogCommand>,
): Promise<PreparationResult> {
  let logicalName = frame.command;
  try {
    const definition = catalog.get(frame.command);
    if (definition === undefined)
      throw new Error(`Command disappeared: ${frame.command}`);
    const resolved = definition.resolve(frame.input);
    logicalName = resolved.logicalName;
    const base = createCommandContext(state, frame, runContext);
    const gate = environmentExecutionGateFor(runContext.environment);
    const capabilities = await gate.runExclusive(
      () => resolved.capabilities(base),
      runContext.signal,
    );
    const context = createCommandContext(
      state,
      frame,
      runContext,
      capabilities,
      resolved.physicalName,
    );
    const prepare = async () => {
      await resolved.validate(context);
      return alreadyApproved(state, frame.commandId)
        ? { action: 'auto' as const }
        : await resolved.approval(context);
    };
    const approval = capabilities.concurrencySafe
      ? await gate.runShared(prepare, runContext.signal)
      : await gate.runExclusive(prepare, runContext.signal);
    return {
      type: 'prepared',
      command: {
        frame,
        definition,
        resolved,
        context,
        capabilities,
        approval,
      },
    };
  } catch (error) {
    return {
      type: 'failed',
      frame,
      logicalName,
      error: errorMessage(error),
      interrupted: runContext.signal.aborted,
    };
  }
}

function createCommandContext(
  state: RuntimeState,
  frame: CompiledCommandFrame,
  context: CommandRunContext,
  capabilities?: CommandCapabilities,
  physicalName?: string,
): CommandContext {
  return {
    runId: context.runId,
    turnIndex: context.turnIndex,
    commandId: frame.commandId,
    environment: context.environment,
    metadata: {
      ...context.metadata,
      commandRunId: state.commandRunId,
      commandId: frame.commandId,
      providerToolCallId: state.providerToolCallId,
    },
    signal: context.signal,
    ...(capabilities === undefined || physicalName === undefined
      ? {}
      : { invocation: { ...capabilities, physicalName } }),
  };
}

async function executeCommand(
  state: RuntimeState,
  command: PreparedCommand,
  emit: (event: CommandRunEvent) => Promise<void>,
): Promise<CommandRecord> {
  const startedAt = now();
  const started = baseRecord(state, command, 'running', { startedAt });
  await emit({
    type: 'command.started',
    record: started,
    occurredAt: startedAt,
  });
  try {
    const gate = environmentExecutionGateFor(command.context.environment);
    const execute = () => command.resolved.execute(command.context);
    const output = command.capabilities.concurrencySafe
      ? await gate.runShared(execute, command.context.signal)
      : await gate.runExclusive(execute, command.context.signal);
    const shellFailure = shellExitFailure(output);
    if (shellFailure !== undefined) {
      return recordFailure(
        state,
        command,
        shellFailure,
        'failed',
        emit,
        startedAt,
        output,
      );
    }
    const record = baseRecord(state, command, 'completed', {
      startedAt,
      completedAt: now(),
      output,
      metadata: commandMetadata(output, command),
    });
    state.results.push(record);
    await emit({
      type: 'command.completed',
      record,
      occurredAt: record.completedAt ?? now(),
    });
    return record;
  } catch (error) {
    return recordFailure(
      state,
      command,
      errorMessage(error),
      command.context.signal.aborted ? 'interrupted' : 'failed',
      emit,
      startedAt,
    );
  }
}

async function recordFailure(
  state: RuntimeState,
  command: PreparedCommand,
  message: string,
  status: 'failed' | 'denied' | 'interrupted',
  emit: (event: CommandRunEvent) => Promise<void>,
  startedAt = now(),
  output?: unknown,
): Promise<CommandRecord> {
  const record = baseRecord(state, command, status, {
    startedAt,
    completedAt: now(),
    error: message,
    ...(output === undefined
      ? {}
      : { output, metadata: commandMetadata(output, command) }),
  });
  state.results.push(record);
  await emit({
    type: status === 'denied' ? 'command.denied' : 'command.failed',
    record,
    occurredAt: record.completedAt ?? now(),
  });
  return record;
}

async function recordPreparationFailure(
  state: RuntimeState,
  failure: Extract<PreparationResult, { type: 'failed' }>,
  emit: (event: CommandRunEvent) => Promise<void>,
): Promise<void> {
  const completedAt = now();
  const record: CommandRecord = {
    commandRunId: state.commandRunId,
    commandId: failure.frame.commandId,
    index: failure.frame.index,
    step: failure.frame.step,
    name: failure.logicalName,
    input: failure.frame.input,
    inputDigest: failure.frame.inputDigest,
    status: failure.interrupted ? 'interrupted' : 'failed',
    error: failure.error,
    completedAt,
  };
  state.results.push(record);
  await emit({ type: 'command.failed', record, occurredAt: completedAt });
}

async function recordBlocked(
  state: RuntimeState,
  command: PreparedCommand,
  emit: (event: CommandRunEvent) => Promise<void>,
): Promise<void> {
  const blocker = blockerFor(state.barrier, state.interruptedBy, state.results);
  const record = baseRecord(state, command, 'blocked', {
    blockedBy: blocker.commandId,
    error: blocker.message,
    completedAt: now(),
  });
  state.results.push(record);
  await emit({
    type: 'command.blocked',
    record,
    occurredAt: record.completedAt ?? now(),
  });
}

async function recordBlockedFrame(
  state: RuntimeState,
  frame: CompiledCommandFrame,
  emit: (event: CommandRunEvent) => Promise<void>,
): Promise<void> {
  const blocker = blockerFor(state.barrier, state.interruptedBy, state.results);
  const record: CommandRecord = {
    commandRunId: state.commandRunId,
    commandId: frame.commandId,
    index: frame.index,
    step: frame.step,
    name: deferredLogicalName(frame.input, frame.command),
    input: frame.input,
    inputDigest: frame.inputDigest,
    status: 'blocked',
    blockedBy: blocker.commandId,
    error: blocker.message,
    completedAt: now(),
  };
  state.results.push(record);
  await emit({
    type: 'command.blocked',
    record,
    occurredAt: record.completedAt ?? now(),
  });
}

function baseRecord(
  state: RuntimeState,
  command: PreparedCommand,
  status: CommandRecord['status'],
  extra: Partial<CommandRecord>,
): CommandRecord {
  const approval = state.approvals.find(
    (record) => record.commandId === command.frame.commandId,
  );
  return {
    commandRunId: state.commandRunId,
    commandId: command.frame.commandId,
    index: command.frame.index,
    step: command.frame.step,
    name: command.resolved.logicalName,
    input: command.frame.input,
    inputDigest: command.frame.inputDigest,
    status,
    ...(approval === undefined
      ? {}
      : {
          approval: {
            status: approval.decision,
            ...(approval.reason === undefined
              ? {}
              : { reason: approval.reason }),
          },
        }),
    ...extra,
  };
}

function isSafeDiagnostic(command: PreparedCommand): boolean {
  return (
    command.frame.onFailure === 'diagnose' &&
    command.capabilities.readOnly &&
    command.capabilities.concurrencySafe &&
    !command.capabilities.destructive &&
    !command.resolved.deferred
  );
}

async function recordUnfinishedPhaseFrames(
  state: RuntimeState,
  phase: readonly CompiledCommandFrame[],
  emit: (event: CommandRunEvent) => Promise<void>,
): Promise<void> {
  for (const frame of phase) {
    if (!hasResult(state, frame.commandId))
      await recordBlockedFrame(state, frame, emit);
  }
}

function commitBarrier(
  state: RuntimeState,
  phase: readonly CompiledCommandFrame[],
): void {
  const barrier = phaseBarrierFor(
    state.barrier,
    state.interruptedBy,
    state.results,
    phase,
  );
  if (barrier !== undefined) state.barrier = barrier;
}

function hasResult(state: RuntimeState, commandId: string): boolean {
  return state.results.some((record) => record.commandId === commandId);
}

function suspendForApprovals(
  state: RuntimeState,
  commands: readonly PreparedCommand[],
  catalogRevision: string,
  emit: (event: CommandRunEvent) => Promise<void>,
): Promise<CommandRunTransition> {
  return suspend(state, commands, 'approval', catalogRevision, emit);
}

function suspendForDeferred(
  state: RuntimeState,
  command: PreparedCommand,
  catalogRevision: string,
  emit: (event: CommandRunEvent) => Promise<void>,
): Promise<CommandRunTransition> {
  return suspend(state, [command], 'deferred', catalogRevision, emit);
}

async function suspend(
  state: RuntimeState,
  commands: readonly PreparedCommand[],
  kind: 'approval' | 'deferred',
  catalogRevision: string,
  emit: (event: CommandRunEvent) => Promise<void>,
): Promise<CommandRunTransition> {
  const checkpoint = checkpointFor(
    state,
    catalogRevision,
    commands.map((command) => command.frame.commandId),
    kind,
  );
  const interactions = commands.map(
    (command): PendingCommandInteraction => ({
      kind,
      commandId: command.frame.commandId,
      commandName: command.resolved.logicalName,
      input: command.resolved.input,
      ...(command.approval.reason === undefined
        ? {}
        : { reason: command.approval.reason }),
      metadata: {
        ...(command.approval.metadata ?? {}),
        commandRunId: state.commandRunId,
        providerToolCallId: state.providerToolCallId,
        inputDigest: command.frame.inputDigest,
        catalogRevision,
      },
    }),
  );
  for (const interaction of interactions) {
    await emit({
      type:
        kind === 'approval' ? 'command.approval_required' : 'command.deferred',
      interaction,
      checkpoint,
      occurredAt: now(),
    });
  }
  await emit({
    type: 'command_run.suspended',
    commandRunId: state.commandRunId,
    occurredAt: now(),
  });
  return { type: 'suspended', checkpoint, interactions };
}

function checkpointFor(
  state: RuntimeState,
  catalogRevision: string,
  pendingCommandIds: readonly string[],
  pendingKind: 'approval' | 'deferred',
): CommandRunCheckpoint {
  return {
    schema: 1,
    commandRunId: state.commandRunId,
    providerToolCallId: state.providerToolCallId,
    inputDigest: state.inputDigest,
    catalogRevision,
    compiledFrames: state.frames,
    results: state.results,
    phaseCursor: state.phaseCursor,
    ...(state.barrier === undefined ? {} : { barrier: state.barrier }),
    approvals: state.approvals,
    pendingCommandIds,
    pendingKind,
  };
}

function validateCheckpoint(
  checkpoint: CommandRunCheckpoint,
  catalogRevision: string,
): void {
  if (checkpoint.schema !== 1)
    throw new Error('Unsupported Command Run checkpoint schema.');
  if (checkpoint.catalogRevision !== catalogRevision) {
    throw new Error(
      'Command Catalog changed while the Command Run was suspended.',
    );
  }
  if (
    digest(checkpoint.compiledFrames.map((frame) => frame.input)) !==
    checkpoint.inputDigest
  ) {
    throw new Error(
      'Command Run checkpoint input digest does not match compiled input.',
    );
  }
}

function restoreState(checkpoint: CommandRunCheckpoint): RuntimeState {
  const barrier = checkpoint.barrier ?? legacyCheckpointBarrier(checkpoint);
  return {
    commandRunId: checkpoint.commandRunId,
    providerToolCallId: checkpoint.providerToolCallId,
    inputDigest: checkpoint.inputDigest,
    frames: checkpoint.compiledFrames,
    results: [...checkpoint.results],
    approvals: [...checkpoint.approvals],
    phaseCursor: checkpoint.phaseCursor,
    ...(barrier === undefined ? {} : { barrier }),
  };
}

function legacyCheckpointBarrier(
  checkpoint: CommandRunCheckpoint,
): CommandRunBarrier | undefined {
  const phases = groupCommandPhases(checkpoint.compiledFrames);
  const currentStep = phases[checkpoint.phaseCursor]?.[0]?.step;
  const completedFrames =
    currentStep === undefined
      ? checkpoint.compiledFrames
      : checkpoint.compiledFrames.filter((frame) => frame.step < currentStep);
  const state: RuntimeState = {
    commandRunId: checkpoint.commandRunId,
    providerToolCallId: checkpoint.providerToolCallId,
    inputDigest: checkpoint.inputDigest,
    frames: checkpoint.compiledFrames,
    results: [...checkpoint.results],
    approvals: [...checkpoint.approvals],
    phaseCursor: checkpoint.phaseCursor,
  };
  for (const phase of groupCommandPhases(completedFrames))
    commitBarrier(state, phase);
  return state.barrier;
}

function applyResumeDecisions(
  state: RuntimeState,
  request: ResumeCommandRun,
): readonly CommandRecord[] {
  const resumed: CommandRecord[] = [];
  const pending = request.checkpoint.pendingCommandIds;
  if (request.checkpoint.pendingKind === 'deferred') {
    const commandId = pending[0];
    if (commandId === undefined)
      throw new Error('Deferred checkpoint has no command.');
    if (
      request.toolResults === undefined ||
      !Object.hasOwn(request.toolResults, commandId)
    ) {
      throw new Error(
        `Resume is missing deferred Command result: ${commandId}`,
      );
    }
    const frame = state.frames.find((entry) => entry.commandId === commandId);
    if (frame === undefined)
      throw new Error(`Deferred Command is absent: ${commandId}`);
    const completed: CommandRecord = {
      commandRunId: state.commandRunId,
      commandId,
      index: frame.index,
      step: frame.step,
      name: deferredLogicalName(frame.input, frame.command),
      input: frame.input,
      inputDigest: frame.inputDigest,
      status: 'completed',
      output: request.toolResults[commandId],
      completedAt: now(),
    };
    state.results.push(completed);
    resumed.push(completed);
    for (const tail of state.frames.filter(
      (entry) => entry.index > frame.index,
    )) {
      const blocked: CommandRecord = {
        commandRunId: state.commandRunId,
        commandId: tail.commandId,
        index: tail.index,
        step: tail.step,
        name: deferredLogicalName(tail.input, tail.command),
        input: tail.input,
        inputDigest: tail.inputDigest,
        status: 'blocked',
        blockedBy: commandId,
        completedAt: now(),
      };
      state.results.push(blocked);
      resumed.push(blocked);
    }
    state.phaseCursor = Number.MAX_SAFE_INTEGER;
    return resumed;
  }
  for (const commandId of pending) {
    const decision = request.approvals?.[commandId];
    if (decision === undefined)
      throw new Error(`Resume is missing approval: ${commandId}`);
    const frame = state.frames.find((entry) => entry.commandId === commandId);
    if (frame === undefined)
      throw new Error(`Approved Command is absent: ${commandId}`);
    const approved =
      typeof decision === 'boolean' ? decision : decision.approved;
    state.approvals.push({
      commandId,
      command: frame.command,
      inputDigest: frame.inputDigest,
      catalogRevision: request.checkpoint.catalogRevision,
      decision: approved ? 'approved' : 'denied',
      ...(typeof decision === 'object' && decision.reason !== undefined
        ? { reason: decision.reason }
        : {}),
    });
    if (!approved) {
      const denied: CommandRecord = {
        commandRunId: state.commandRunId,
        commandId,
        index: frame.index,
        step: frame.step,
        name: deferredLogicalName(frame.input, frame.command),
        input: frame.input,
        inputDigest: frame.inputDigest,
        status: 'denied',
        approval: {
          status: 'denied',
          ...(typeof decision === 'object' && decision.reason !== undefined
            ? { reason: decision.reason }
            : {}),
        },
        error:
          typeof decision === 'object' && decision.reason !== undefined
            ? decision.reason
            : `Command '${frame.command}' was denied by the user.`,
        completedAt: now(),
      };
      state.results.push(denied);
      resumed.push(denied);
    }
  }
  return resumed;
}

function alreadyApproved(state: RuntimeState, commandId: string): boolean {
  return state.approvals.some(
    (record) =>
      record.commandId === commandId && record.decision === 'approved',
  );
}

function resultFor(state: RuntimeState): CommandRunResult {
  const ordered = [...state.results].sort(
    (left, right) => left.index - right.index,
  );
  return {
    commandRunId: state.commandRunId,
    status:
      state.interruptedBy !== undefined ||
      ordered.some((record) => record.status === 'interrupted')
        ? 'interrupted'
        : ordered.some((record) => record.status === 'failed')
          ? 'failed'
          : ordered.some((record) => record.status === 'denied')
            ? 'denied'
            : 'completed',
    commands: ordered,
  };
}

function compileFailure(
  providerToolCallId: string,
  error: unknown,
): CommandRunTransition {
  const details = compileDetails(error);
  const result: CommandRunResult = {
    commandRunId: `command-run:${providerToolCallId}`,
    status: 'failed',
    commands: [],
    error: details,
  };
  return {
    type: 'completed',
    result,
    observation: projectCommandRunResult(result),
  };
}

async function emitCompileFailure(
  emit: (event: CommandRunEvent) => Promise<void>,
  commandRunId: string,
  providerToolCallId: string,
  transition: CommandRunTransition,
): Promise<void> {
  if (
    transition.type !== 'completed' ||
    transition.result.error === undefined
  ) {
    throw new Error('Compile failure transition is malformed.');
  }
  await emit({
    type: 'command_run.failed',
    commandRunId,
    providerToolCallId,
    error: transition.result.error,
    occurredAt: now(),
  });
}

function shellExitFailure(output: unknown): string | undefined {
  if (typeof output !== 'object' || output === null) return undefined;
  const metadata = Reflect.get(output, 'metadata');
  if (typeof metadata !== 'object' || metadata === null) return undefined;
  const kind = Reflect.get(metadata, 'kind');
  const exitCode = Reflect.get(metadata, 'exitCode');
  return kind === 'shell' && typeof exitCode === 'number' && exitCode !== 0
    ? `Shell exited with code ${exitCode}. Handle an expected nonzero status explicitly in the shell program.`
    : undefined;
}

function commandMetadata(
  output: unknown,
  command: PreparedCommand,
): Record<string, unknown> {
  const metadata =
    typeof output === 'object' &&
    output !== null &&
    typeof Reflect.get(output, 'metadata') === 'object' &&
    Reflect.get(output, 'metadata') !== null
      ? (Reflect.get(output, 'metadata') as Record<string, unknown>)
      : {};
  return {
    ...metadata,
    physicalName: command.resolved.physicalName,
    telemetryTag: command.capabilities.telemetryTag,
  };
}

function deferredLogicalName(input: unknown, command: string): string {
  if (
    command !== 'command_invoke' ||
    typeof input !== 'object' ||
    input === null
  )
    return command;
  const name = Reflect.get(input, 'name');
  return typeof name === 'string' ? name : command;
}

function now(): string {
  return new Date().toISOString();
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
