/**
 * 本文件锁定 item-kind 的纯类型边界。
 *
 * 声明只参与 TypeScript 编译，不创建运行期状态；正反例必须让公开契约的可赋值方向保持明确。
 * 新增联合成员或字段时，类型检查应直接暴露未同步的调用方。
 */
import { isToolItem, itemKind, type ToolThreadItem } from './item-kind.js';
import type { ThreadItem } from './resources.js';

// 分类 helper 必须保留 ThreadItem 联合的收窄能力。
declare const item: ThreadItem;

if (isToolItem(item)) {
  item satisfies ToolThreadItem;
  item.type satisfies 'commandExecution' | 'fileChange' | 'toolCall';
}

const kind = itemKind(item);
kind satisfies 'message' | 'tool' | 'subagent' | 'system';
