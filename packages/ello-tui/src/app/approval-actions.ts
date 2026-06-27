import type { CodingAgentController } from '@ello/coding-agent';

import type { TuiState } from '../state/index.js';

/**
 * 基于当前待审批状态构建审批回调。
 */
export function createApprovalActions(options: {
  controller: CodingAgentController;
  state: TuiState;
}) {
  return {
    approve: () => {
      if (options.state.pendingApproval) {
        void options.controller.approveToolCall(options.state.pendingApproval.toolCallId, 'approve');
      }
    },
    reject: () => {
      if (options.state.pendingApproval) {
        void options.controller.rejectToolCall(options.state.pendingApproval.toolCallId);
      }
    },
    edit: (value: string) => {
      if (options.state.pendingApproval) {
        void options.controller.editToolCall(options.state.pendingApproval.toolCallId, value);
      }
    },
  };
}
