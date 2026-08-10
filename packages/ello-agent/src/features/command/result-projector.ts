/**
 * Command Run 的模型结果投影。
 *
 * CommandRecord 是 durable audit/event 使用的完整事实，不能直接作为 provider
 * observation。这个 seam 只负责把事实投影成稳定、可重放且有界的模型观察结果。
 */
import type {
  CommandRunResult,
  CommandRecord,
  JsonValue,
  ModelCommandRecord,
  ModelCommandRunResult,
} from './types.js';

export const COMMAND_OBSERVATION_MAX_BYTES = 12_000;
export const COMMAND_RUN_RESULT_MAX_BYTES = 65_536;

type ProjectedApproval = {
  status: NonNullable<ModelCommandRecord['approval']>['status'];
  reason?: string;
};

type ProjectedCommand = Omit<
  ModelCommandRecord,
  'output' | 'error' | 'approval'
> & {
  output?: JsonValue;
  error?: string;
  approval?: ProjectedApproval;
};

type ProjectedRunError = {
  frameIndex?: number;
  command?: string;
  message: string;
  usage?: string;
};

type ProjectedRunResult = Omit<ModelCommandRunResult, 'commands' | 'error'> & {
  commands: ProjectedCommand[];
  error?: ProjectedRunError;
};

/**
 * 把完整 Command 事实投影为 provider-visible observation。
 *
 * 每个 command 保留最小身份和状态；成功输出先按 12 KiB 处理，再按整个
 * command_run 的 64 KiB 上限公平收缩。失败、拒绝和阻断信息不会被成功输出挤掉。
 */
export function projectCommandRunResult(
  result: CommandRunResult,
): ModelCommandRunResult {
  const commands = [...result.commands]
    .sort((left, right) => left.index - right.index)
    .map((record) => projectCommandRecord(record));
  const projected: ProjectedRunResult = {
    commandRunId: result.commandRunId,
    status: result.status,
    commands,
    ...(result.error === undefined
      ? {}
      : { error: projectError(result.error) }),
  };

  shrinkResult(projected, commands);
  return projected;
}

function projectCommandRecord(record: CommandRecord): ProjectedCommand {
  const output =
    record.output === undefined
      ? undefined
      : projectValue(record.output, COMMAND_OBSERVATION_MAX_BYTES);
  const projected: ProjectedCommand = {
    commandId: record.commandId,
    index: record.index,
    step: record.step,
    name: record.name,
    status: record.status,
    ...(output === undefined ? {} : { output }),
    ...(record.error === undefined
      ? {}
      : { error: boundText(record.error, COMMAND_OBSERVATION_MAX_BYTES) }),
    ...(record.blockedBy === undefined ? {} : { blockedBy: record.blockedBy }),
    ...(record.approval === undefined
      ? {}
      : {
          approval: {
            status: record.approval.status,
            ...(record.approval.reason === undefined
              ? {}
              : {
                  reason: boundText(
                    record.approval.reason,
                    COMMAND_OBSERVATION_MAX_BYTES,
                  ),
                }),
          },
        }),
  };
  fitCommandRecord(projected);
  return projected;
}

function projectError(error: NonNullable<ModelCommandRunResult['error']>) {
  return {
    ...(error.frameIndex === undefined ? {} : { frameIndex: error.frameIndex }),
    ...(error.command === undefined ? {} : { command: error.command }),
    message: boundText(error.message, COMMAND_OBSERVATION_MAX_BYTES),
    ...(error.usage === undefined
      ? {}
      : { usage: boundText(error.usage, COMMAND_OBSERVATION_MAX_BYTES) }),
  };
}

function projectValue(value: unknown, budget: number): JsonValue {
  const native = projectNativeCommandResult(value, budget);
  if (native !== undefined) return native;
  if (typeof value === 'string') return boundText(value, budget);
  const json = safeJson(value);
  if (json === undefined) return '[non-serializable command output]';
  if (byteLength(json) <= budget) return toJsonValue(value);

  // 原生结果和已投影结果都把模型所需文本放在 `output`。
  if (typeof value === 'object' && value !== null) {
    const text = Reflect.get(value, 'output');
    if (typeof text === 'string') {
      return {
        output: boundText(text, Math.max(256, budget - 128)),
        truncated: true,
        byteLength: byteLength(text),
        ...artifactProjection(value),
      };
    }
  }
  return {
    preview: boundText(json, Math.max(256, budget - 64)),
    truncated: true,
    byteLength: byteLength(json),
  };
}

function projectNativeCommandResult(
  value: unknown,
  budget: number,
): JsonValue | undefined {
  if (
    typeof value !== 'object' ||
    value === null ||
    Reflect.get(value, 'kind') !== 'command-result'
  ) {
    return undefined;
  }
  const output = Reflect.get(value, 'output');
  if (typeof output !== 'string') return undefined;
  const artifact = artifactProjection(value);
  const attachments = attachmentProjection(value);
  const metadata = Reflect.get(value, 'metadata');
  const explicitlyTruncated =
    typeof metadata === 'object' &&
    metadata !== null &&
    Reflect.get(metadata, 'truncated') === true;
  return {
    output: boundText(output, Math.max(256, budget - 256)),
    ...(explicitlyTruncated || artifact.artifact !== undefined
      ? { truncated: true }
      : {}),
    ...artifact,
    ...(attachments.length === 0 ? {} : { attachments }),
  };
}

function attachmentProjection(value: object): JsonValue[] {
  const attachments = Reflect.get(value, 'attachments');
  if (!Array.isArray(attachments)) return [];
  return attachments.slice(0, 32).flatMap((attachment) => {
    if (typeof attachment !== 'object' || attachment === null) return [];
    const type = Reflect.get(attachment, 'type');
    const mime = Reflect.get(attachment, 'mime');
    if (typeof type !== 'string' || typeof mime !== 'string') return [];
    const name = Reflect.get(attachment, 'name');
    const bytes = Reflect.get(attachment, 'bytes');
    const path = Reflect.get(attachment, 'path');
    return [
      {
        type,
        mime,
        ...(typeof name === 'string' ? { name } : {}),
        ...(typeof bytes === 'number' && Number.isFinite(bytes)
          ? { bytes }
          : {}),
        ...(typeof path === 'string' && path !== '' ? { path } : {}),
      },
    ];
  });
}

function artifactProjection(value: unknown): {
  readonly artifact?: { readonly path: string };
} {
  if (typeof value !== 'object' || value === null) return {};
  const existing = Reflect.get(value, 'artifact');
  if (typeof existing === 'object' && existing !== null) {
    const path = Reflect.get(existing, 'path');
    if (typeof path === 'string' && path !== '') return { artifact: { path } };
  }
  const metadata = Reflect.get(value, 'metadata');
  if (typeof metadata !== 'object' || metadata === null) return {};
  const path = Reflect.get(metadata, 'outputPath');
  return typeof path === 'string' && path !== '' ? { artifact: { path } } : {};
}

function shrinkResult(
  result: ProjectedRunResult,
  commands: ProjectedCommand[],
): void {
  if (serializedBytes(result) <= COMMAND_RUN_RESULT_MAX_BYTES) return;

  // 公平收缩所有可变详情，但完整保留每条失败、拒绝和阻断回执。
  let target = Math.floor(COMMAND_OBSERVATION_MAX_BYTES / 2);
  while (
    serializedBytes(result) > COMMAND_RUN_RESULT_MAX_BYTES &&
    target >= 256
  ) {
    for (const command of commands) shrinkCommandDetails(command, target);
    shrinkRunError(result.error, target);
    target = Math.floor(target / 2);
  }

  // 最终回退只移除大 payload，仍保留错误头尾和 Command identity。
  if (serializedBytes(result) > COMMAND_RUN_RESULT_MAX_BYTES) {
    for (const command of commands) {
      if (command.output !== undefined) {
        const bytes = serializedBytes(command.output);
        command.output = {
          truncated: true,
          byteLength: bytes,
          ...artifactProjection(command.output),
        };
      }
      if (command.error !== undefined) {
        command.error = boundText(command.error, 128);
      }
      if (command.approval?.reason !== undefined) {
        command.approval.reason = boundText(command.approval.reason, 128);
      }
    }
    shrinkRunError(result.error, 128);
  }

  if (serializedBytes(result) > COMMAND_RUN_RESULT_MAX_BYTES) {
    throw new Error(
      `Command Run result cannot fit the ${COMMAND_RUN_RESULT_MAX_BYTES}-byte observation budget while preserving command receipts.`,
    );
  }
}

function fitCommandRecord(command: ProjectedCommand): void {
  if (serializedBytes(command) <= COMMAND_OBSERVATION_MAX_BYTES) return;

  let target = Math.floor(COMMAND_OBSERVATION_MAX_BYTES / 2);
  while (
    serializedBytes(command) > COMMAND_OBSERVATION_MAX_BYTES &&
    target >= 256
  ) {
    shrinkCommandDetails(command, target);
    target = Math.floor(target / 2);
  }

  if (serializedBytes(command) > COMMAND_OBSERVATION_MAX_BYTES) {
    if (command.output !== undefined) {
      command.output = {
        truncated: true,
        byteLength: serializedBytes(command.output),
        ...artifactProjection(command.output),
      };
    }
    if (command.error !== undefined) {
      command.error = boundText(command.error, 128);
    }
    if (command.approval?.reason !== undefined) {
      command.approval.reason = boundText(command.approval.reason, 128);
    }
  }

  if (serializedBytes(command) > COMMAND_OBSERVATION_MAX_BYTES) {
    throw new Error(
      `Command observation cannot fit the ${COMMAND_OBSERVATION_MAX_BYTES}-byte budget while preserving its receipt.`,
    );
  }
}

function shrinkCommandDetails(command: ProjectedCommand, target: number): void {
  if (command.output !== undefined) {
    command.output = projectValue(command.output, target);
  }
  if (command.error !== undefined) {
    command.error = boundText(command.error, target);
  }
  if (command.approval?.reason !== undefined) {
    command.approval.reason = boundText(command.approval.reason, target);
  }
}

function shrinkRunError(
  error: ProjectedRunError | undefined,
  target: number,
): void {
  if (error === undefined) return;
  error.message = boundText(error.message, target);
  if (error.usage !== undefined) error.usage = boundText(error.usage, target);
}

function boundText(value: string, budget: number): string {
  if (byteLength(value) <= budget) return value;
  const marker = '\n...[output truncated]...\n';
  const markerBytes = byteLength(marker);
  if (budget <= markerBytes) return sliceUtf8(value, budget);
  const head = Math.ceil((budget - markerBytes) / 2);
  const tail = Math.floor((budget - markerBytes) / 2);
  return `${sliceUtf8(value, head)}${marker}${sliceUtf8FromEnd(value, tail)}`;
}

function sliceUtf8(value: string, maxBytes: number): string {
  const bytes = Buffer.from(value, 'utf8');
  if (bytes.length <= maxBytes) return value;
  let end = Math.max(0, maxBytes);
  while (end > 0 && isUtf8ContinuationByte(bytes[end])) end -= 1;
  return bytes.subarray(0, end).toString('utf8');
}

function sliceUtf8FromEnd(value: string, maxBytes: number): string {
  const bytes = Buffer.from(value, 'utf8');
  if (bytes.length <= maxBytes) return value;
  let start = Math.max(0, bytes.length - maxBytes);
  while (start < bytes.length && isUtf8ContinuationByte(bytes[start])) {
    start += 1;
  }
  return bytes.subarray(start).toString('utf8');
}

function isUtf8ContinuationByte(value: number | undefined): boolean {
  return value !== undefined && (value & 0xc0) === 0x80;
}

function safeJson(value: unknown): string | undefined {
  try {
    return JSON.stringify(value);
  } catch {
    return undefined;
  }
}

function toJsonValue(value: unknown): JsonValue {
  const serialized = safeJson(value);
  if (serialized === undefined) return '[non-serializable command output]';
  return JSON.parse(serialized) as JsonValue;
}

function byteLength(value: string): number {
  return Buffer.byteLength(value, 'utf8');
}

function serializedBytes(value: unknown): number {
  const serialized = safeJson(value);
  return serialized === undefined
    ? COMMAND_RUN_RESULT_MAX_BYTES + 1
    : byteLength(serialized);
}
