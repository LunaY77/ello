import type {
  ApprovalDecision,
  ServerRequestResult,
  UserInputResolution,
} from '@ello/agent/protocol';

import { getServerRequestController } from '@/client/session';
import type { PendingRequestEntry } from '@/store/types';

/** 审批应答:decision 四操作映射到服务端 ApprovalDecision。 */
export async function respondApproval(
  requestId: string,
  decision: ApprovalDecision['decision'],
): Promise<void> {
  await getServerRequestController().respond(requestId, { decision });
}

/** 追问应答:提交答案 / 转为对话 / 拒绝。 */
export async function respondUserInput(
  requestId: string,
  resolution: UserInputResolution,
): Promise<void> {
  await getServerRequestController().respond(
    requestId,
    resolution as ServerRequestResult<'item/tool/requestUserInput'>,
  );
}

const DANGEROUS_PATTERN =
  /(^|\s)(sudo|rm\s+-[a-z]*r[a-z]*f?|mkfs|dd\s+if=)|\|\s*(sudo\s+)?(sh|bash|zsh)\b|curl[^|]*\|\s*(sh|bash)|chmod\s+-R\s+777/i;

/** Server 未显式标记风险时,按命令文本识别高危操作。 */
export function isDangerousCommand(command: readonly string[]): boolean {
  return DANGEROUS_PATTERN.test(command.join(' '));
}

export function availableDecision(
  entry: PendingRequestEntry,
  decision: ApprovalDecision['decision'],
): boolean {
  if (!('availableDecisions' in entry.params)) return false;
  return (entry.params.availableDecisions as readonly string[]).includes(decision);
}
