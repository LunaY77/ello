import type { AgentSkill } from '@ello/agent';
import { Box, Text, useInput } from 'ink';
import TextInput from 'ink-text-input';
import type { ReactNode } from 'react';
import { useState } from 'react';

import type { CodingAgentConfig } from '../../config/index.js';
import type { ModelRole, RuntimeProfileSuite } from '../../provider/index.js';
import type { ApprovalDecision } from '../../runtime/intents.js';
import type {
  JsonlSessionSummary,
  SessionTreeView,
} from '../../session/repository.js';
import type { Task } from '../../tasks/index.js';
import type { WorkspaceManifest } from '../../workspace/index.js';
import { InlineSelect, type SelectOption } from '../components/InlineSelect.js';
import type { ApprovalView } from '../state/view-reducer.js';
import { tokyoNight } from '../tokyo-night.js';

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
  | { readonly type: 'session-tree'; readonly tree: SessionTreeView };

/** 审批浮层四个选项 → 决定。 */
const APPROVAL_OPTIONS = [
  { label: 'Allow once', value: 'once' },
  { label: 'Always allow (session)', value: 'session' },
  { label: 'Always allow (project)', value: 'project' },
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
  onSelectSession?(sessionId: string): void;
  /** session tree checkout 回调。 */
  onCheckout?(entryId: string | null): void;
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
  onSelectSession = () => {},
  onCheckout = () => {},
}: OverlayHostProps) {
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
          borderColor={tokyoNight.yellow}
          paddingX={1}
        >
          <Text
            color={tokyoNight.yellow}
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
          borderColor={tokyoNight.blue}
          paddingX={1}
        >
          <Text color={tokyoNight.cyan}>{overlay.title}</Text>
          <Text color={tokyoNight.muted}>Model catalog</Text>
          <InlineSelect options={overlay.options} onChange={onSelectModel} />
          <Text color={tokyoNight.muted}>Enter: select Esc: cancel</Text>
        </Box>
      ) : null}
      {overlay.type === 'profiles' ? (
        <Box
          flexDirection="column"
          borderStyle="round"
          borderColor={tokyoNight.blue}
          paddingX={1}
        >
          <Text color={tokyoNight.cyan}>Settings / Profiles</Text>
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
          <Text color={tokyoNight.muted}>
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
          borderColor={tokyoNight.red}
          paddingX={1}
        >
          <Text color={tokyoNight.red}>Delete profile</Text>
          <Text color={tokyoNight.foreground}>
            {`Profile: ${overlay.profile}`}
          </Text>
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
          <Text color={tokyoNight.muted}>Enter: confirm Esc: cancel</Text>
        </Box>
      ) : null}
      {overlay.type === 'profile-detail' ? (
        <Box
          flexDirection="column"
          borderStyle="round"
          borderColor={tokyoNight.blue}
          paddingX={1}
        >
          <Text
            color={tokyoNight.cyan}
          >{`Profile: ${overlay.profile.name}`}</Text>
          <Text color={tokyoNight.foreground}>
            {`Label: ${overlay.profile.label ?? overlay.profile.name}`}
          </Text>
          <Text color={tokyoNight.foreground} wrap="wrap">
            {`Description: ${overlay.profile.description ?? ''}`}
          </Text>
          <Box marginTop={1} flexDirection="column">
            <Text color={tokyoNight.muted}>Role bindings</Text>
            <Text color={tokyoNight.muted}>Role Model Context Output</Text>
            <InlineSelect
              options={overlay.options}
              onChange={(role) =>
                onSelectProfileRole(overlay.profile.name, role as ModelRole)
              }
            />
          </Box>
          <Text color={tokyoNight.muted}>
            Enter: change model s: save Esc: back
          </Text>
        </Box>
      ) : null}
      {overlay.type === 'profile-model-catalog' ? (
        <Box
          flexDirection="column"
          borderStyle="round"
          borderColor={tokyoNight.blue}
          paddingX={1}
        >
          <Text color={tokyoNight.cyan}>
            {`Select model for profile.${overlay.target.profileName}.models.${overlay.target.role}`}
          </Text>
          <Text color={tokyoNight.muted}>Model catalog</Text>
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
          <Text color={tokyoNight.muted}>Enter: bind Esc: cancel</Text>
        </Box>
      ) : null}
      {overlay.type === 'help' ? (
        <Box
          flexDirection="column"
          borderStyle="round"
          borderColor={tokyoNight.surface}
          paddingX={1}
        >
          <Text color={tokyoNight.cyan}>Commands</Text>
          <Text color={tokyoNight.foreground} wrap="wrap">
            /help /models /profiles /new /tools /permissions /memory /quit
          </Text>
          <Text color={tokyoNight.muted}>
            @path attaches files · !cmd runs shell · Esc closes or interrupts
          </Text>
        </Box>
      ) : null}
      {overlay.type === 'settings' ? (
        <Panel title="Settings" color={tokyoNight.purple}>
          <Text color={tokyoNight.muted}>
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
        <Panel title="Tasks" color={tokyoNight.green}>
          {overlay.tasks.length === 0 ? (
            <Text color={tokyoNight.muted}>tasks &lt;none&gt;</Text>
          ) : (
            overlay.tasks.slice(0, 12).map((task) => (
              <Text key={task.id} color={tokyoNight.foreground}>
                <Text color={tokyoNight.muted}>{task.id.padEnd(4)}</Text>
                <Text color={statusColor(task.status)}>
                  {task.status.padEnd(12)}
                </Text>
                <Text>{clip(task.subject, 64)}</Text>
              </Text>
            ))
          )}
        </Panel>
      ) : null}
      {overlay.type === 'skills' ? (
        <Panel title="Skills" color={tokyoNight.blue}>
          {overlay.skills.length === 0 ? (
            <Text color={tokyoNight.muted}>skills &lt;none&gt;</Text>
          ) : (
            overlay.skills.slice(0, 12).map((skill) => (
              <Text key={skill.name} color={tokyoNight.foreground}>
                <Text color={tokyoNight.muted}>{skill.name.padEnd(16)}</Text>
                <Text color={tokyoNight.cyan}>
                  {(skill.source ?? 'global').padEnd(9)}
                </Text>
                <Text>{clip(skill.description, 58)}</Text>
              </Text>
            ))
          )}
        </Panel>
      ) : null}
      {overlay.type === 'workspace' ? (
        <Panel title="Workspace" color={tokyoNight.cyan}>
          {overlay.workspaces.length === 0 ? (
            <Text color={tokyoNight.muted}>workspaces &lt;none&gt;</Text>
          ) : (
            overlay.workspaces.slice(0, 10).map((workspace) => (
              <Text
                key={`${workspace.kind}/${workspace.name}`}
                color={tokyoNight.foreground}
              >
                <Text color={tokyoNight.muted}>{workspace.kind.padEnd(8)}</Text>
                <Text color={tokyoNight.cyan}>{workspace.name.padEnd(18)}</Text>
                <Text>{clip(workspace.rootPath, 60)}</Text>
              </Text>
            ))
          )}
        </Panel>
      ) : null}
      {overlay.type === 'session-selector' ? (
        <Panel title="Resume Session" color={tokyoNight.blue}>
          <InlineSelect
            options={
              overlay.sessions.length > 0
                ? overlay.sessions.map((session) => ({
                    value: session.sessionId,
                    label: renderResumeLabel(session),
                  }))
                : [{ value: '', label: 'No sessions found' }]
            }
            onChange={(value) => {
              if (value !== '') {
                onSelectSession(value);
              }
            }}
          />
        </Panel>
      ) : null}
      {overlay.type === 'session-tree' ? (
        <Panel title="Session Tree" color={tokyoNight.cyan}>
          <InlineSelect
            options={[
              { value: '<root>', label: 'checkout root' },
              ...overlay.tree.nodes.map((node) => ({
                value: node.id,
                label: renderTreeLabel(node, overlay.tree),
              })),
            ]}
            onChange={(value) => onCheckout(value === '<root>' ? null : value)}
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
  const [value, setValue] = useState('');
  return (
    <Box
      flexDirection="column"
      borderStyle="round"
      borderColor={tokyoNight.blue}
      paddingX={1}
    >
      <Text color={tokyoNight.cyan}>Create profile</Text>
      <Text color={tokyoNight.muted}>{`Source: ${sourceProfile}`}</Text>
      <Box>
        <Text color={tokyoNight.muted}>Name: </Text>
        <TextInput
          value={value}
          onChange={setValue}
          onSubmit={(name) => onSubmit(name, sourceProfile)}
        />
      </Box>
      <Text color={tokyoNight.muted}>Enter: create Esc: cancel</Text>
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
  return (
    <Text>
      <Text color={tokyoNight.muted}>{label.padEnd(10)}</Text>
      <Text color={tokyoNight.foreground}>{value}</Text>
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
  const metadata = request.metadata ?? {};
  const path = readMetadataString(metadata, 'path');
  const command = readMetadataString(metadata, 'command');
  const url = readMetadataString(metadata, 'url');
  if (path !== '') {
    return <Text color={tokyoNight.muted}>{path}</Text>;
  }
  if (command !== '') {
    return <Text color={tokyoNight.muted}>{`$ ${command}`}</Text>;
  }
  if (url !== '') {
    return <Text color={tokyoNight.muted}>{url}</Text>;
  }
  return (
    <Text color={tokyoNight.muted} wrap="wrap">
      {preview(request.input)}
    </Text>
  );
}

function readMetadataString(
  metadata: Record<string, unknown>,
  key: string,
): string {
  const value = metadata[key];
  return typeof value === 'string' ? value : '';
}

/** 入参预览（截断）。 */
function preview(value: unknown): string {
  if (value === undefined) {
    return '-';
  }
  const text = typeof value === 'string' ? value : JSON.stringify(value);
  return text.length > 240 ? `${text.slice(0, 240)} …` : text;
}

function compactPath(value: string): string {
  return value.length <= 48 ? value : `…${value.slice(-47)}`;
}

function renderResumeLabel(session: JsonlSessionSummary): string {
  const bits = [`${session.sessionId.slice(0, 8)}`, compactPath(session.cwd)];
  if (session.lastUserText !== undefined) {
    bits.push(`you: ${clip(session.lastUserText, 36)}`);
  }
  if (session.lastAssistantText !== undefined) {
    bits.push(`ello: ${clip(session.lastAssistantText, 36)}`);
  }
  if (session.lastToolText !== undefined) {
    bits.push(`tool: ${clip(session.lastToolText, 36)}`);
  }
  return bits.join('  ');
}

function renderTreeLabel(
  node: SessionTreeView['nodes'][number],
  tree: SessionTreeView,
): string {
  const prefix = node.active ? '●' : '○';
  const path = renderEntryPath(tree, node.id);
  return `${prefix} ${path}  ${clip(node.label, 44)}`;
}

function renderEntryPath(tree: SessionTreeView, entryId: string): string {
  const chain: string[] = [];
  let current: string | null = entryId;
  while (current !== null) {
    const node = tree.nodes.find((item) => item.id === current);
    if (node === undefined) {
      break;
    }
    chain.push(node.label);
    current = node.parentId;
  }
  return chain.reverse().join(' › ');
}

function clip(text: string, max: number): string {
  const flat = text.replace(/\s+/gu, ' ').trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

function statusColor(status: Task['status']): string {
  switch (status) {
    case 'completed':
      return tokyoNight.green;
    case 'in_progress':
      return tokyoNight.yellow;
    case 'cancelled':
      return tokyoNight.red;
    default:
      return tokyoNight.blue;
  }
}
