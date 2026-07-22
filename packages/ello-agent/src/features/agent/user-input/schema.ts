/**
 * 本文件负责 agent feature 的运行时 schema 与派生类型。
 *
 * 状态由本模块声明的对象、闭包或 store 显式持有；跨 feature 依赖只能进入对方公开入口。
 * 外部输入在边界完成校验，非法状态和资源失败直接抛出，调用顺序由公开契约约束。
 */
import { z } from 'zod';

const UserInputOptionSchema = z
  .object({
    label: z.string().trim().min(1).max(40),
    description: z.string().trim().min(1).max(160),
  })
  .strict();

const UserInputQuestionSchema = z
  .object({
    id: z.string().regex(/^[a-z][a-z0-9_]{0,63}$/u),
    header: z.string().trim().min(1).max(12),
    question: z.string().trim().min(1).max(240),
    options: z.array(UserInputOptionSchema).min(2).max(4),
    multiSelect: z.boolean(),
  })
  .strict()
  .superRefine((question, context) => {
    const labels = question.options.map((option) => option.label);
    if (new Set(labels).size !== labels.length) {
      context.addIssue({
        code: 'custom',
        path: ['options'],
        message: 'Option labels must be unique within a question.',
      });
    }
    if (labels.some((label) => label.toLowerCase() === 'other')) {
      context.addIssue({
        code: 'custom',
        path: ['options'],
        message:
          "'Other' is reserved for the client-provided free-text option.",
      });
    }
  });

export const UserInputRequestSchema = z
  .object({ questions: z.array(UserInputQuestionSchema).min(1).max(3) })
  .strict()
  .superRefine((request, context) => {
    const ids = request.questions.map((question) => question.id);
    if (new Set(ids).size !== ids.length) {
      context.addIssue({
        code: 'custom',
        path: ['questions'],
        message: 'Question ids must be unique within a request.',
      });
    }
  });

const SubmittedResolutionSchema = z
  .object({
    status: z.literal('submitted'),
    answers: z
      .array(
        z
          .object({
            questionId: z.string().min(1),
            selected: z.array(z.string().min(1)),
            otherText: z.string().trim().min(1).optional(),
          })
          .strict(),
      )
      .min(1),
  })
  .strict();

export const UserInputResolutionSchema = z.discriminatedUnion('status', [
  SubmittedResolutionSchema,
  z
    .object({ status: z.literal('chat'), message: z.string().trim().min(1) })
    .strict(),
  z.object({ status: z.literal('denied') }).strict(),
]);

export type UserInputRequest = z.infer<typeof UserInputRequestSchema>;
export type UserInputResolution = z.infer<typeof UserInputResolutionSchema>;

export interface PendingUserInput {
  readonly toolCallId: string;
  readonly request: UserInputRequest;
}

/**
 * 结合原问题校验提交，未知选项和不完整答案一律作为协议错误。
 *
 * Args:
 * - `request`: 进入 产品 Agent `schema` 模块 的稳定请求；校验后只读传递，不由函数修改。
 * - `value`: 要由 `validateUserInputResolution` 读取或写入的单个领域值；所有权仍归调用方。
 *
 * Returns:
 * - 返回 `validateUserInputResolution` 计算出的声明结果；返回值不包含未声明的兜底状态。
 *
 * Throws:
 * - 当 产品 Agent `schema` 模块 的输入、状态或外部资源不满足契约时直接抛错，并保留底层失败原因。
 */
export function validateUserInputResolution(
  request: UserInputRequest,
  value: unknown,
): UserInputResolution {
  const resolution = UserInputResolutionSchema.parse(value);
  if (resolution.status !== 'submitted') return resolution;
  const answers = new Map<string, (typeof resolution.answers)[number]>();
  for (const answer of resolution.answers) {
    if (answers.has(answer.questionId)) {
      throw new Error(`Duplicate answer for question '${answer.questionId}'.`);
    }
    answers.set(answer.questionId, answer);
  }
  if (answers.size !== request.questions.length) {
    throw new Error(
      'Submitted resolution must answer every question exactly once.',
    );
  }
  for (const question of request.questions) {
    const answer = answers.get(question.id);
    if (answer === undefined) {
      throw new Error(`Missing answer for question '${question.id}'.`);
    }
    if (new Set(answer.selected).size !== answer.selected.length) {
      throw new Error(
        `Question '${question.id}' contains duplicate selections.`,
      );
    }
    const allowed = new Set([
      ...question.options.map((option) => option.label),
      'Other',
    ]);
    const unknown = answer.selected.filter((label) => !allowed.has(label));
    if (unknown.length > 0) {
      throw new Error(
        `Question '${question.id}' contains unknown selections: ${unknown.join(', ')}.`,
      );
    }
    if (
      question.multiSelect
        ? answer.selected.length < 1
        : answer.selected.length !== 1
    ) {
      throw new Error(
        `Question '${question.id}' requires ${question.multiSelect ? 'at least one selection' : 'exactly one selection'}.`,
      );
    }
    const selectedOther = answer.selected.includes('Other');
    if (selectedOther !== (answer.otherText !== undefined)) {
      throw new Error(
        `Question '${question.id}' must provide otherText if and only if Other is selected.`,
      );
    }
  }
  return resolution;
}
