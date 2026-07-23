/**
 * Store 全部 slice 的状态类型。Server state 只由完整 RPC result 或有序
 * notification 写入;UI state 可本地修改,但不能反向伪造 Server 实体字段。
 */
import type {
  ClientResult,
  PendingServerRequest,
  ServerRequestMethod,
  ServerRequestParams,
  ThreadSnapshot,
  ThreadSummary,
} from '@ello/agent/protocol';

export type Workspace = ClientResult<'workspace/read'>['workspace'];
export type Repository = ClientResult<'repo/list'>['data'][number];
export type Task = ClientResult<'task/get'>['task'];
export type CatalogEntry = ClientResult<'skills/list'>['data'][number];
export type ConfigSetting = ClientResult<'config/settings'>['data'][number];
export type ServerInfo = ClientResult<'initialize'>['serverInfo'];
export type WorkspaceKind = Workspace['kind'];

export type CatalogKind = 'models' | 'providers' | 'agents' | 'tools' | 'skills';

export interface PendingRequestEntry {
  readonly id: string;
  readonly method: ServerRequestMethod;
  readonly threadId: string;
  readonly turnId: string;
  readonly itemId: string;
  readonly params: ServerRequestParams<ServerRequestMethod>;
  readonly createdAt: string;
  readonly state: 'pending' | 'responding';
}

export type ConnectionPhase =
  | 'idle'
  | 'connecting'
  | 'handshake'
  | 'ready'
  | 'fatal';

export interface ConnectionState {
  readonly phase: ConnectionPhase;
  readonly serverInfo: ServerInfo | null;
  readonly fatalError: string | null;
}

export interface CompactionInfo {
  readonly summary: string;
  readonly tokensBefore: number;
  readonly atSeq: number;
}

export interface WarningNotice {
  readonly code: string;
  readonly message: string;
  readonly at: number;
}

export interface EntitiesState {
  readonly workspaces: Readonly<Record<string, Workspace>>;
  readonly threads: Readonly<Record<string, ThreadSummary>>;
  /** 已加载(subscribe)的 Thread 完整快照;未加载的 Thread 只有 summary。 */
  readonly snapshots: Readonly<Record<string, ThreadSnapshot>>;
  /** turnId → 最近一次 turn/diff/updated 的变更集。 */
  readonly turnDiffs: Readonly<Record<string, readonly import('@ello/agent/protocol').FileChange[]>>;
  readonly activeFlags: Readonly<Record<string, readonly string[]>>;
  readonly compactions: Readonly<Record<string, CompactionInfo>>;
  readonly tasks: Readonly<Record<string, Task>>;
  /** 仓库注册表(repo/list),创建工作区时勾选。 */
  readonly repos: readonly Repository[];
  readonly catalogs: Readonly<Record<CatalogKind, readonly CatalogEntry[]>>;
  /** skills/changed 到达时递增,驱动 skills 页重载。 */
  readonly skillsRevision: number;
  readonly warnings: readonly WarningNotice[];
}

export interface InteractionState {
  /** composer 上方常驻审批/追问队列,按到达顺序排列。 */
  readonly pendingRequests: readonly PendingRequestEntry[];
}

export type RightPanelTab = 'files' | 'changes' | 'tasks';

export interface WorkspaceViewState {
  /** null = 全部上下文(未选中工作区)。 */
  readonly selectedWorkspaceId: string | null;
  readonly selectedThreadId: string | null;
  /** 文件面板中当前打开的文件(workspace 相对路径)。 */
  readonly openFilePath: string | null;
  readonly rightPanel: {
    readonly tab: RightPanelTab;
    readonly visible: boolean;
  };
  /** 引导卡等入口向 composer 投递的预填文本;nonce 保证重复文本也能触发。 */
  readonly composerPrefill: { readonly text: string; readonly nonce: number } | null;
}

export type ThemePreference = 'light' | 'dark' | 'system';

/** 唯一允许持久化的 slice;新增字段必须加入 persist 白名单。 */
export interface PreferencesState {
  readonly theme: ThemePreference;
  readonly sidebarCollapsed: boolean;
  readonly sidebarWidth: number;
  readonly rightPanelWidth: number;
  readonly collapsedSections: Readonly<Record<string, boolean>>;
  readonly enterToSend: boolean;
  readonly lastChatCwd: string | null;
}

export interface AppState {
  readonly connection: ConnectionState;
  readonly entities: EntitiesState;
  readonly interaction: InteractionState;
  readonly view: WorkspaceViewState;
  readonly preferences: PreferencesState;
}

export type { PendingServerRequest, ThreadSnapshot, ThreadSummary };
