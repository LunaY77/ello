import { AgentAdapterError } from '../adapter.js';

export function claudeCodeBaseUrlIssue(baseUrl: string): string | null {
  const pathname = new URL(baseUrl).pathname;
  return /\/v1\/?$/u.test(pathname)
    ? `Claude Code base URL must omit the trailing /v1 because Claude Code appends /v1/messages: ${baseUrl}.`
    : null;
}

export function requireClaudeCodeBaseUrl(baseUrl: string): string {
  const issue = claudeCodeBaseUrlIssue(baseUrl);
  if (issue !== null) throw new AgentAdapterError('agent_setup', issue);
  return baseUrl;
}
