import { renderToString } from 'ink';
import { render } from 'ink-testing-library';
import { describe, expect, it, vi } from 'vitest';

import type { ApprovalServerRequest } from '../../src/api/server-requests.js';
import { OverlayHost } from '../../src/tui/component/OverlayHost.js';
import type { TuiProfile } from '../../src/tui/profile-types.js';
import { overlayCallbacks } from '../support/overlay-fixture.js';

const profile: TuiProfile = {
  id: 'main',
  name: 'main',
  label: 'Main profile',
  description: 'Primary coding profile',
  models: {
    primary: 'mock/primary',
    small: 'mock/small',
    compact: 'mock/compact',
    title: 'mock/title',
    review: 'mock/review',
  },
  raw: {
    label: 'Main profile',
    models: {
      primary: 'mock/primary',
      small: 'mock/small',
      compact: 'mock/compact',
      title: 'mock/title',
      review: 'mock/review',
    },
  },
};

describe('OverlayHost product overlays', () => {
  it('从真实 overlay 入口收集并一次提交全部问题', async () => {
    const onResolveUserInput = vi.fn();
    const request = {
      id: 'srvreq_questions',
      method: 'item/tool/requestUserInput' as const,
      params: {
        threadId: 'thr_questions',
        turnId: 'turn_questions',
        itemId: 'call_questions',
        reason: 'Need user input',
        questions: [
          {
            id: 'project',
            header: 'Project',
            question: 'Which project?',
            multiple: false,
            options: [
              { label: 'Ello', description: 'Work on Ello.' },
              { label: 'Elsewhere', description: 'Work elsewhere.' },
            ],
          },
          {
            id: 'stack',
            header: 'Stack',
            question: 'Which stack?',
            multiple: true,
            options: [
              { label: 'TypeScript', description: 'Use TypeScript.' },
              { label: 'Rust', description: 'Use Rust.' },
            ],
          },
          {
            id: 'milestone',
            header: 'Milestone',
            question: 'What comes next?',
            multiple: false,
            options: [
              { label: 'Ship', description: 'Ship the feature.' },
              { label: 'Polish', description: 'Polish the feature.' },
            ],
          },
        ],
      },
      respond: async () => undefined,
      reject: async () => undefined,
    };
    const view = render(
      <OverlayHost
        {...overlayCallbacks({ onResolveUserInput })}
        overlay={{ type: 'user-input', request }}
      />,
    );

    view.stdin.write('\r');
    await vi.waitFor(() => expect(view.lastFrame()).toContain('2/3 Stack'));
    view.stdin.write(' ');
    await vi.waitFor(() =>
      expect(view.lastFrame()).toContain('[x] TypeScript'),
    );
    view.stdin.write('\r');
    await vi.waitFor(() => expect(view.lastFrame()).toContain('3/3 Milestone'));
    view.stdin.write('\r');
    await vi.waitFor(() => expect(view.lastFrame()).toContain('Review'));
    view.stdin.write('\r');

    await vi.waitFor(() =>
      expect(onResolveUserInput).toHaveBeenCalledWith('srvreq_questions', {
        status: 'submitted',
        answers: [
          { questionId: 'project', selected: ['Ello'] },
          { questionId: 'stack', selected: ['TypeScript'] },
          { questionId: 'milestone', selected: ['Ship'] },
        ],
      }),
    );
    view.unmount();
  });

  it('审批提交期间禁用重复 response', () => {
    const onApprove = vi.fn();
    const request = {
      id: 'srvreq_submitting',
      method: 'item/commandExecution/requestApproval',
      params: {
        threadId: 'thr_1',
        turnId: 'turn_1',
        itemId: 'item_1',
        reason: 'test',
        availableDecisions: ['accept', 'decline'],
        command: ['git', 'status'],
        cwd: '/workspace',
      },
    } as unknown as ApprovalServerRequest;
    const view = render(
      <OverlayHost
        {...overlayCallbacks({ onApprove })}
        overlay={{ type: 'approval', request }}
        resolvingRequestId={request.id}
      />,
    );

    expect(view.lastFrame()).toContain('Submitting decision');
    view.stdin.write('\r');
    expect(onApprove).not.toHaveBeenCalled();
    view.unmount();
  });

  it('Plan 审批分别提交接受、继续讨论和拒绝意图', async () => {
    const request = {
      id: 'srvreq_plan',
      method: 'item/plan/requestApproval',
      params: {
        threadId: 'thr_plan',
        turnId: 'turn_plan',
        itemId: 'item_plan',
        reason: 'approve plan',
        availableDecisions: ['accept', 'decline', 'cancel'],
        contentHash: 'plan-hash',
        preview: '# Plan',
      },
    } as unknown as ApprovalServerRequest;
    const plan = {
      threadId: 'thr_plan',
      status: 'awaitingApproval' as const,
      contentHash: 'plan-hash',
      content: '# Plan\n\n1. Implement it.',
      path: '/workspace/.ello/plans/thr_plan.md',
      updatedAt: '2026-07-19T00:00:00.000Z',
    };

    const onAcceptPlan = vi.fn();
    const submittingView = render(
      <OverlayHost
        {...overlayCallbacks({ onAcceptPlan })}
        overlay={{ type: 'plan-approval', request, plan }}
        resolvingRequestId={request.id}
      />,
    );
    expect(submittingView.lastFrame()).toContain('Submitting decision');
    submittingView.stdin.write('\r');
    expect(onAcceptPlan).not.toHaveBeenCalled();
    submittingView.unmount();

    const acceptView = render(
      <OverlayHost
        {...overlayCallbacks({ onAcceptPlan })}
        overlay={{ type: 'plan-approval', request, plan }}
      />,
    );
    acceptView.stdin.write('\r');
    expect(onAcceptPlan).toHaveBeenCalledWith('srvreq_plan', 'plan-hash');
    acceptView.unmount();

    const onChatAboutPlan = vi.fn();
    const chatView = render(
      <OverlayHost
        {...overlayCallbacks({ onChatAboutPlan })}
        overlay={{ type: 'plan-approval', request, plan }}
      />,
    );
    chatView.stdin.write('\u001b[B');
    await vi.waitFor(() =>
      expect(chatView.lastFrame()).toMatch(/›\s+Chat about this/u),
    );
    chatView.stdin.write('\r');
    await vi.waitFor(() => expect(chatView.lastFrame()).toContain('Chat: _'));
    chatView.stdin.write('Clarify rollback');
    await vi.waitFor(() =>
      expect(chatView.lastFrame()).toContain('Clarify rollback_'),
    );
    chatView.stdin.write('\r');
    await vi.waitFor(() =>
      expect(onChatAboutPlan).toHaveBeenCalledWith(
        'srvreq_plan',
        'Clarify rollback',
      ),
    );
    chatView.unmount();

    const onDenyPlan = vi.fn();
    const denyView = render(
      <OverlayHost
        {...overlayCallbacks({ onDenyPlan })}
        overlay={{ type: 'plan-approval', request, plan }}
      />,
    );
    denyView.stdin.write('\u001b[B');
    await vi.waitFor(() =>
      expect(denyView.lastFrame()).toMatch(/›\s+Chat about this/u),
    );
    denyView.stdin.write('\u001b[B');
    await vi.waitFor(() => expect(denyView.lastFrame()).toMatch(/›\s+Deny/u));
    denyView.stdin.write('\r');
    expect(onDenyPlan).toHaveBeenCalledWith('srvreq_plan');
    denyView.unmount();
  });

  it('profile selector 提供 create/delete/activate 快捷动作', () => {
    const onCreateProfile = vi.fn();
    const onRequestDeleteProfile = vi.fn();
    const onActivateProfile = vi.fn();
    const view = render(
      <OverlayHost
        {...overlayCallbacks({
          onCreateProfile,
          onRequestDeleteProfile,
          onActivateProfile,
        })}
        overlay={{
          type: 'profiles',
          options: [{ value: 'main', label: 'main [active]' }],
        }}
      />,
    );

    view.stdin.write('c');
    view.stdin.write('d');
    view.stdin.write('f');

    expect(onCreateProfile).toHaveBeenCalledWith('main');
    expect(onRequestDeleteProfile).toHaveBeenCalledWith('main');
    expect(onActivateProfile).toHaveBeenCalledWith('main');
    view.unmount();
  });

  it('profile create 和 delete confirm 返回明确配置意图', async () => {
    const onSubmitNewProfile = vi.fn();
    const createView = render(
      <OverlayHost
        {...overlayCallbacks({ onSubmitNewProfile })}
        overlay={{ type: 'profile-create', sourceProfile: 'main' }}
      />,
    );
    createView.stdin.write('reviewer');
    await vi.waitFor(() =>
      expect(createView.lastFrame()).toContain('Name: reviewer_'),
    );
    createView.stdin.write('\r');
    await vi.waitFor(() =>
      expect(onSubmitNewProfile).toHaveBeenCalledWith('reviewer', 'main'),
    );
    createView.unmount();

    const onConfirmDeleteProfile = vi.fn();
    const deleteView = render(
      <OverlayHost
        {...overlayCallbacks({ onConfirmDeleteProfile })}
        overlay={{ type: 'profile-delete-confirm', profile: 'reviewer' }}
      />,
    );
    deleteView.stdin.write('\r');
    expect(onConfirmDeleteProfile).toHaveBeenCalledWith('reviewer');
    deleteView.unmount();
  });

  it('profile role 进入 model catalog，并返回精确 role binding', () => {
    const onSelectProfileRole = vi.fn();
    const detailView = render(
      <OverlayHost
        {...overlayCallbacks({ onSelectProfileRole })}
        overlay={{
          type: 'profile-detail',
          profile,
          options: [{ value: 'primary', label: 'primary mock/primary' }],
        }}
      />,
    );
    detailView.stdin.write('\r');
    expect(onSelectProfileRole).toHaveBeenCalledWith('main', 'primary');
    detailView.unmount();

    const onBindProfileRoleModel = vi.fn();
    const modelView = render(
      <OverlayHost
        {...overlayCallbacks({ onBindProfileRoleModel })}
        overlay={{
          type: 'profile-model-catalog',
          target: { profileName: 'main', role: 'review' },
          options: [{ value: 'mock/new-review', label: 'mock/new-review' }],
        }}
      />,
    );
    modelView.stdin.write('\r');
    expect(onBindProfileRoleModel).toHaveBeenCalledWith(
      'main',
      'review',
      'mock/new-review',
    );
    modelView.unmount();
  });

  it('workspace overlay 使用 Server 返回的 workspace summary', () => {
    const output = renderToString(
      <OverlayHost
        {...overlayCallbacks()}
        overlay={{
          type: 'workspace',
          workspaces: [
            {
              id: 'workspace-1',
              kind: 'refactor',
              name: 'client-server',
              rootPath: '/workspace/refactor/client-server',
              status: 'active',
              branch: 'refactor/client-server',
              repositories: [],
              createdAt: '2026-07-18T00:00:00.000Z',
              updatedAt: '2026-07-18T00:00:00.000Z',
            },
          ],
        }}
      />,
      { columns: 100 },
    );

    expect(output).toContain('Workspaces');
    expect(output).toContain('refactor/client-server');
    expect(output).toContain('/workspace/refactor/client-server');
  });
});
