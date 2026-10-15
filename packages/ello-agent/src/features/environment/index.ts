/**
 * Environment feature 的唯一公开入口。
 *
 * 公开面只包含稳定领域契约与 Local Host adapter。
 */
export {
  createLocalEnvironments,
  LOCAL_HOST_ENVIRONMENT_REFERENCE,
} from './local.js';
export {
  EnvironmentExecutionGate,
  environmentExecutionGateFor,
} from './gate.js';
export type * from './contracts.js';
