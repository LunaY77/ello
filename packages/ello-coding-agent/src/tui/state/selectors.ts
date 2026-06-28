import type { ProductSnapshot } from '../../product/event-store.js';
import type { ApprovalRequestView, ToolCallView } from '../../product/events.js';

/** Footer 渲染模型。 */
export interface FooterView {
  readonly cwd: string;
  readonly model: string;
  readonly mode: string;
  readonly context: string;
}

/** 从 snapshot 中选择待审批请求。 */
export function selectApprovalDialog(snapshot: ProductSnapshot): ApprovalRequestView | null {
  const event = [...snapshot.approvals].reverse().find((item) => item.type === 'approval.requested');
  return event?.type === 'approval.requested' ? event.request : null;
}

/** 选择 running tools，保持组件输入稳定。 */
export function selectRunningTools(snapshot: ProductSnapshot): ToolCallView[] {
  return snapshot.runningTools;
}

/** 构造 Footer view。 */
export function selectFooter(input: { cwd: string; model: string; mode: string; snapshot: ProductSnapshot }): FooterView {
  const usage = [...input.snapshot.events].reverse().find((event) => event.type === 'usage.updated');
  const context = usage?.type === 'usage.updated' ? `ctx ${(usage.usage.contextPressure ?? 0).toFixed(0)}%` : 'ctx --';
  return { cwd: input.cwd, model: input.model, mode: input.mode, context };
}
