/**
 * Subagent 的结构化终态结果契约。
 *
 * 模型最终文本必须包含 `<agent-result>...</agent-result>` JSON envelope；运行时失败和停止
 * 也使用同一组状态，Primary 因而无需猜测报告语义。
 */
import { z } from 'zod';

const EvidenceListSchema = z.array(z.string().trim().min(1)).max(128);

/**
 * 证据类列表字段一律容错。
 *
 * 这些字段只是报告的补充维度；模型偶尔漏掉一个空列表不足以否定整份已完成的工作，
 * 因此缺失或类型不符时归一化为空列表，而不是把整个结果判为 failed 并丢弃 evidence。
 */
const OptionalEvidenceListSchema = EvidenceListSchema.optional()
  .default([])
  .catch([]);

export const AgentTaskResultSchema = z.discriminatedUnion('status', [
  z
    .object({
      status: z.literal('completed'),
      summary: z.string().trim().min(1),
      evidence: OptionalEvidenceListSchema,
      remainingRisks: OptionalEvidenceListSchema,
    })
    .strict(),
  z
    .object({
      status: z.literal('failed'),
      summary: z.string().trim().min(1),
      error: z.string().trim().min(1),
      evidence: OptionalEvidenceListSchema,
      retryable: z.boolean().optional().default(false).catch(false),
    })
    .strict(),
  z
    .object({
      status: z.literal('blocked'),
      summary: z.string().trim().min(1),
      blockingReason: z.string().trim().min(1),
      questionForUser: z.string().trim().min(1),
      completedWork: OptionalEvidenceListSchema,
      evidence: OptionalEvidenceListSchema,
    })
    .strict(),
  z
    .object({
      status: z.literal('stopped'),
      summary: z.string().trim().min(1),
      reason: z.string().trim().min(1),
      partialWork: OptionalEvidenceListSchema,
      evidence: OptionalEvidenceListSchema,
    })
    .strict(),
]);

export type AgentTaskResult = z.infer<typeof AgentTaskResultSchema>;
export type AgentTaskTerminalStatus = AgentTaskResult['status'];

/** 从模型最终文本提取并校验唯一结果 envelope。 */
export function parseAgentTaskResult(output: string): AgentTaskResult {
  const match = /^\s*<agent-result>\s*([\s\S]*?)\s*<\/agent-result>\s*$/u.exec(
    output,
  );
  if (match?.[1] === undefined) {
    throw new Error(
      'Subagent final response is missing the <agent-result> JSON envelope.',
    );
  }
  const value = parseResultJson(match[1]);
  return AgentTaskResultSchema.parse(value);
}

/**
 * 在结果无法通过 Result schema 时挽救已经成立的报告内容。
 *
 * 校验失败只说明 envelope 不完整，不代表 Subagent 没有产出证据；整体丢弃 evidence 会让
 * Primary 重做一遍已完成的工作。本函数尽最大努力从合法 JSON 中取回 summary 与 evidence。
 *
 * Args:
 * - `output`: Subagent 的最终文本，可能带 envelope、markdown fence 或缺字段。
 *
 * Returns:
 * - 能取回 summary 或 evidence 时返回归一化片段；完全无法解析时返回 `undefined`。
 */
export function salvageAgentTaskResult(output: string):
  | {
      readonly summary?: string;
      readonly evidence: string[];
    }
  | undefined {
  const match = /<agent-result>\s*([\s\S]*?)\s*<\/agent-result>/u.exec(output);
  const body = match?.[1] ?? output;
  let value: unknown;
  try {
    value = parseResultJson(body);
  } catch {
    return undefined;
  }
  if (typeof value !== 'object' || value === null) return undefined;
  const record = value as Record<string, unknown>;
  const summary = evidenceText(record.summary);
  const evidence = [
    ...evidenceList(record.evidence),
    ...evidenceList(record.completedWork),
    ...evidenceList(record.partialWork),
    ...evidenceList(record.remainingRisks).map((risk) => `Risk: ${risk}`),
  ].slice(0, 128);
  if (summary === undefined && evidence.length === 0) return undefined;
  return { ...(summary === undefined ? {} : { summary }), evidence };
}

function evidenceText(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed === '' ? undefined : trimmed;
}

function evidenceList(value: unknown): readonly string[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((entry) => {
    const text = evidenceText(entry);
    return text === undefined ? [] : [text];
  });
}

/**
 * Provider 输出偶尔会把 JSON 字符串中的换行作为原始控制字符返回，或包一层 markdown fence。
 * 先执行严格解析；只有失败后才尝试这两类可判定修复，最终仍由严格 Result schema 验证。
 */
function parseResultJson(body: string): unknown {
  const unfenced = stripCodeFence(body.trim());
  const repaired = repairCommonJsonFormatting(unfenced);
  const candidates = [...new Set([body, unfenced, repaired])];
  let lastError: unknown;
  for (const candidate of candidates) {
    try {
      return JSON.parse(candidate) as unknown;
    } catch (error) {
      lastError = error;
    }
  }
  throw new Error('Subagent <agent-result> is not valid JSON.', {
    cause: lastError,
  });
}

function stripCodeFence(value: string): string {
  const match = /^```(?:json)?\s*([\s\S]*?)\s*```$/iu.exec(value);
  return match?.[1] ?? value;
}

function repairCommonJsonFormatting(value: string): string {
  let inString = false;
  let escaped = false;
  let repaired = '';
  for (const character of value) {
    if (escaped) {
      repaired += character;
      escaped = false;
      continue;
    }
    if (character === '\\' && inString) {
      repaired += character;
      escaped = true;
      continue;
    }
    if (character === '"') {
      inString = !inString;
      repaired += character;
      continue;
    }
    if (inString && character === '\n') repaired += '\\n';
    else if (inString && character === '\r') repaired += '\\r';
    else if (inString && character === '\t') repaired += '\\t';
    else repaired += character;
  }
  return repaired.replace(/,\s*([}\]])/gu, '$1');
}

/** 给通知、列表和日志使用的短结果摘要。 */
export function taskResultSummary(result: AgentTaskResult): string {
  switch (result.status) {
    case 'completed':
      return result.summary;
    case 'failed':
      return `${result.summary}: ${result.error}`;
    case 'blocked':
      return `${result.summary}: ${result.questionForUser}`;
    case 'stopped':
      return `${result.summary}: ${result.reason}`;
  }
}
