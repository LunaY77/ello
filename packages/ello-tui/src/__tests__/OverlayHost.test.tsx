import { renderToString } from 'ink';
import { render } from 'ink-testing-library';
import { describe, expect, it, vi } from 'vitest';

import type { ApprovalServerRequest } from '../api/server-requests.js';
import { OverlayHost } from '../tui/component/OverlayHost.js';
import type { TuiProfile } from '../tui/profile-types.js';

import { overlayCallbacks } from './overlay-fixture.js';

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
