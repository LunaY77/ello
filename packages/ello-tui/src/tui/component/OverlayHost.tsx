import { Box, Text, useInput } from 'ink';
import type { ReactNode } from 'react';
import { useState } from 'react';

import type {
  AgentCatalogEntry,
  AgentSkill,
  ApprovalDecision,
  CatalogEntry,
  Plan,
  Task,
  ThreadSummary,
  UserInputResolution,
  WorkspaceSummary,
} from '../../api/protocol-types.js';
import type {
  ApprovalServerRequest,
  ClientServerRequest,
} from '../../api/server-requests.js';
import type { ProfileRole, TuiProfile } from '../profile-types.js';
import type { SettingUpdate, TuiSetting } from '../settings/types.js';
import { buildPermissionView } from '../store/permission-view.js';
import { useTheme } from '../theme/index.js';
import { InlineSelect, type SelectOption } from '../ui/List.js';

import { SettingsPanel } from './SettingsPanel.js';
import { UserInputPanel } from './UserInputPanel.js';

export type OverlayState =
  | { readonly type: 'none' }
  | { readonly type: 'approval'; readonly request: ApprovalServerRequest }
  | { readonly type: 'user-input'; readonly request: UserInputRequest }
  | { readonly type: 'plan-preview'; readonly plan: Plan }
  | {
      readonly type: 'plan-approval';
      readonly request: ApprovalServerRequest;
      readonly plan: Plan;
    }
  | {
      readonly type: 'models';
      readonly title: string;
      readonly options: readonly SelectOption[];
    }
  | { readonly type: 'profiles'; readonly options: readonly SelectOption[] }
  | { readonly type: 'profile-create'; readonly sourceProfile: string }
  | { readonly type: 'profile-delete-confirm'; readonly profile: string }
  | {
      readonly type: 'profile-detail';
      readonly profile: TuiProfile;
      readonly options: readonly SelectOption[];
    }
  | {
      readonly type: 'profile-model-catalog';
      readonly target: {
        readonly profileName: string;
        readonly role: ProfileRole;
      };
      readonly options: readonly SelectOption[];
    }
  | { readonly type: 'help' }
  | { readonly type: 'settings'; readonly settings: readonly TuiSetting[] }
  | { readonly type: 'agents'; readonly agents: readonly AgentCatalogEntry[] }
  | { readonly type: 'skills'; readonly skills: readonly AgentSkill[] }
  | { readonly type: 'tasks'; readonly tasks: readonly Task[] }
  | {
      readonly type: 'workspace';
      readonly workspaces: readonly WorkspaceSummary[];
    }
  | {
      readonly type: 'session-selector';
      readonly sessions: readonly ThreadSummary[];
    }
  | {
      readonly type: 'rewind-selector';
      readonly targets: readonly RewindTarget[];
    };

type UserInputRequest = Extract<
  ClientServerRequest,
  { readonly method: 'item/tool/requestUserInput' }
>;

export interface RewindTarget {
  readonly entryId: string;
  readonly turnId: string;
  readonly index: number;
  readonly text: string;
}

export interface OverlayHostProps {
  readonly overlay: OverlayState;
  readonly marginTop?: number;
  readonly resolvingRequestId?: string;
  onApprove(requestId: string, decision: ApprovalDecision): void;
  onResolveUserInput(requestId: string, resolution: UserInputResolution): void;
  onAcceptPlan(requestId: string, contentHash: string): void;
  onChatAboutPlan(requestId: string, prompt: string): void;
  onDenyPlan(requestId: string): void;
  onClosePlanPreview(): void;
  onSelectModel(model: string): void;
  onSelectProfile(profile: string): void;
  onCreateProfile(sourceProfile: string): void;
  onRequestDeleteProfile(profile: string): void;
  onConfirmDeleteProfile(profile: string): void;
  onActivateProfile(profile: string): void;
  onSubmitNewProfile(name: string, sourceProfile: string): void;
  onSelectProfileRole(profile: string, role: ProfileRole): void;
  onBindProfileRoleModel(
    profile: string,
    role: ProfileRole,
    model: string,
  ): void;
  onOpenProfiles(): void;
  onSaveProfile(profile: string): void;
  onSelectSession(threadId: string): void;
  onSelectRewind(entryId: string): void;
  onUpdateSetting(update: SettingUpdate): Promise<void>;
}

/**
 * 所有浮层只显示 Server 返回的协议资源；决定通过回调返回 App，再由
 * ThreadClient 发送 typed RPC。浮层本身不读取配置、不执行工具。
 */
export function OverlayHost({
  overlay,
  marginTop = 1,
  resolvingRequestId,
  onApprove,
  onResolveUserInput,
  onAcceptPlan,
  onChatAboutPlan,
  onDenyPlan,
  onClosePlanPreview,
  onSelectModel,
  onSelectProfile,
  onCreateProfile,
  onRequestDeleteProfile,
  onConfirmDeleteProfile,
  onActivateProfile,
  onSubmitNewProfile,
  onSelectProfileRole,
  onBindProfileRoleModel,
  onSelectSession,
  onSelectRewind,
  onUpdateSetting,
  onOpenProfiles,
  onSaveProfile,
}: OverlayHostProps) {
  const theme = useTheme();
  useInput(
    (input) => {
      if (overlay.type === 'profile-detail' && input === 's') {
        onSaveProfile(overlay.profile.name);
      }
    },
    { isActive: overlay.type === 'profile-detail' },
  );
  if (overlay.type === 'none') return null;
  return (
    <Box flexDirection="column" marginTop={marginTop}>
      {overlay.type === 'approval' ? (
        <ApprovalPanel
          request={overlay.request}
          submitting={resolvingRequestId === overlay.request.id}
          onApprove={onApprove}
        />
      ) : null}
      {overlay.type === 'user-input' ? (
        <UserInputPanel
          pending={overlay.request}
          onResolve={(resolution) =>
            onResolveUserInput(overlay.request.id, resolution)
          }
        />
      ) : null}
      {overlay.type === 'plan-preview' ? (
        <Panel title="Plan preview" color={theme.info}>
          <Text color={theme.textMuted}>{overlay.plan.path}</Text>
          <Text wrap="wrap">{overlay.plan.content}</Text>
          <InlineSelect
            options={[{ label: 'Close', value: 'close' }]}
            onChange={onClosePlanPreview}
          />
        </Panel>
      ) : null}
      {overlay.type === 'plan-approval' ? (
        <PlanApprovalPanel
          request={overlay.request}
          plan={overlay.plan}
          submitting={resolvingRequestId === overlay.request.id}
          onAccept={onAcceptPlan}
          onChat={onChatAboutPlan}
          onDeny={onDenyPlan}
        />
      ) : null}
      {overlay.type === 'models' ? (
        <Panel title={overlay.title} color={theme.info}>
          <InlineSelect options={overlay.options} onChange={onSelectModel} />
        </Panel>
      ) : null}
      {overlay.type === 'profiles' ? (
        <Panel title="Profiles" color={theme.info}>
          <InlineSelect
            options={overlay.options}
            onChange={onSelectProfile}
            onShortcut={(input, profile) => {
              if (input === 'c') onCreateProfile(profile);
              else if (input === 'd') onRequestDeleteProfile(profile);
              else if (input === 'f') onActivateProfile(profile);
            }}
          />
          <Text color={theme.textMuted}>
            Enter: open c: create d: delete f: active
          </Text>
        </Panel>
      ) : null}
      {overlay.type === 'profile-create' ? (
        <ProfileCreatePanel
          sourceProfile={overlay.sourceProfile}
          onSubmit={onSubmitNewProfile}
        />
      ) : null}
      {overlay.type === 'profile-delete-confirm' ? (
        <Panel title="Delete profile" color={theme.error}>
          <Text>{`Profile: ${overlay.profile}`}</Text>
          <InlineSelect
            options={[
              { value: 'delete', label: 'Delete' },
              { value: 'cancel', label: 'Cancel' },
            ]}
            onChange={(value) => {
              if (value === 'delete') onConfirmDeleteProfile(overlay.profile);
              else onOpenProfiles();
            }}
          />
        </Panel>
      ) : null}
      {overlay.type === 'profile-detail' ? (
        <Panel title={`Profile: ${overlay.profile.name}`} color={theme.info}>
          <Text>{`Label: ${overlay.profile.label ?? overlay.profile.name}`}</Text>
          <Text color={theme.textMuted}>
            {overlay.profile.description ?? ''}
          </Text>
          <Text color={theme.textMuted}>Role Model</Text>
          <InlineSelect
            options={overlay.options}
            onChange={(role) =>
              onSelectProfileRole(overlay.profile.name, role as ProfileRole)
            }
          />
          <Text color={theme.textMuted}>
            Enter: change model s: save Esc: back
          </Text>
        </Panel>
      ) : null}
      {overlay.type === 'profile-model-catalog' ? (
        <Panel
          title={`Select ${overlay.target.role} model for ${overlay.target.profileName}`}
          color={theme.info}
        >
          <InlineSelect
            options={overlay.options}
            onChange={(model) =>
              onBindProfileRoleModel(
                overlay.target.profileName,
                overlay.target.role,
                model,
              )
            }
          />
        </Panel>
      ) : null}
      {overlay.type === 'help' ? <HelpPanel /> : null}
      {overlay.type === 'settings' ? (
        <SettingsPanel settings={overlay.settings} onUpdate={onUpdateSetting} />
      ) : null}
      {overlay.type === 'agents' ? (
        <CatalogPanel title="Subagents" entries={overlay.agents} />
      ) : null}
      {overlay.type === 'skills' ? (
        <CatalogPanel title="Skills" entries={overlay.skills} />
      ) : null}
      {overlay.type === 'tasks' ? <TaskPanel tasks={overlay.tasks} /> : null}
      {overlay.type === 'workspace' ? (
        <CatalogPanel
          title="Workspaces"
          entries={overlay.workspaces.map(workspaceEntry)}
        />
      ) : null}
      {overlay.type === 'session-selector' ? (
        <Panel title="Resume thread" color={theme.info}>
          <InlineSelect
            label="threads"
            visibleRows={6}
            options={
              overlay.sessions.length === 0
                ? [{ value: '', label: 'No threads found', disabled: true }]
                : overlay.sessions.map((session) => ({
                    value: session.id,
                    label: renderThreadLabel(session),
                  }))
            }
            onChange={(value) => {
              if (value !== '') onSelectSession(value);
            }}
          />
        </Panel>
      ) : null}
      {overlay.type === 'rewind-selector' ? (
        <Panel title="Rewind target" color={theme.info}>
          <InlineSelect
            label="rewind target"
            visibleRows={6}
            options={
              overlay.targets.length === 0
                ? [
                    {
                      value: '',
                      label: 'No rewindable user entries',
                      disabled: true,
                    },
                  ]
                : overlay.targets.map((target) => ({
                    value: target.entryId,
                    label: `${target.entryId.slice(0, 8)} ${target.index}: ${clip(target.text, 58)}`,
                  }))
            }
            onChange={(value) => {
              if (value !== '') onSelectRewind(value);
            }}
          />
        </Panel>
      ) : null}
    </Box>
  );
}

function ApprovalPanel({
  request,
  submitting,
  onApprove,
}: {
  readonly request: ApprovalServerRequest;
  readonly submitting: boolean;
  readonly onApprove: OverlayHostProps['onApprove'];
}) {
  const theme = useTheme();
  const view = buildPermissionView({
    toolName: request.method,
    input: request.params,
    metadata: request.params as Record<string, unknown>,
  });
  const options = request.params.availableDecisions.map((decision) => ({
    value: decision,
    label: approvalLabel(decision),
  }));
  return (
    <Panel title={`Approve ${view.title}`} color={theme.warning}>
      {view.fields.map((field) => (
        <Text
          key={`${field.label}:${field.value}`}
          color={theme.textMuted}
        >{`${field.label}: ${field.value}`}</Text>
      ))}
      {view.diffSummary !== undefined ? (
        <Text
          color={theme.textMuted}
        >{`diff: +${view.diffSummary.added} -${view.diffSummary.removed}`}</Text>
      ) : null}
      {view.risk !== undefined ? (
        <Text color={theme.warning}>{view.risk}</Text>
      ) : null}
      <InlineSelect
        isActive={!submitting}
        options={options}
        onChange={(value) =>
          onApprove(request.id, {
            decision: value as ApprovalDecision['decision'],
          })
        }
      />
      {submitting ? (
        <Text color={theme.textMuted}>Submitting decision…</Text>
      ) : null}
    </Panel>
  );
}

function PlanApprovalPanel({
  request,
  plan,
  submitting,
  onAccept,
  onChat,
  onDeny,
}: {
  readonly request: ApprovalServerRequest;
  readonly plan: Plan;
  readonly submitting: boolean;
  readonly onAccept: OverlayHostProps['onAcceptPlan'];
  readonly onChat: OverlayHostProps['onChatAboutPlan'];
  readonly onDeny: OverlayHostProps['onDenyPlan'];
}) {
  const theme = useTheme();
  const [chatting, setChatting] = useState(false);
  const [prompt, setPrompt] = useState('');
  useInput(
    (input, key) => {
      if (!chatting) return;
      if (key.return && prompt.trim() !== '') {
        onChat(request.id, prompt.trim());
        setPrompt('');
        return;
      }
      if (key.backspace || key.delete) {
        setPrompt((value) => value.slice(0, -1));
        return;
      }
      if (!key.ctrl && !key.meta && input.length > 0)
        setPrompt((value) => value + input);
    },
    { isActive: chatting && !submitting },
  );
  return (
    <Panel title="Plan ready for approval" color={theme.warning}>
      <Text color={theme.textMuted}>{plan.path}</Text>
      <Text wrap="wrap">{plan.content}</Text>
      {submitting ? (
        <Text color={theme.textMuted}>Submitting decision…</Text>
      ) : chatting ? (
        <Text color={theme.accent}>{`Chat: ${prompt}_`}</Text>
      ) : (
        <InlineSelect
          options={[
            { value: 'accept', label: 'Accept' },
            { value: 'chat', label: 'Chat about this' },
            { value: 'deny', label: 'Deny' },
          ]}
          onChange={(value) => {
            if (value === 'accept') onAccept(request.id, plan.contentHash);
            else if (value === 'chat') setChatting(true);
            else onDeny(request.id);
          }}
        />
      )}
    </Panel>
  );
}

function ProfileCreatePanel({
  sourceProfile,
  onSubmit,
}: {
  readonly sourceProfile: string;
  readonly onSubmit: OverlayHostProps['onSubmitNewProfile'];
}) {
  const theme = useTheme();
  const [name, setName] = useState('');
  useInput((input, key) => {
    if (key.return && name.trim() !== '') {
      onSubmit(name.trim(), sourceProfile);
      return;
    }
    if (key.backspace || key.delete) {
      setName((value) => value.slice(0, -1));
      return;
    }
    if (!key.ctrl && !key.meta && input.length > 0) {
      setName((value) => value + input);
    }
  });
  return (
    <Panel title="Create profile" color={theme.info}>
      <Text color={theme.textMuted}>{`Copy from ${sourceProfile}`}</Text>
      <Text>{`Name: ${name}_`}</Text>
    </Panel>
  );
}

function Panel({
  title,
  color,
  children,
}: {
  readonly title: string;
  readonly color: string;
  readonly children: ReactNode;
}) {
  return (
    <Box
      flexDirection="column"
      borderStyle="round"
      borderColor={color}
      paddingX={1}
    >
      <Text color={color}>{title}</Text>
      {children}
    </Box>
  );
}

function HelpPanel() {
  const theme = useTheme();
  return (
    <Panel title="Commands" color={theme.accent}>
      <Text wrap="wrap">
        /help /mode /models /profiles /settings /resume /fork /tasks /skills
        /goal /compact /quit
      </Text>
      <Text color={theme.textMuted}>
        @path sends a file reference through fs/search; !cmd runs
        thread/shellCommand; Esc closes or interrupts.
      </Text>
    </Panel>
  );
}

function CatalogPanel({
  title,
  entries,
}: {
  readonly title: string;
  readonly entries: readonly CatalogEntry[];
}) {
  const theme = useTheme();
  return (
    <Panel title={title} color={theme.info}>
      {entries.length === 0 ? (
        <Text
          color={theme.textMuted}
        >{`${title.toLowerCase()} &lt;none&gt;`}</Text>
      ) : (
        entries.slice(0, 12).map((entry) => (
          <Text key={`${title}:${entry.id ?? entry.name}`}>
            <Text color={theme.textMuted}>{entry.name.padEnd(18)}</Text>
            <Text>{clip(entry.description ?? entry.title ?? '', 62)}</Text>
          </Text>
        ))
      )}
    </Panel>
  );
}

function TaskPanel({ tasks }: { readonly tasks: readonly Task[] }) {
  const theme = useTheme();
  return (
    <Panel title="Tasks" color={theme.success}>
      {tasks.length === 0 ? (
        <Text color={theme.textMuted}>tasks &lt;none&gt;</Text>
      ) : (
        tasks.slice(0, 12).map((task) => (
          <Text key={task.id}>
            <Text color={theme.textMuted}>{task.status.padEnd(12)}</Text>
            <Text>{clip(task.subject, 68)}</Text>
          </Text>
        ))
      )}
    </Panel>
  );
}

function approvalLabel(value: string): string {
  switch (value) {
    case 'acceptForSession':
      return 'Allow for this thread';
    case 'decline':
      return 'Deny';
    case 'cancel':
      return 'Cancel';
    default:
      return 'Allow once';
  }
}

function renderThreadLabel(thread: ThreadSummary): string {
  const title =
    thread.name.trim() || thread.preview.trim() || 'Untitled session';
  const timestamp = formatThreadTimestamp(thread.createdAt);
  return `${timestamp}  ${clip(title, 58)}`;
}

function formatThreadTimestamp(value: string): string {
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return 'invalid-date';
  const parts = new Intl.DateTimeFormat('en-CA', {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).formatToParts(date);
  const read = (type: Intl.DateTimeFormatPartTypes) =>
    parts.find((part) => part.type === type)?.value ?? '';
  return `${read('year')}-${read('month')}-${read('day')} ${read('hour')}:${read('minute')}`;
}

function workspaceEntry(workspace: WorkspaceSummary): CatalogEntry {
  return {
    id: workspace.id,
    name: `${workspace.kind}/${workspace.name}`,
    title: workspace.status,
    description: workspace.rootPath,
    enabled: true,
    metadata: {},
  };
}

function clip(value: string, max: number): string {
  const text = value.replace(/\s+/gu, ' ').trim();
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

export type AnyServerRequest = ClientServerRequest;
