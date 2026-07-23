import {
  Archive,
  ChevronDown,
  FolderPlus,
  MessageSquarePlus,
  Search,
  Settings,
  Sparkles,
} from 'lucide-react';
import { useMemo, useState, type ReactNode } from 'react';
import { useNavigate } from 'react-router';

import { CreateWorkspacePopover } from './CreateWorkspacePopover';
import { ThreadRowMenu } from './ThreadRowMenu';

import { Badge } from '@/components/ui/Badge';
import { IconButton } from '@/components/ui/IconButton';
import { StatusDot } from '@/components/ui/StatusDot';
import { Tooltip } from '@/components/ui/Tooltip';
import { openThread, newThreadInContext, threadDisplayName } from '@/features/thread';
import { cn } from '@/lib/cn';
import { runOperation } from '@/lib/report';
import { relativeTime } from '@/lib/time';
import {
  useAppStore,
  useSetRightPanelTab,
  useThreadRows,
  useToggleSection,
  useToggleSidebar,
  useToggleWorkspaceContext,
  useWorkspaceRows,
  type ThreadRow,
  type WorkspaceRow,
} from '@/store/store';
import type { WorkspaceKind } from '@/store/types';


const KIND_CLASS: Record<WorkspaceKind, string> = {
  feature: 'bg-kind-feature',
  fix: 'bg-kind-fix',
  refactor: 'bg-kind-refactor',
  explore: 'bg-kind-explore',
};

const KIND_LABEL: Record<WorkspaceKind, string> = {
  feature: '功能开发',
  fix: '问题修复',
  refactor: '重构',
  explore: '调研',
};

/** 侧栏双区:工作区 / 会话,各自按最近活动倒序。 */
export function WorkspaceSidebar() {
  const collapsed = useAppStore((s) => s.preferences.sidebarCollapsed);
  return collapsed ? <CollapsedRail /> : <ExpandedSidebar />;
}

function CollapsedRail() {
  const navigate = useNavigate();
  const toggleSidebar = useToggleSidebar();
  return (
    <div className="flex h-full w-12 flex-col items-center gap-1 py-2">
      <div className="mb-1 flex h-8 w-8 items-center justify-center rounded-lg bg-fluent text-[15px] font-bold text-on-accent">
        e
      </div>
      <IconButton
        icon={<FolderPlus size={16} />}
        tooltip="展开侧栏"
        tooltipPlacement="right"
        onClick={toggleSidebar}
      />
      <div className="flex-1" />
      <IconButton
        icon={<Sparkles size={16} />}
        tooltip="技能"
        tooltipPlacement="right"
        onClick={() => void navigate('/skills')}
      />
      <IconButton
        icon={<Settings size={16} />}
        tooltip="设置"
        tooltipPlacement="right"
        onClick={() => void navigate('/settings')}
      />
    </div>
  );
}

function ExpandedSidebar() {
  const [query, setQuery] = useState('');
  const [createOpen, setCreateOpen] = useState(false);
  const navigate = useNavigate();
  const workspaceRows = useWorkspaceRows();
  const threadRows = useThreadRows();
  const setRightPanelTab = useSetRightPanelTab();

  const filteredWorkspaces = useMemo(
    () =>
      query === ''
        ? workspaceRows
        : workspaceRows.filter((row) =>
            row.selector.toLowerCase().includes(query.toLowerCase()),
          ),
    [workspaceRows, query],
  );
  const filteredThreads = useMemo(
    () =>
      query === ''
        ? threadRows
        : threadRows.filter((row) =>
            threadDisplayName(row.thread)
              .toLowerCase()
              .includes(query.toLowerCase()),
          ),
    [threadRows, query],
  );

  return (
    <div className="flex h-full flex-col">
      <div className="flex h-11 shrink-0 items-center gap-1.5 px-3">
        <div className="flex h-6 w-6 items-center justify-center rounded-md bg-fluent text-[13px] font-bold text-on-accent">
          e
        </div>
        <span className="text-[15px] font-semibold tracking-tight">ello</span>
        <div className="flex-1" />
        <IconButton
          icon={<Settings size={15} />}
          tooltip="设置"
          onClick={() => void navigate('/settings')}
        />
      </div>

      <div className="shrink-0 px-3 pb-2">
        <CreateWorkspacePopover
          open={createOpen}
          onOpenChange={setCreateOpen}
          trigger={
            <button
              type="button"
              className="flex h-9 w-full cursor-pointer items-center justify-center gap-1.5 rounded-md bg-fluent text-[13px] font-medium text-on-accent shadow-fluent transition-colors duration-150 hover:bg-fluent-hover"
            >
              <FolderPlus size={15} />
              新建任务
            </button>
          }
        />
      </div>

      <div className="shrink-0 px-3 pb-2">
        <div className="flex h-8 items-center gap-2 rounded-md border border-border-subtle bg-surface-1 px-2.5 focus-within:border-card-border-accent">
          <Search size={13} className="shrink-0 text-tertiary" />
          <input
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="搜索工作区或会话…"
            className="h-full w-full bg-transparent text-[12px] text-primary outline-none placeholder:text-disabled"
          />
        </div>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto px-2 pb-2">
        <SidebarSection
          id="workspaces"
          title="工作区"
          count={filteredWorkspaces.length}
        >
          {filteredWorkspaces.map((row) => (
            <WorkspaceRowView key={row.workspace.id} row={row} />
          ))}
          {filteredWorkspaces.length === 0 && (
            <SectionEmpty text={query === '' ? '还没有工作区' : '没有匹配的工作区'} />
          )}
        </SidebarSection>

        <SidebarSection
          id="threads"
          title="会话"
          count={filteredThreads.length}
          action={<NewThreadButton />}
        >
          {filteredThreads.map((row) => (
            <ThreadRowView key={row.thread.id} row={row} />
          ))}
          {filteredThreads.length === 0 && (
            <SectionEmpty text={query === '' ? '还没有会话' : '没有匹配的会话'} />
          )}
        </SidebarSection>
      </div>

      <div className="shrink-0 border-t border-border-subtle p-2">
        <button
          type="button"
          onClick={() => setRightPanelTab('tasks')}
          className="flex h-9 w-full cursor-pointer items-center gap-2 rounded-md px-2 text-[12px] text-secondary transition-colors duration-150 hover:bg-sidebar-hover"
        >
          <Archive size={14} className="text-tertiary" />
          任务板
        </button>
      </div>
    </div>
  );
}

function SidebarSection(props: {
  readonly id: string;
  readonly title: string;
  readonly count: number;
  readonly action?: ReactNode;
  readonly children: ReactNode;
}) {
  const collapsed = useAppStore(
    (s) => s.preferences.collapsedSections[props.id] === true,
  );
  const toggleSection = useToggleSection();
  return (
    <div className="mt-1">
      <div className="group flex h-7 items-center gap-1 px-1">
        <button
          type="button"
          onClick={() => toggleSection(props.id)}
          className="flex flex-1 cursor-pointer items-center gap-1 text-left"
        >
          <ChevronDown
            size={12}
            className={cn(
              'text-tertiary transition-transform duration-200',
              collapsed && '-rotate-90',
            )}
          />
          <span className="text-[11px] font-medium tracking-wide text-tertiary">
            {props.title}
          </span>
          <span className="text-[11px] text-disabled">{props.count}</span>
        </button>
        {props.action}
      </div>
      {!collapsed && <div className="flex flex-col gap-0.5">{props.children}</div>}
    </div>
  );
}

function SectionEmpty(props: { readonly text: string }) {
  return (
    <div className="px-3 py-3 text-[11px] text-disabled">{props.text}</div>
  );
}

function WorkspaceRowView(props: { readonly row: WorkspaceRow }) {
  const { row } = props;
  const toggleWorkspaceContext = useToggleWorkspaceContext();
  const selected = useAppStore(
    (s) => s.view.selectedWorkspaceId === row.workspace.id,
  );
  return (
    <Tooltip content={KIND_LABEL[row.workspace.kind]} placement="right">
      <button
        type="button"
        onClick={() => toggleWorkspaceContext(row.workspace.id)}
        className={cn(
          'relative flex w-full cursor-pointer items-start gap-2.5 rounded-md px-2 py-1.5 text-left',
          'transition-colors duration-150',
          selected ? 'bg-sidebar-active' : 'hover:bg-sidebar-hover',
        )}
      >
        {selected && (
          <span className="absolute top-1.5 bottom-1.5 left-0 w-[2px] rounded-full bg-fluent" />
        )}
        <span
          className={cn(
            'mt-1 h-4 w-4 shrink-0 rounded-[4px]',
            KIND_CLASS[row.workspace.kind],
          )}
        />
        <span className="min-w-0 flex-1">
          <span className="flex items-center gap-1.5">
            <span className="truncate font-mono text-[12px] text-primary">
              {row.selector}
            </span>
            {row.status !== 'idle' && (
              <StatusDot status={row.status} size={7} />
            )}
          </span>
          <span className="mt-0.5 block text-[11px] text-tertiary">
            {row.repoCount} 仓库 · {row.threadCount} 会话 ·{' '}
            {relativeTime(row.activityAt)}
          </span>
        </span>
      </button>
    </Tooltip>
  );
}

function ThreadRowView(props: { readonly row: ThreadRow }) {
  const { row } = props;
  const selected = useAppStore((s) => s.view.selectedThreadId === row.thread.id);
  const status =
    row.thread.status === 'running'
      ? 'running'
      : row.thread.status === 'awaitingApproval' ||
          row.thread.status === 'awaitingUserInput'
        ? 'attention'
        : row.thread.status === 'failed'
          ? 'failed'
          : 'idle';

  return (
    <div
      className={cn(
        'group relative flex w-full items-start gap-2.5 rounded-md px-2 py-1.5',
        'transition-colors duration-150',
        selected ? 'bg-sidebar-active' : 'hover:bg-sidebar-hover',
      )}
    >
      {selected && (
        <span className="absolute top-1.5 bottom-1.5 left-0 w-[2px] rounded-full bg-fluent" />
      )}
      <button
        type="button"
        onClick={() => void runOperation(openThread(row.thread.id))}
        className="flex min-w-0 flex-1 cursor-pointer items-start gap-2.5 text-left"
      >
        <span className="mt-[7px]">
          <StatusDot status={status} size={8} />
        </span>
        <span className="min-w-0 flex-1">
          <span className="flex items-center gap-1.5">
            <span className="truncate text-[13px] text-primary">
              {threadDisplayName(row.thread)}
            </span>
            {row.pendingCount > 0 && (
              <Badge tone="warning">{row.pendingCount}</Badge>
            )}
          </span>
          <span className="mt-0.5 block truncate font-mono text-[11px] text-tertiary">
            {row.workspaceLabel ?? '未关联工作区'}
          </span>
          <span className="mt-0.5 block text-[11px] text-tertiary">
            {relativeTime(row.thread.updatedAt)}
          </span>
        </span>
      </button>
      <div className="absolute top-1 right-1 opacity-0 transition-opacity duration-150 group-hover:opacity-100">
        <ThreadRowMenu thread={row.thread} />
      </div>
    </div>
  );
}

function NewThreadButton() {
  return (
    <Tooltip content="新建会话" placement="bottom">
      <button
        type="button"
        onClick={() => void runOperation(newThreadInContext())}
        className="flex h-5 w-5 cursor-pointer items-center justify-center rounded text-tertiary opacity-0 transition-opacity duration-150 group-hover:opacity-100 hover:bg-surface-3 hover:text-primary"
      >
        <MessageSquarePlus size={13} />
      </button>
    </Tooltip>
  );
}
