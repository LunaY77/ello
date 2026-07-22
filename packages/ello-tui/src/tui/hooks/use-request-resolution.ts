import { useRef, useState } from 'react';

import type {
  ApprovalDecision,
  UserInputResolution,
} from '../../api/protocol-types.js';
import type { ThreadClient } from '../../client/thread-client.js';

import type { useRuntimeEvents } from './use-runtime-events.js';

type Dispatch = ReturnType<typeof useRuntimeEvents>['dispatch'];

/** Server Request 以 requestId 去重，重复按键不会发送第二次审批结果。 */
export function useRequestResolution(input: {
  readonly thread: ThreadClient;
  readonly dispatch: Dispatch;
  onError(error: unknown): void;
  submitPrompt(prompt: string): Promise<void>;
}) {
  const resolvingRequests = useRef(new Set<string>());
  const [resolvingRequestId, setResolvingRequestId] = useState<string>();

  const begin = (requestId: string): boolean => {
    if (resolvingRequests.current.has(requestId)) return false;
    resolvingRequests.current.add(requestId);
    setResolvingRequestId(requestId);
    return true;
  };
  const finish = (requestId: string): void => {
    resolvingRequests.current.delete(requestId);
    setResolvingRequestId((current) =>
      current === requestId ? undefined : current,
    );
  };
  const approve = (requestId: string, decision: ApprovalDecision): void => {
    if (!begin(requestId)) return;
    void input.thread
      .approve(requestId, decision.decision)
      .then(() => input.dispatch({ type: 'interaction.resolved', requestId }))
      .catch(input.onError)
      .finally(() => finish(requestId));
  };
  const resolveUserInput = (
    requestId: string,
    resolution: UserInputResolution,
  ): void => {
    if (!begin(requestId)) return;
    void input.thread
      .resolveUserInput(requestId, resolution)
      .then(() =>
        input.dispatch({ type: 'interaction.resolved', requestId, resolution }),
      )
      .catch(input.onError)
      .finally(() => finish(requestId));
  };
  const chatAboutPlan = (requestId: string, prompt: string): void => {
    if (!begin(requestId)) return;
    void input.thread
      .approve(requestId, 'decline')
      .then(() => input.submitPrompt(prompt))
      .catch(input.onError)
      .finally(() => finish(requestId));
  };

  return {
    resolvingRequestId,
    onApprove: approve,
    onResolveUserInput: resolveUserInput,
    onAcceptPlan: (requestId: string) =>
      approve(requestId, { decision: 'accept' }),
    onDenyPlan: (requestId: string) =>
      approve(requestId, { decision: 'decline' }),
    onChatAboutPlan: chatAboutPlan,
  };
}
