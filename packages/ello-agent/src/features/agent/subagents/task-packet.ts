/**
 * Primary 交给 Subagent 的自包含任务包。
 *
 * Task Packet 是唯一的委派输入；Subagent 不读取 Primary 的对话、工具调用或运行历史。
 */
import { z } from 'zod';

export const AgentTaskPacketSchema = z
  .object({
    objective: z.string().trim().min(1).describe('The concrete objective.'),
    scope: z
      .string()
      .trim()
      .min(1)
      .describe('Owned files, modules, or boundaries.'),
    knownFacts: z
      .array(z.string().trim().min(1))
      .max(64)
      .describe('Facts already established by the Primary Agent.'),
    constraints: z
      .array(z.string().trim().min(1))
      .max(64)
      .describe('Constraints the Subagent must preserve.'),
    expectedOutcome: z
      .string()
      .trim()
      .min(1)
      .describe('The expected deliverable.'),
    acceptanceEvidence: z
      .array(z.string().trim().min(1))
      .min(1)
      .max(64)
      .describe('Evidence required before reporting completion.'),
  })
  .strict();

export type AgentTaskPacket = z.infer<typeof AgentTaskPacketSchema>;

/** 渲染给 Subagent 的任务输入；内容不依赖 Primary 历史。 */
export function renderTaskPacket(packet: AgentTaskPacket): string {
  return [
    '# Task Packet',
    '',
    '## Objective',
    packet.objective,
    '',
    '## Owned Scope',
    packet.scope,
    '',
    '## Known Facts',
    ...packet.knownFacts.map((fact) => `- ${fact}`),
    '',
    '## Constraints',
    ...packet.constraints.map((constraint) => `- ${constraint}`),
    '',
    '## Expected Outcome',
    packet.expectedOutcome,
    '',
    '## Acceptance Evidence',
    ...packet.acceptanceEvidence.map((evidence) => `- ${evidence}`),
  ].join('\n');
}
