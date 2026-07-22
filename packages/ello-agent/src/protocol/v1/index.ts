/**
 * 本文件负责 Protocol 的公开入口与 factory。
 *
 * 模块不持有可变运行状态；wire 数据以 unknown 进入并由 schema 或显式 parser 收窄。
 * 字段名称、判别值和错误语义属于跨进程协议，调用方不得绕过校验直接构造不完整值。
 */
export * from '../errors.js';
export * from '../json-rpc.js';
export * from '../version.js';
export * from './common.js';
export * from './item-kind.js';
export * from './notifications.js';
export * from './requests.js';
export * from './resources.js';
export * from './responses.js';
export * from './server-requests.js';
