/**
 * `@ello/coding-agent` 的公开会话门面。
 *
 * 直接消费者应依赖此文件，而不是导入 `session/*` 内部实现；
 * 子目录承载 controller、存储装配和实时会话编排等实现层代码。
 */
export {
  CodingAgentController,
  CodingAgentSession,
  createCodingAgentSession,
  listCodingAgentSessions,
  type CodingAgentEvent,
} from './session/index.js';
