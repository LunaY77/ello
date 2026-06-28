/**
 * 内核内部能力的进阶入口。
 *
 * 与稳定门面 `./index.js` 不同，这里直接重导出内核内部构件：运行控制与消息队列、
 * 模型输入装配、Agent 主循环、运行会话工厂，以及消息变换原语（裁剪/压缩/
 * tool-call 配对保全）。这些 API 较底层，主要供内核自身、测试与少数高级集成
 * 使用，稳定性弱于公共门面，应优先使用 `./index.js`。
 */
export {
  DefaultAgentMessageQueue,
  AgentRunControl,
} from './core/run-control.js';
export { buildModelInput } from './core/model-input.js';
export { runAgentLoop } from './core/loop.js';
export { createRunSession } from './core/run-session.js';
export {
  trimMessages,
  compactMessages,
  preserveToolCallPairs,
} from './core/input-transforms.js';
