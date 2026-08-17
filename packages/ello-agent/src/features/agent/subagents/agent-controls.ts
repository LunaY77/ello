/** Primary-only model-facing Agent Command names. */
export const AGENT_CONTROL_COMMAND_NAMES = [
  'spawn_agent',
  'list_agents',
  'get_agent',
  'wait_agent',
  'stop_agent',
] as const;

export const SUBAGENT_FORBIDDEN_COMMAND_NAMES = [
  ...AGENT_CONTROL_COMMAND_NAMES,
  'request_user_input',
] as const;
