import type { AgentUsage } from '@ello/agent';

export const langfuseAttributes = {
  traceName: 'langfuse.trace.name',
  sessionId: 'session.id',
  observationType: 'langfuse.observation.type',
  observationModel: 'langfuse.observation.model.name',
  observationUsage: 'langfuse.observation.usage_details',
  environment: 'langfuse.environment',
  release: 'langfuse.release',
} as const;

export function usageAttribute(usage: AgentUsage): string {
  return JSON.stringify({
    input: usage.inputTokens,
    output: usage.outputTokens,
    cache_read: usage.cacheReadTokens,
    cache_write: usage.cacheWriteTokens,
  });
}
