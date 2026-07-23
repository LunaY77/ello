/**
 * 根 store:五个 slice 的组合。只有 preferences 的声明字段可持久化;
 * Thread/Workspace snapshot 每次连接都从 Server 读取,不写入 WebView storage。
 */
import type { ThreadStatus, ThreadSummary } from '@ello/agent/protocol';
import { create } from 'zustand';
import { persist } from 'zustand/middleware';

import type {
  AppState,
  PendingRequestEntry,
  RightPanelTab,
  ThemePreference,
  ThreadSnapshot,
  Workspace,
} from './types';

export const initialState: AppState = {
  connection: { phase: 'idle', serverInfo: null, fatalError: null },
  entities: {
    workspaces: {},
    threads: {},
    snapshots: {},
    turnDiffs: {},
    activeFlags: {},
    compactions: {},
    tasks: {},
    repos: [],
    catalogs: { models: [], providers: [], agents: [], tools: [], skills: [] },
    skillsRevision: 0,
    warnings: [],
  },
  interaction: { pendingRequests: [] },
  view: {
    selectedWorkspaceId: null,
    selectedThreadId: null,
    openFilePath: null,
    rightPanel: { tab: 'files', visible: false },
    composerPrefill: null,
  },
  preferences: {
    theme: 'system',
    sidebarCollapsed: false,
    sidebarWidth: 280,
    rightPanelWidth: 360,
    collapsedSections: {},
    enterToSend: true,
    lastChatCwd: null,
  },
};

/** 连接重建时清空全部 Server 投影,但保留 view 选择与 preferences。 */
export function serverProjectionReset(state: AppState): AppState {
  return {
    ...state,
    connection: { phase: 'connecting', serverInfo: null, fatalError: null },
    entities: initialState.entities,
    interaction: initialState.interaction,
  };
}

export const useAppStore = create<AppState>()(
  persist(
    () => initialState,
    {
      name: 'ello-app-preferences',
      partialize: (state) => ({ preferences: state.preferences }),
      merge: (persisted, current) => {
        const stored = persisted as
          | { readonly preferences?: Partial<AppState['preferences']> }
          | undefined;
        return {
          ...current,
          preferences: { ...current.preferences, ...stored?.preferences },
        };
      },
    },
  ),
);

export interface AppMutations {
  readonly selectThread: (threadId: string) => void;
  readonly clearSelectedThread: () => void;
  readonly toggleWorkspaceContext: (workspaceId: string) => void;
  readonly setOpenFile: (path: string | null) => void;
  readonly requestComposerPrefill: (text: string) => void;
  readonly clearComposerPrefill: () => void;
  readonly setRightPanelTab: (tab: RightPanelTab) => void;
  readonly toggleRightPanel: () => void;
  readonly setRightPanelVisible: (visible: boolean) => void;
  readonly setTheme: (theme: ThemePreference) => void;
  readonly toggleSidebar: () => void;
  readonly setSidebarWidth: (width: number) => void;
  readonly setRightPanelWidth: (width: number) => void;
  readonly toggleSection: (section: string) => void;
  readonly setEnterToSend: (enterToSend: boolean) => void;
  readonly setLastChatCwd: (cwd: string) => void;
}

/** 非 React 领域操作直接使用状态修改函数；组件只使用语义明确的 useXXX hook。 */
export const appMutations: AppMutations = {
  selectThread(threadId) {
    useAppStore.setState((state) => {
      const thread = state.entities.threads[threadId];
      if (thread === undefined) {
        throw new Error(`Thread ${threadId} is not loaded.`);
      }
      const workspace = workspaceForCwd(state, thread.cwd);
      return {
        view: {
          ...state.view,
          selectedThreadId: threadId,
          selectedWorkspaceId: workspace === undefined ? null : workspace.id,
        },
      };
    });
  },
  clearSelectedThread() {
    useAppStore.setState((state) => ({
      view: { ...state.view, selectedThreadId: null },
    }));
  },
  toggleWorkspaceContext(workspaceId) {
    useAppStore.setState((state) => ({
      view: {
        ...state.view,
        selectedWorkspaceId:
          state.view.selectedWorkspaceId === workspaceId ? null : workspaceId,
      },
    }));
  },
  setOpenFile(path) {
    useAppStore.setState((state) => ({
      view: { ...state.view, openFilePath: path },
    }));
  },
  requestComposerPrefill(text) {
    useAppStore.setState((state) => ({
      view: {
        ...state.view,
        composerPrefill: { text, nonce: (state.view.composerPrefill?.nonce ?? 0) + 1 },
      },
    }));
  },
  clearComposerPrefill() {
    useAppStore.setState((state) => ({
      view: { ...state.view, composerPrefill: null },
    }));
  },
  setRightPanelTab(tab) {
    useAppStore.setState((state) => ({
      view: { ...state.view, rightPanel: { ...state.view.rightPanel, tab, visible: true } },
    }));
  },
  toggleRightPanel() {
    useAppStore.setState((state) => ({
      view: {
        ...state.view,
        rightPanel: { ...state.view.rightPanel, visible: !state.view.rightPanel.visible },
      },
    }));
  },
  setRightPanelVisible(visible) {
    useAppStore.setState((state) => ({
      view: { ...state.view, rightPanel: { ...state.view.rightPanel, visible } },
    }));
  },
  setTheme(theme) {
    useAppStore.setState((state) => ({ preferences: { ...state.preferences, theme } }));
  },
  toggleSidebar() {
    useAppStore.setState((state) => ({
      preferences: { ...state.preferences, sidebarCollapsed: !state.preferences.sidebarCollapsed },
    }));
  },
  setSidebarWidth(width) {
    useAppStore.setState((state) => ({
      preferences: { ...state.preferences, sidebarWidth: width },
    }));
  },
  setRightPanelWidth(width) {
    useAppStore.setState((state) => ({
      preferences: { ...state.preferences, rightPanelWidth: width },
    }));
  },
  toggleSection(section) {
    useAppStore.setState((state) => ({
      preferences: {
        ...state.preferences,
        collapsedSections: {
          ...state.preferences.collapsedSections,
          [section]: !state.preferences.collapsedSections[section],
        },
      },
    }));
  },
  setEnterToSend(enterToSend) {
    useAppStore.setState((state) => ({
      preferences: { ...state.preferences, enterToSend },
    }));
  },
  setLastChatCwd(cwd) {
    useAppStore.setState((state) => ({
      preferences: { ...state.preferences, lastChatCwd: cwd },
    }));
  },
};

export const useSelectThread = () => appMutations.selectThread;
export const useClearSelectedThread = () => appMutations.clearSelectedThread;
export const useToggleWorkspaceContext = () => appMutations.toggleWorkspaceContext;
export const useSetOpenFile = () => appMutations.setOpenFile;
export const useRequestComposerPrefill = () => appMutations.requestComposerPrefill;
export const useClearComposerPrefill = () => appMutations.clearComposerPrefill;
export const useSetRightPanelTab = () => appMutations.setRightPanelTab;
export const useToggleRightPanel = () => appMutations.toggleRightPanel;
export const useSetRightPanelVisible = () => appMutations.setRightPanelVisible;
export const useSetTheme = () => appMutations.setTheme;
export const useToggleSidebar = () => appMutations.toggleSidebar;
export const useSetSidebarWidth = () => appMutations.setSidebarWidth;
export const useSetRightPanelWidth = () => appMutations.setRightPanelWidth;
export const useToggleSection = () => appMutations.toggleSection;
export const useSetEnterToSend = () => appMutations.setEnterToSend;
export const useSetLastChatCwd = () => appMutations.setLastChatCwd;

export type AggregateStatus = 'running' | 'attention' | 'failed' | 'idle';

export function aggregateStatus(statuses: readonly ThreadStatus[]): AggregateStatus {
  let result: AggregateStatus = 'idle';
  for (const status of statuses) {
    if (status === 'running') return 'running';
    if (status === 'awaitingApproval' || status === 'awaitingUserInput') {
      result = 'attention';
      continue;
    }
    if (status === 'failed' && result === 'idle') result = 'failed';
  }
  return result;
}

export function workspaceLabel(workspace: Workspace): string {
  return `${workspace.kind}/${workspace.name}`;
}

function memoizeByState<R>(derive: (state: AppState) => R): (state: AppState) => R {
  let lastState: AppState | undefined;
  let lastResult: R | undefined;
  return (state) => {
    if (lastState === state) return lastResult as R;
    lastState = state;
    lastResult = derive(state);
    return lastResult;
  };
}

export interface WorkspaceRow {
  readonly workspace: Workspace;
  readonly selector: string;
  readonly status: AggregateStatus;
  readonly threadCount: number;
  readonly activityAt: string;
  readonly repoCount: number;
}

export const getWorkspaceRows = memoizeByState((state): readonly WorkspaceRow[] => {
  return Object.values(state.entities.workspaces)
    .filter((workspace) => workspace.status === 'active')
    .map((workspace) => {
      const threads = Object.values(state.entities.threads).filter(
        (thread) => !thread.archived && thread.cwd === workspace.rootPath,
      );
      return {
        workspace,
        selector: workspaceLabel(workspace),
        status: aggregateStatus(threads.map((thread) => thread.status)),
        threadCount: threads.length,
        activityAt: threads.reduce<string>(
          (latest, thread) => (thread.updatedAt > latest ? thread.updatedAt : latest),
          workspace.updatedAt,
        ),
        repoCount: workspace.repositories.length,
      };
    })
    .sort((a, b) => (a.activityAt < b.activityAt ? 1 : -1));
});

export interface ThreadRow {
  readonly thread: ThreadSummary;
  readonly workspaceLabel: string | null;
  readonly pendingCount: number;
}

export const getThreadRows = memoizeByState((state): readonly ThreadRow[] =>
  Object.values(state.entities.threads)
    .filter((thread) => !thread.archived)
    .sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : -1))
    .map((thread) => ({
      thread,
      workspaceLabel: (() => {
        const workspace = workspaceForCwd(state, thread.cwd);
        return workspace === undefined ? null : workspaceLabel(workspace);
      })(),
      pendingCount: state.interaction.pendingRequests.filter(
        (entry) => entry.threadId === thread.id && entry.state === 'pending',
      ).length,
    })),
);

function getSelectedSnapshot(state: AppState): ThreadSnapshot | undefined {
  const id = state.view.selectedThreadId;
  return id === null ? undefined : state.entities.snapshots[id];
}

function getSelectedThread(state: AppState): ThreadSummary | undefined {
  const id = state.view.selectedThreadId;
  return id === null ? undefined : state.entities.threads[id];
}

function getSelectedWorkspace(state: AppState): Workspace | undefined {
  const id = state.view.selectedWorkspaceId;
  return id === null ? undefined : state.entities.workspaces[id];
}

const getVisiblePendingRequests = memoizeByState(
  (state): readonly PendingRequestEntry[] =>
    state.interaction.pendingRequests.filter(
      (entry) => entry.threadId === state.view.selectedThreadId,
    ),
);

function getContextStatus(state: AppState): AggregateStatus {
  const workspaceId = state.view.selectedWorkspaceId;
  const workspace =
    workspaceId === null ? undefined : state.entities.workspaces[workspaceId];
  if (workspaceId !== null && workspace === undefined) {
    throw new Error(`Selected workspace ${workspaceId} is not loaded.`);
  }
  return aggregateStatus(
    Object.values(state.entities.threads)
      .filter(
        (thread) =>
          !thread.archived &&
          (workspace === undefined || thread.cwd === workspace.rootPath),
      )
      .map((thread) => thread.status),
  );
}

function workspaceForCwd(state: AppState, cwd: string): Workspace | undefined {
  const matches = Object.values(state.entities.workspaces).filter(
    (workspace) => workspace.status === 'active' && workspace.rootPath === cwd,
  );
  if (matches.length > 1) {
    throw new Error(`Multiple active workspaces use root path ${cwd}.`);
  }
  return matches[0];
}

export function useWorkspaceRows(): readonly WorkspaceRow[] {
  return useAppStore(getWorkspaceRows);
}

export function useThreadRows(): readonly ThreadRow[] {
  return useAppStore(getThreadRows);
}

export function useSelectedSnapshot(): ThreadSnapshot | undefined {
  return useAppStore(getSelectedSnapshot);
}

export function useSelectedThread(): ThreadSummary | undefined {
  return useAppStore(getSelectedThread);
}

export function useSelectedWorkspace(): Workspace | undefined {
  return useAppStore(getSelectedWorkspace);
}

export function useVisiblePendingRequests(): readonly PendingRequestEntry[] {
  return useAppStore(getVisiblePendingRequests);
}

export function useContextStatus(): AggregateStatus {
  return useAppStore(getContextStatus);
}
