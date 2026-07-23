import { describe, expect, it } from 'vitest';

import {
  aggregateStatus,
  getThreadRows,
  getWorkspaceRows,
  initialState,
} from './store';
import type { AppState, Workspace } from './types';

import { makeSummary } from '@/testing/fixtures';

function makeWorkspace(overrides: Partial<Workspace> = {}): Workspace {
  return {
    id: 'ws-1',
    kind: 'feature',
    name: 'search-page',
    rootPath: '/tmp/ws/search-page',
    status: 'active',
    branch: null,
    repositories: [{}],
    createdAt: '2026-07-22T08:00:00Z',
    updatedAt: '2026-07-22T08:00:00Z',
    ...overrides,
  };
}

describe('aggregateStatus · 聚合优先级', () => {
  it('运行中 > 待审批 > 失败 > 空闲', () => {
    expect(aggregateStatus(['idle', 'awaitingApproval', 'running'])).toBe(
      'running',
    );
    expect(aggregateStatus(['idle', 'awaitingUserInput'])).toBe('attention');
    expect(aggregateStatus(['failed', 'idle'])).toBe('failed');
    expect(aggregateStatus([])).toBe('idle');
  });
});

describe('getWorkspaceRows', () => {
  it('按聚合活动时间倒序,跳过归档工作区', () => {
    const ws1 = makeWorkspace({
      id: 'ws-1',
      updatedAt: '2026-07-20T08:00:00Z',
    });
    const ws2 = makeWorkspace({
      id: 'ws-2',
      name: 'b',
      rootPath: '/tmp/ws/b',
      updatedAt: '2026-07-21T08:00:00Z',
    });
    const wsArchived = makeWorkspace({ id: 'ws-3', status: 'archived' });
    const thread = makeSummary({
      id: 't-1',
      cwd: ws1.rootPath,
      status: 'running',
      updatedAt: '2026-07-22T09:00:00Z',
    });
    const state: AppState = {
      ...initialState,
      entities: {
        ...initialState.entities,
        workspaces: { 'ws-1': ws1, 'ws-2': ws2, 'ws-3': wsArchived },
        threads: { 't-1': thread },
      },
    };
    const rows = getWorkspaceRows(state);
    expect(rows.map((row) => row.workspace.id)).toEqual(['ws-1', 'ws-2']);
    expect(rows[0]?.status).toBe('running');
    expect(rows[0]?.threadCount).toBe(1);
    expect(rows[0]?.activityAt).toBe('2026-07-22T09:00:00Z');
  });
});

describe('getThreadRows', () => {
  it('按 updatedAt 倒序,附带工作区标签与待审批数', () => {
    const ws = makeWorkspace();
    const t1 = makeSummary({
      id: 't-1',
      cwd: ws.rootPath,
      updatedAt: '2026-07-21T08:00:00Z',
    });
    const t2 = makeSummary({
      id: 't-2',
      cwd: '/tmp/chat',
      updatedAt: '2026-07-22T08:00:00Z',
    });
    const archived = makeSummary({ id: 't-3', archived: true });
    const state: AppState = {
      ...initialState,
      entities: {
        ...initialState.entities,
        workspaces: { 'ws-1': ws },
        threads: { 't-1': t1, 't-2': t2, 't-3': archived },
      },
      interaction: {
        pendingRequests: [
          {
            id: 'srvreq_1',
            method: 'item/plan/requestApproval',
            threadId: 't-1',
            turnId: 'turn-1',
            itemId: 'item-1',
            params: {
              threadId: 't-1',
              turnId: 'turn-1',
              itemId: 'item-1',
              reason: '',
              availableDecisions: ['accept'] as const,
              contentHash: 'h',
              preview: '',
            },
            createdAt: '2026-07-22T08:00:00Z',
            state: 'pending',
          },
        ],
      },
    };
    const rows = getThreadRows(state);
    expect(rows.map((row) => row.thread.id)).toEqual(['t-2', 't-1']);
    expect(rows[0]?.workspaceLabel).toBeNull();
    expect(rows[1]?.workspaceLabel).toBe('feature/search-page');
    expect(rows[1]?.pendingCount).toBe(1);
  });
});
