import type { AgentSkill } from '@ello/agent';
import { Box, Text, useInput } from 'ink';
import TextInput from 'ink-text-input';
import type { ReactNode } from 'react';
import { useState } from 'react';

import type { CodingAgentDefinition } from '../../agents/index.js';
import type { CodingAgentConfig } from '../../config/index.js';
import type { ModelRole, RuntimeProfileSuite } from '../../provider/index.js';
import type { ApprovalDecision } from '../../runtime/intents.js';
import type { JsonlSessionSummary } from '../../session/repository.js';
import type { Task } from '../../tasks/index.js';
import type { WorkspaceManifest } from '../../workspace/index.js';
import type { ApprovalView } from '../store/history-entry.js';
import {
  buildPermissionView,
  PROJECT_RULES_FILE,
} from '../store/permission-view.js';
import {
  listThemes,
  useTheme,
  type TuiTheme,
  type ThemeName,
} from '../theme/index.js';
import { InlineSelect, type SelectOption } from '../ui/List.js';

/**
 * 浮层状态。
 *
 * 审批浮层由运行态 pending approval 驱动；其它浮层由 slash command 或
 * Settings 页面显式打开。
 */
export type OverlayState =
  | { readonly type: 'none' }
  | { readonly type: 'approval'; readonly request: ApprovalView }
  | {
      readonly type: 'models';
      readonly title: string;
      readonly options: readonly SelectOption[];
    }
  | {
      readonly type: 'profiles';
      readonly options: readonly SelectOption[];
    }
  | {
      readonly type: 'profile-create';
      readonly sourceProfile: string;
    }
  | {
      readonly type: 'profile-delete-confirm';
      readonly profile: string;
    }
  | {
      readonly type: 'profile-detail';
      readonly profile: RuntimeProfileSuite;
      readonly options: readonly SelectOption[];
    }
  | {
      readonly type: 'profile-model-catalog';
      readonly target: {
        readonly profileName: string;
        readonly role: ModelRole;
      };
      readonly options: readonly SelectOption[];
    }
  | { readonly type: 'help' }
  | { readonly type: 'settings'; readonly config: CodingAgentConfig }
  | { readonly type: 'theme'; readonly active: ThemeName }
  | {
      readonly type: 'agents';
      readonly agents: readonly CodingAgentDefinition[];
    }
  | { readonly type: 'skills'; readonly skills: readonly AgentSkill[] }
  | { readonly type: 'tasks'; readonly tasks: readonly Task[] }
  | {
      readonly type: 'workspace';
      readonly workspaces: readonly WorkspaceManifest[];
    }
  | {
      readonly type: 'session-selector';
      readonly sessions: readonly JsonlSessionSummary[];
    }
  | {
      readonly type: 'rewind-selector';
      readonly targets: readonly RewindTarget[];
    };

export interface RewindTarget {
  readonly entryId: string;
  readonly index: number;
  readonly text: string;
}

/** 审批浮层四个选项 → 决定。 */
const APPROVAL_OPTIONS = [
  { label: 'Allow once', value: 'once' },
  { label: 'Always allow (session)', value: 'session' },
  { label: 'Always allow (project)', value: 'project' },
  { label: 'Always allow (user)', value: 'user' },
  { label: 'Deny', value: 'deny' },
];

export interface OverlayHostProps {
  readonly overlay: OverlayState;
  readonly marginTop?: number;
  /** 审批选择回调：把 UI 选项翻译成 {@link ApprovalDecision} 交回 App。 */
  onApprove(requestId: string, decision: ApprovalDecision): void;
  /** 模型选择回调。 */
  onSelectModel(model: string): void;
  /** profile suite 选择回调。 */
  onSelectProfile(profile: string): void;
  /** profile suite 列表快捷动作。 */
  onCreateProfile(sourceProfile: string): void;
  onRequestDeleteProfile(profile: string): void;
  onConfirmDeleteProfile(profile: string): void;
  onActivateProfile(profile: string): void;
  onSubmitNewProfile(name: string, sourceProfile: string): void;
  /** profile detail 中的 role 选择回调。 */
  onSelectProfileRole(profile: string, role: ModelRole): void;
  /** profile role 模型绑定回调。 */
  onBindProfileRoleModel(profile: string, role: ModelRole, model: string): void;
  /** 打开 profiles 管理页。 */
  onOpenProfiles(): void;
  /** 保存当前 profile suite。 */
  onSaveProfile(profile: string): void;
  /** session 选择回调。 */
  onSelectSession(sessionId: string): void;
  /** rewind target 选择回调。 */
  onSelectRewind(entryId: string): void;
  onSelectTheme(theme: ThemeName): void;
}

/**
 * 单层浮层 host。
 *
 * 审批选择结果直接翻译成 `ApprovalDecision` 交给 `session.approve`
 * （在 App 里），TUI 本身不判权限。
 */
export function OverlayHost({
  overlay,
  marginTop = 1,
  onApprove,
  onSelectModel,
  onSelectProfile,
  onCreateProfile,
  onRequestDeleteProfile,
  onConfirmDeleteProfile,
  onActivateProfile,
  onSubmitNewProfile,
  onSelectProfileRole,
  onBindProfileRoleModel,
  onOpenProfiles,
  onSaveProfile,
  onSelectSession,
  onSelectRewind,
  onSelectTheme,
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
  if (overlay.type === 'none') {
    return null;
  }
  return (
    <Box flexDirection="column" marginTop={marginTop}>
      {overlay.type === 'approval' ? (
        <Box
          flexDirection="column"
          borderStyle="round"
          borderColor={theme.warning}
          paddingX={1}
        >
          <Text
            color={theme.warning}
          >{`Approve ${overlay.request.toolName}?`}</Text>
          <ApprovalRequestPreview request={overlay.request} />
          <InlineSelect
            options={APPROVAL_OPTIONS}
            onChange={(value) =>
              onApprove(overlay.request.requestId, toDecision(value))
            }
          />
        </Box>
      ) : null}
      {overlay.type === 'models' ? (
        <Box
          flexDirection="column"
          borderStyle="round"
          borderColor={theme.info}
          paddingX={1}
        >
          <Text color={theme.accent}>{overlay.title}</Text>
          <Text color={theme.textMuted}>Model catalog</Text>
          <InlineSelect options={overlay.options} onChange={onSelectModel} />
          <Text color={theme.textMuted}>Enter: select Esc: cancel</Text>
        </Box>
      ) : null}
      {overlay.type === 'profiles' ? (
        <Box
          flexDirection="column"
          borderStyle="round"
          borderColor={theme.info}
          paddingX={1}
        >
          <Text color={theme.accent}>Settings / Profiles</Text>
          <InlineSelect
            options={overlay.options}
            onChange={onSelectProfile}
            onShortcut={(input, profile) => {
              if (input === 'c') {
                onCreateProfile(profile);
              } else if (input === 'd') {
                onRequestDeleteProfile(profile);
              } else if (input === 'f') {
                onActivateProfile(profile);
              }
            }}
          />
          <Text color={theme.textMuted}>
            Enter: open profile c: create d: delete f: active Esc: close
          </Text>
        </Box>
      ) : null}
      {overlay.type === 'profile-create' ? (
        <ProfileCreatePanel
          sourceProfile={overlay.sourceProfile}
          onSubmit={onSubmitNewProfile}
        />
      ) : null}
      {overlay.type === 'profile-delete-confirm' ? (
        <Box
          flexDirection="column"
          borderStyle="round"
          borderColor={theme.error}
          paddingX={1}
        >
          <Text color={theme.error}>Delete profile</Text>
          <Text color={theme.text}>{`Profile: ${overlay.profile}`}</Text>
          <InlineSelect
            options={[
              { value: 'delete', label: 'Delete' },
              { value: 'cancel', label: 'Cancel' },
            ]}
            onChange={(value) => {
              if (value === 'delete') {
                onConfirmDeleteProfile(overlay.profile);
              } else {
                onOpenProfiles();
              }
            }}
          />
          <Text color={theme.textMuted}>Enter: confirm Esc: cancel</Text>
        </Box>
      ) : null}
      {overlay.type === 'profile-detail' ? (
        <Box
          flexDirection="column"
          borderStyle="round"
          borderColor={theme.info}
          paddingX={1}
        >
          <Text color={theme.accent}>{`Profile: ${overlay.profile.name}`}</Text>
          <Text color={theme.text}>
            {`Label: ${overlay.profile.label ?? overlay.profile.name}`}
          </Text>
          <Text color={theme.text} wrap="wrap">
            {`Description: ${overlay.profile.description ?? ''}`}
          </Text>
          <Box marginTop={1} flexDirection="column">
            <Text color={theme.textMuted}>Role bindings</Text>
            <Text color={theme.textMuted}>Role Model Context Output</Text>
            <InlineSelect
              options={overlay.options}
              onChange={(role) =>
                onSelectProfileRole(overlay.profile.name, role as ModelRole)
              }
            />
          </Box>
          <Text color={theme.textMuted}>
            Enter: change model s: save Esc: back
          </Text>
        </Box>
      ) : null}
      {overlay.type === 'profile-model-catalog' ? (
        <Box
          flexDirection="column"
          borderStyle="round"
          borderColor={theme.info}
          paddingX={1}
        >
          <Text color={theme.accent}>
            {`Select model for profile.${overlay.target.profileName}.models.${overlay.target.role}`}
          </Text>
          <Text color={theme.textMuted}>Model catalog</Text>
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
          <Text color={theme.textMuted}>Enter: bind Esc: cancel</Text>
        </Box>
      ) : null}
      {overlay.type === 'help' ? (
        <Box
          flexDirection="column"
          borderStyle="round"
          borderColor={theme.border}
          paddingX={1}
        >
          <Text color={theme.accent}>Commands</Text>
          <Text color={theme.text} wrap="wrap">
            /help /agents /models /profiles /new /tools /permissions /memory
            /quit
          </Text>
          <Text color={theme.textMuted}>
            @path attaches files · !cmd runs shell · Esc closes or interrupts
          </Text>
        </Box>
      ) : null}
      {overlay.type === 'theme' ? (
        <Panel title="Theme" color={theme.accent}>
          <InlineSelect
            options={listThemes().map((item) => ({
              value: item.name,
              label: `${item.name}${item.name === overlay.active ? ' [active]' : ''}  ${item.appearance}`,
            }))}
            onChange={(value) => onSelectTheme(value as ThemeName)}
          />
        </Panel>
      ) : null}
      {overlay.type === 'settings' ? (
        <Panel title="Settings" color={theme.markdownHeading}>
          <Text color={theme.textMuted}>
            General / Profiles / Permissions / Skills / Tasks / Workspace /
            Display
          </Text>
          <InlineSelect
            options={[{ value: 'profiles', label: 'Profiles' }]}
            onChange={onOpenProfiles}
          />
          <SettingLine label="active" value={overlay.config.active_profile} />
          <SettingLine
            label="providers"
            value={`${Object.keys(overlay.config.provider).length}`}
          />
          <SettingLine
            label="models"
            value={`${countModels(overlay.config.models)}`}
          />
          <SettingLine label="sessions" value={overlay.config.sessionDir} />
          <SettingLine label="cwd" value={overlay.config.cwd} />
          <SettingLine label="write" value=".ello/config.yaml" />
        </Panel>
      ) : null}
      {overlay.type === 'tasks' ? (
        <Panel title="Tasks" color={theme.success}>
          {overlay.tasks.length === 0 ? (
            <Text color={theme.textMuted}>tasks &lt;none&gt;</Text>
          ) : (
            overlay.tasks.slice(0, 12).map((task) => (
              <Text key={task.id} color={theme.text}>
                <Text color={theme.textMuted}>{task.id.padEnd(4)}</Text>
                <Text color={statusColor(theme, task.status)}>
                  {task.status.padEnd(12)}
                </Text>
                <Text>{clip(task.subject, 64)}</Text>
              </Text>
            ))
          )}
        </Panel>
      ) : null}
      {overlay.type === 'skills' ? (
        <Panel title="Skills" color={theme.info}>
          {overlay.skills.length === 0 ? (
            <Text color={theme.textMuted}>skills &lt;none&gt;</Text>
          ) : (
            overlay.skills.slice(0, 12).map((skill) => (
              <Text key={skill.name} color={theme.text}>
                <Text color={theme.textMuted}>{skill.name.padEnd(16)}</Text>
                <Text color={theme.accent}>
                  {(skill.source ?? 'global').padEnd(9)}
                </Text>
                <Text>{clip(skill.description, 58)}</Text>
              </Text>
            ))
          )}
        </Panel>
      ) : null}
      {overlay.type === 'agents' ? (
        <Panel title="Subagents" color={theme.markdownHeading}>
          {overlay.agents.length === 0 ? (
            <Text color={theme.textMuted}>agents &lt;none&gt;</Text>
          ) : (
            overlay.agents.slice(0, 12).map((agent) => (
              <Box key={agent.name} flexDirection="column">
                <Text color={theme.text}>
                  <Text color={theme.textMuted}>{agent.name.padEnd(14)}</Text>
                  <Text color={theme.accent}>{agent.source.padEnd(9)}</Text>
                  <Text color={theme.warning}>{agent.role.padEnd(8)}</Text>
                  <Text>{clip(agent.description, 56)}</Text>
                </Text>
                <Text color={theme.textMuted}>
                  {`  tools: ${formatAgentTools(agent.tools)}`}
                </Text>
              </Box>
            ))
          )}
        </Panel>
      ) : null}
      {overlay.type === 'workspace' ? (
        <Panel title="Workspace" color={theme.accent}>
          {overlay.workspaces.length === 0 ? (
            <Text color={theme.textMuted}>workspaces &lt;none&gt;</Text>
          ) : (
            overlay.workspaces.slice(0, 10).map((workspace) => (
              <Text
                key={`${workspace.kind}/${workspace.name}`}
                color={theme.text}
              >
                <Text color={theme.textMuted}>{workspace.kind.padEnd(8)}</Text>
                <Text color={theme.accent}>{workspace.name.padEnd(18)}</Text>
                <Text>{clip(workspace.rootPath, 60)}</Text>
              </Text>
            ))
          )}
        </Panel>
      ) : null}
      {overlay.type === 'session-selector' ? (
        <Panel title="Resume Session" color={theme.info}>
          <InlineSelect
            label="sessions"
            visibleRows={6}
            options={
              overlay.sessions.length > 0
                ? overlay.sessions.map((session) => ({
                    value: session.sessionId,
                    label: renderResumeLabel(session),
                  }))
                : [{ value: '', label: 'No sessions found', disabled: true }]
            }
            onChange={(value) => {
              if (value !== '') {
                onSelectSession(value);
              }
            }}
          />
        </Panel>
      ) : null}
      {overlay.type === 'rewind-selector' ? (
        <Panel title="Rewind Target" color={theme.info}>
          <InlineSelect
            label="rewind target"
            visibleRows={6}
            options={
              overlay.targets.length > 0
                ? overlay.targets.map((target) => ({
                    value: target.entryId,
                    label: renderRewindLabel(target),
                  }))
                : [
                    {
                      value: '',
                      label: 'No rewindable user entries',
                      disabled: true,
                    },
                  ]
            }
            onChange={(value) => {
              if (value !== '') {
                onSelectRewind(value);
              }
            }}
          />
        </Panel>
      ) : null}
    </Box>
  );
}

function ProfileCreatePanel({
  sourceProfile,
  onSubmit,
}: {
  readonly sourceProfile: string;
  onSubmit(name: string, sourceProfile: string): void;
}) {
  const theme = useTheme();
  const [value, setValue] = useState('');
  return (
    <Box
      flexDirection="column"
      borderStyle="round"
      borderColor={theme.info}
      paddingX={1}
    >
      <Text color={theme.accent}>Create profile</Text>
      <Text color={theme.textMuted}>{`Source: ${sourceProfile}`}</Text>
      <Box>
        <Text color={theme.textMuted}>Name: </Text>
        <TextInput
          value={value}
          onChange={setValue}
          onSubmit={(name) => onSubmit(name, sourceProfile)}
        />
      </Box>
      <Text color={theme.textMuted}>Enter: create Esc: cancel</Text>
    </Box>
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

function countModels(models: CodingAgentConfig['models']): number {
  return Object.values(models).reduce(
    (count, entries) => count + Object.keys(entries).length,
    0,
  );
}

function SettingLine({
  label,
  value,
}: {
  readonly label: string;
  readonly value: string;
}) {
  const theme = useTheme();
  return (
    <Text>
      <Text color={theme.textMuted}>{label.padEnd(10)}</Text>
      <Text color={theme.text}>{value}</Text>
    </Text>
  );
}

/** 把选项 value 翻译成审批决定。 */
function toDecision(value: string): ApprovalDecision {
  switch (value) {
    case 'session':
      return { action: 'always_allow', scope: 'session' };
    case 'project':
      return { action: 'always_allow', scope: 'project' };
    case 'user':
      return { action: 'always_allow', scope: 'user' };
    case 'deny':
      return { action: 'deny' };
    default:
      return { action: 'approve_once' };
  }
}

function ApprovalRequestPreview({
  request,
}: {
  readonly request: ApprovalView;
}) {
  const theme = useTheme();
  const view = buildPermissionView(request);
  return (
    <Box flexDirection="column">
      <Text color={theme.accent}>{view.title}</Text>
      {view.fields.map((field) => (
        <Text
          key={`${field.label}:${field.value}`}
          color={theme.textMuted}
          wrap="wrap"
        >
          {`${field.label}: ${field.value}`}
        </Text>
      ))}
      {view.diffSummary !== undefined ? (
        <Text color={theme.textMuted}>
          {`diff: +${view.diffSummary.added} -${view.diffSummary.removed}`}
        </Text>
      ) : null}
      {view.risk !== undefined ? (
        <Text color={theme.warning}>{view.risk}</Text>
      ) : null}
      <Text color={theme.textMuted}>
        {`project scope writes ${PROJECT_RULES_FILE}`}
      </Text>
    </Box>
  );
}

function renderResumeLabel(session: JsonlSessionSummary): string {
  const time = formatSessionTime(session.updatedAt ?? session.createdAt);
  const title =
    session.title ??
    (session.lastUserText !== undefined
      ? clip(session.lastUserText, 56)
      : 'Untitled session');
  return `${time}  ${title}`;
}

function renderRewindLabel(target: RewindTarget): string {
  return `${shortEntryId(target.entryId).padEnd(8)} ${String(target.index).padStart(2, '0')}  ${clip(target.text, 58)}`;
}

function shortEntryId(entryId: string): string {
  return entryId.length <= 8 ? entryId : entryId.slice(0, 8);
}

function formatSessionTime(value: string | undefined): string {
  if (value === undefined) {
    return 'unknown time';
  }
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return value;
  }
  const pad = (item: number) => String(item).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

function clip(text: string, max: number): string {
  const flat = text.replace(/\s+/gu, ' ').trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

function formatAgentTools(tools: readonly string[] | undefined): string {
  if (tools === undefined) {
    return 'all';
  }
  return tools.length === 0 ? 'none' : tools.join(', ');
}

function statusColor(theme: TuiTheme, status: Task['status']): string {
  switch (status) {
    case 'completed':
      return theme.success;
    case 'in_progress':
      return theme.warning;
    case 'cancelled':
      return theme.error;
    default:
      return theme.info;
  }
}
