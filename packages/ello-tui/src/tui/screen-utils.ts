import type { Plan, ThreadSnapshot } from '../api/protocol-types.js';
import type { ClientServerRequest } from '../api/server-requests.js';

import type { OverlayState } from './component/OverlayHost.js';

/** pending Server Request 始终覆盖手动 overlay，避免审批被普通面板遮挡。 */
export function overlayForRequest(
  request: ClientServerRequest | undefined,
  plan: Plan | null,
): OverlayState | undefined {
  if (request === undefined) return undefined;
  if (request.method === 'item/tool/requestUserInput') {
    return { type: 'user-input', request };
  }
  if (request.method === 'item/plan/requestApproval' && plan !== null) {
    return { type: 'plan-approval', request, plan };
  }
  return { type: 'approval', request };
}

export function isDisposableThread(snapshot: ThreadSnapshot): boolean {
  return (
    snapshot.thread.name.trim() === '' &&
    snapshot.thread.preview.trim() === '' &&
    snapshot.turns.length === 0
  );
}

export function isResumableThread(thread: {
  readonly name: string;
  readonly preview: string;
}): boolean {
  return thread.name.trim() !== '' || thread.preview.trim() !== '';
}

export function isShiftTab(
  input: string,
  key: { readonly tab?: boolean; readonly shift?: boolean },
): boolean {
  return input === '\u001b[Z' || (key.tab === true && key.shift === true);
}
