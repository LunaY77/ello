/** Command Run 深模块的公开入口。 */
export {
  cliInput,
  commandInput,
  defineCommand,
  defineCommandModule,
  deferred,
  immediate,
  structuredInput,
} from './definition.js';
export type * from './definition.js';
export { createCommandRegistrySnapshot } from './catalog.js';
export type { CommandRegistrySnapshot } from './catalog.js';
export { createCommandRunRuntime } from './runtime.js';
export {
  COMMAND_OBSERVATION_MAX_BYTES,
  COMMAND_RUN_RESULT_MAX_BYTES,
  projectCommandRunResult,
} from './result-projector.js';
export {
  CommandFrameSchema,
  CommandRunInputSchema,
  createCommandRunInputSchema,
} from './schema.js';
export type * from './types.js';
