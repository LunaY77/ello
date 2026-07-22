/**
 * 本文件锁定 messages 的纯类型边界。
 *
 * 声明只参与 TypeScript 编译，不创建运行期状态；正反例必须让公开契约的可赋值方向保持明确。
 * 新增联合成员或字段时，类型检查应直接暴露未同步的调用方。
 */
import { createAgentMessage } from './messages.js';
import type { AgentMessage } from './model.js';

// 工厂返回值必须持续满足公开 AgentMessage 契约。
const message = createAgentMessage({ role: 'user', content: 'hello' });
message satisfies AgentMessage;
