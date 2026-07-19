import type { RuntimeRoleModel } from './types.js';

/** 从 role binding 和模型能力派生 AI SDK modelSettings。 */
export function modelSettingsFromRole(
  binding: RuntimeRoleModel,
): Record<string, unknown> {
  const { model, settings } = binding;
  return {
    ...(settings.reasoningEffort !== undefined && model.capabilities.reasoning
      ? { reasoningEffort: settings.reasoningEffort }
      : {}),
    ...(settings.temperature !== undefined && model.capabilities.temperature
      ? { temperature: settings.temperature }
      : {}),
    ...(settings.topP !== undefined ? { topP: settings.topP } : {}),
    ...(settings.topK !== undefined ? { topK: settings.topK } : {}),
  };
}
