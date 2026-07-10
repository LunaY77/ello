import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { useApp, useInput } from 'ink';
import { useEffect, useMemo, useState } from 'react';

import {
  deleteConfigValues,
  setConfigValue,
  type CodingAgentConfig,
  type ProfileSuiteConfig,
} from '../config/index.js';
import {
  createProviderRegistry,
  type ModelRole,
  type RuntimeModel,
  type RuntimeProfileSuite,
} from '../provider/index.js';
import type {
  CodingMemoryStatus,
  CodingSession,
  ApprovalDecision,
} from '../runtime/index.js';
import { handleSlashCommand, type CommandResult } from '../slash-commands.js';

import { completeInput } from './completion.js';
import { AppShell } from './component/AppShell.js';
import { Composer } from './component/Composer.js';
import {
  OverlayHost,
  type OverlayState,
  type RewindTarget,
} from './component/OverlayHost.js';
import { TerminalHistoryOutput } from './component/TerminalHistoryOutput.js';
import { useRuntimeEvents } from './hooks/use-runtime-events.js';
import {
  loadSkillsOverlay,
  loadTasksOverlay,
  loadWorkspaceOverlay,
} from './overlay-loaders.js';
import { detectTrigger, rankCandidates } from './store/autocomplete.js';
import type { HistoryEntry } from './store/history-entry.js';
import {
  hasFileParts,
  parsePromptParts,
  serializeForModel,
} from './store/prompt-parts.js';
import {
  defaultThemeName,
  resolveTheme,
  ThemeProvider,
  type ThemeName,
} from './theme/index.js';
import type { SelectOption } from './ui/List.js';

export interface CodingAgentAppProps {
  readonly session: CodingSession;
  readonly config: CodingAgentConfig;
}

/**
 * TUI 根组件。
 *
 * 职责边界：渲染、采集输入、把意图回灌 {@link CodingSession}、管理浮层与焦点。
 * 不调用 `@ello/agent`、不判权限、不持久化、不执行工具。
 */
export function CodingAgentApp({ session, config }: CodingAgentAppProps) {
  const { exit } = useApp();
  const { state, clearCount, historyResetKey, pushUser } =
    useRuntimeEvents(session);
  const [runtimeConfig, setRuntimeConfig] = useState(config);
  const [overlay, setOverlay] = useState<OverlayState>({ type: 'none' });
  const [input, setInput] = useState('');
  const [themeName, setThemeName] = useState<ThemeName>(defaultThemeName);
  const [profile, setProfile] = useState(runtimeConfig.active_profile);
  const [primaryModel, setPrimaryModel] = useState(() =>
    currentPrimaryModel(runtimeConfig),
  );
  const [fileSuggestions, setFileSuggestions] = useState<readonly string[]>([]);
  const [workingSeconds, setWorkingSeconds] = useState(0);
  const [inputHistory, setInputHistory] = useState<readonly string[]>([]);
  const [pendingSteers, setPendingSteers] = useState<readonly string[]>([]);
  const activeTrigger = detectTrigger(currentLineBeforeCursor(input));
  const fileQuery =
    activeTrigger?.kind === 'file' ? activeTrigger.query : undefined;
  const profileOptions = useMemo(
    () => buildProfileSelectorOptions(runtimeConfig),
    [runtimeConfig],
  );
  const modelCatalogOptions = useMemo(
    () => buildModelCatalogOptions(runtimeConfig),
    [runtimeConfig],
  );
  const profileSelections = useMemo(
    () =>
      profileOptions
        .filter((option) => option.disabled !== true)
        .map((option) => option.value),
    [profileOptions],
  );

  // 审批是最高优先级浮层：pendingApproval 一来就盖过其它浮层。
  const effectiveOverlay: OverlayState =
    state.pendingApproval !== undefined
      ? { type: 'approval', request: state.pendingApproval }
      : overlay;

  useInput((_input, key) => {
    if (key.escape && effectiveOverlay.type !== 'none') {
      escapeOverlayOrAbort();
    }
  });

  useEffect(() => {
    void session.loadHistory();
  }, [session]);

  useEffect(() => {
    if (clearCount === 0) {
      return;
    }
    queueMicrotask(() => {
      setOverlay({ type: 'none' });
      setInput('');
      setFileSuggestions([]);
      setWorkingSeconds(0);
      setPendingSteers([]);
    });
  }, [clearCount]);

  useEffect(() => {
    if (fileQuery === undefined) {
      return;
    }
    let active = true;
    void completeFiles(fileQuery, config.cwd)
      .then((items) => {
        if (active) {
          setFileSuggestions(items);
        }
      })
      .catch((error) => {
        session.notify(
          `File completion failed: ${error instanceof Error ? error.message : String(error)}`,
        );
      });
    return () => {
      active = false;
    };
  }, [config.cwd, fileQuery, session]);

  useEffect(() => {
    if (state.status !== 'running') {
      return;
    }
    const started = Date.now();
    const timer = setInterval(() => {
      const elapsed = Math.floor((Date.now() - started) / 1000);
      setWorkingSeconds(elapsed);
    }, 250);
    return () => {
      clearInterval(timer);
      setPendingSteers([]);
    };
  }, [state.status]);

  /** 执行一条 slash command 的产品动作。 */
  const runCommand = (command: CommandResult): void => {
    switch (command.type) {
      case 'open-overlay':
        if (command.overlay === 'profiles') {
          openProfiles();
        } else if (command.overlay === 'agents') {
          setOverlay({ type: 'agents', agents: session.listSubagents() });
        } else if (command.overlay === 'models') {
          setOverlay({
            type: 'models',
            title: `Select primary model for profile.${runtimeConfig.active_profile}.models.primary`,
            options: modelCatalogOptions,
          });
        } else if (command.overlay === 'help') {
          setOverlay({ type: 'help' });
        } else if (command.overlay === 'settings') {
          setOverlay({ type: 'settings', config: runtimeConfig });
        } else if (command.overlay === 'theme') {
          setOverlay({ type: 'theme', active: themeName });
        } else if (command.overlay === 'tasks') {
          void loadTasksOverlay(session).then(setOverlay);
        } else if (command.overlay === 'skills') {
          void loadSkillsOverlay(runtimeConfig).then(setOverlay);
        } else if (command.overlay === 'workspace') {
          void loadWorkspaceOverlay().then(setOverlay);
        } else if (command.overlay === 'session-selector') {
          void session
            .listSessions()
            .then((sessions) =>
              setOverlay({ type: 'session-selector', sessions }),
            );
        } else {
          session.notify(`Overlay is not implemented: ${command.overlay}`);
        }
        return;
      case 'runtime-action':
        if (command.action === 'clear') {
          void session.clear();
        } else if (command.action === 'new-session') {
          void session.newSession();
        } else if (command.action === 'fork') {
          const targetEntryId = command.args?.[0];
          const reason =
            targetEntryId === undefined
              ? 'fork from TUI'
              : `fork from ${targetEntryId}`;
          void session.fork(reason, targetEntryId).catch((error) => {
            session.notify(
              `Fork failed: ${error instanceof Error ? error.message : String(error)}`,
            );
          });
        } else if (command.action === 'compact') {
          session.notify('Manual compact triggered — will run on next turn.');
        } else if (command.action === 'summary') {
          void session.summarize().catch((error) => {
            session.notify(
              `Summary failed: ${error instanceof Error ? error.message : String(error)}`,
            );
          });
        } else if (command.action === 'rewind') {
          const entryId = command.args?.[0];
          if (entryId === undefined) {
            setOverlay({
              type: 'rewind-selector',
              targets: buildRewindTargets(state.history),
            });
            return;
          }
          void session
            .rewind(entryId)
            .then((prompt) => setInput(prompt))
            .catch((error) => {
              session.notify(
                `Rewind failed: ${error instanceof Error ? error.message : String(error)}`,
              );
            });
        } else if (command.action === 'memory') {
          const reload = command.args?.[0] === 'reload';
          void (reload ? session.reloadMemory() : Promise.resolve())
            .then(() => session.memoryStatus())
            .then((status) =>
              session.notify(
                `${reload ? 'Memory reloaded.\n' : ''}${formatMemoryStatus(status)}`,
              ),
            )
            .catch((error) => {
              session.notify(
                `Memory failed: ${error instanceof Error ? error.message : String(error)}`,
              );
            });
        } else if (command.action === 'dream') {
          void session
            .dream()
            .then((job) => session.notify(`Dream job ${job.id}: ${job.status}`))
            .catch((error) => {
              session.notify(
                `Dream failed: ${error instanceof Error ? error.message : String(error)}`,
              );
            });
        } else if (command.action === 'export') {
          void exportCurrentSession(command.args?.[0]);
        } else if (command.action === 'quit') {
          void session.close().then(() => exit());
        } else {
          session.notify(
            `Runtime action is not implemented: ${command.action}`,
          );
        }
        return;
      case 'submit':
        pushUser(command.prompt);
        void session.submit(command.prompt);
        return;
      case 'set-profile':
        applyProfileSelection(command.profile);
        return;
      case 'message':
        session.notify(command.message);
        return;
      default:
        session.notify('Command is not implemented in TUI yet.');
        return;
    }
  };

  /** 处理 Composer 的一次提交。 */
  const onSubmit = (value: string): void => {
    const commandInput = value.trim();
    if (commandInput === '') {
      return;
    }
    rememberInput(value);
    if (commandInput.startsWith('!')) {
      void runShellEscape(commandInput.slice(1).trim());
      return;
    }
    const slash = handleSlashCommand(commandInput, runtimeConfig);
    if (slash.handled) {
      if (slash.command !== undefined) {
        runCommand(slash.command);
      } else if (slash.output !== '') {
        session.notify(slash.output);
      }
      return;
    }
    if (state.status === 'running') {
      // 运行中提交 = steer（缓冲到下一轮）。
      setPendingSteers((current) => [...current, value]);
      session.steer(value);
      return;
    }
    void submitPrompt(value);
  };

  const runShellEscape = async (command: string): Promise<void> => {
    if (command === '') {
      session.notify('Usage: !<shell command>');
      return;
    }
    pushUser(`!${command}`);
    const result = await session.runShell(command);
    const output = formatShellResult(command, result);
    session.notify(output);
  };

  async function submitPrompt(prompt: string): Promise<void> {
    try {
      const parts = parsePromptParts(prompt);
      const expanded = hasFileParts(parts)
        ? await serializeForModel(parts, {
            cwd: runtimeConfig.cwd,
            readFile: (absolutePath) => readFile(absolutePath, 'utf8'),
            resolvePath: (cwd, relative) => resolvePromptPath(cwd, relative),
          })
        : prompt;
      pushUser(prompt);
      void session.submit(expanded);
    } catch (error) {
      session.notify(
        `Failed to attach file: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  function cancelOrExit(): void {
    if (effectiveOverlay.type === 'profile-detail') {
      openProfiles();
      return;
    }
    if (effectiveOverlay.type === 'profile-create') {
      openProfiles();
      return;
    }
    if (effectiveOverlay.type === 'profile-delete-confirm') {
      openProfiles();
      return;
    }
    if (effectiveOverlay.type === 'profile-model-catalog') {
      openProfileDetail(effectiveOverlay.target.profileName);
      return;
    }
    if (
      effectiveOverlay.type !== 'none' &&
      effectiveOverlay.type !== 'approval'
    ) {
      setOverlay({ type: 'none' });
      return;
    }
    if (state.status === 'running' || state.status === 'awaiting_approval') {
      session.abort('user interrupted from TUI');
      return;
    }
    if (input.trim() === '') {
      void session.close().then(() => exit());
    }
  }

  function escapeOverlayOrAbort(): void {
    if (effectiveOverlay.type === 'profile-detail') {
      openProfiles();
      return;
    }
    if (effectiveOverlay.type === 'profile-create') {
      openProfiles();
      return;
    }
    if (effectiveOverlay.type === 'profile-delete-confirm') {
      openProfiles();
      return;
    }
    if (effectiveOverlay.type === 'profile-model-catalog') {
      openProfileDetail(effectiveOverlay.target.profileName);
      return;
    }
    if (
      effectiveOverlay.type !== 'none' &&
      effectiveOverlay.type !== 'approval'
    ) {
      setOverlay({ type: 'none' });
      return;
    }
    if (state.status === 'running' || state.status === 'awaiting_approval') {
      session.abort('user interrupted from TUI');
    }
  }

  const onApprove = (requestId: string, decision: ApprovalDecision): void => {
    void session.approve(requestId, decision);
  };

  const onSelectSession = (sessionId: string): void => {
    setOverlay({ type: 'none' });
    void session.resumeSession(sessionId).catch((error) => {
      session.notify(
        `Resume failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    });
  };

  const onSelectRewind = (entryId: string): void => {
    setOverlay({ type: 'none' });
    void session
      .rewind(entryId)
      .then((prompt) => setInput(prompt))
      .catch((error) => {
        session.notify(
          `Rewind failed: ${error instanceof Error ? error.message : String(error)}`,
        );
      });
  };

  const selectTheme = (nextTheme: ThemeName): void => {
    resolveTheme(nextTheme);
    setThemeName(nextTheme);
    setOverlay({ type: 'none' });
  };

  async function exportCurrentSession(formatArg: string | undefined) {
    const format = formatArg === 'html' ? 'html' : 'jsonl';
    const content = await session.exportSession(format);
    const exportDir = path.join(runtimeConfig.cwd, '.ello', 'exports');
    await mkdir(exportDir, { recursive: true });
    const target = path.join(exportDir, `session-${Date.now()}.${format}`);
    await writeFile(target, content, 'utf8');
    session.notify(`Session exported: ${target}`);
  }

  function rememberInput(prompt: string): void {
    setInputHistory((current) =>
      [...current.filter((item) => item !== prompt), prompt].slice(-50),
    );
  }

  function applyProfileSelection(selection: string): void {
    void session
      .setProfile(selection)
      .then((resolvedPrimary) => {
        const next = {
          ...runtimeConfig,
          active_profile: selection,
        };
        setProfile(selection);
        setPrimaryModel(resolvedPrimary);
        setRuntimeConfig(next);
        openProfileDetail(selection, next);
      })
      .catch((error) => {
        session.notify(
          `Profile selection failed: ${error instanceof Error ? error.message : String(error)}`,
        );
      });
  }

  function applyPrimaryModelSelection(selection: string): void {
    void session
      .setPrimaryModel(selection)
      .then((resolvedPrimary) => {
        setPrimaryModel(resolvedPrimary);
        setRuntimeConfig((current) =>
          bindRoleInConfig(
            current,
            current.active_profile,
            'primary',
            resolvedPrimary,
          ),
        );
      })
      .catch((error) => {
        session.notify(
          `Model selection failed: ${error instanceof Error ? error.message : String(error)}`,
        );
      });
  }

  function applyProfileRoleModelSelection(
    profileName: string,
    role: ModelRole,
    selection: string,
  ): void {
    void session
      .setProfileRoleModel(profileName, role, selection)
      .then((resolvedModel) => {
        const next = bindRoleInConfig(
          runtimeConfig,
          profileName,
          role,
          resolvedModel,
        );
        setRuntimeConfig(next);
        if (profileName === next.active_profile && role === 'primary') {
          setPrimaryModel(resolvedModel);
        }
        openProfileDetail(profileName, next);
      })
      .catch((error) => {
        session.notify(
          `Model binding failed: ${error instanceof Error ? error.message : String(error)}`,
        );
      });
  }

  function openProfiles(): void {
    openProfilesFrom(runtimeConfig);
  }

  function openProfilesFrom(sourceConfig: CodingAgentConfig): void {
    setOverlay({
      type: 'profiles',
      options: buildProfileSelectorOptions(sourceConfig),
    });
  }

  function openCreateProfile(sourceProfile: string): void {
    setOverlay({
      type: 'profile-create',
      sourceProfile,
    });
  }

  function openProfileDetail(
    profileName: string,
    sourceConfig = runtimeConfig,
  ): void {
    const registry = createProviderRegistry(sourceConfig);
    const selected = registry.getProfile(profileName);
    setOverlay({
      type: 'profile-detail',
      profile: selected,
      options: buildProfileRoleOptions(sourceConfig, selected),
    });
  }

  function openRoleModelCatalog(profileName: string, role: ModelRole): void {
    setOverlay({
      type: 'profile-model-catalog',
      target: { profileName, role },
      options: modelCatalogOptions,
    });
  }

  function saveProfile(profileName: string): void {
    const profileConfig = runtimeConfig.profile[profileName];
    if (profileConfig === undefined) {
      session.notify(`Unknown profile: ${profileName}`);
      return;
    }
    void setConfigValue(
      runtimeConfig.cwd,
      'global',
      `profile.${profileName}`,
      profileConfig,
    )
      .then((nextConfig) => {
        setRuntimeConfig(nextConfig);
        session.notify(`Profile saved: ${profileName}`);
      })
      .catch((error) => {
        session.notify(
          `Profile save failed: ${error instanceof Error ? error.message : String(error)}`,
        );
      });
  }

  function createProfile(
    profileNameInput: string,
    sourceProfile: string,
  ): void {
    const profileName = profileNameInput.trim();
    if (!isProfileName(profileName)) {
      session.notify(
        'Profile name must contain only letters, numbers, underscores, and hyphens.',
      );
      return;
    }
    const source = runtimeConfig.profile[sourceProfile];
    if (source === undefined) {
      session.notify(`Unknown source profile: ${sourceProfile}`);
      return;
    }
    if (runtimeConfig.profile[profileName] !== undefined) {
      session.notify(`Profile already exists: ${profileName}`);
      return;
    }
    const nextProfile: ProfileSuiteConfig = cloneProfileConfig({
      ...source,
      label: profileName,
      description: `基于 ${sourceProfile} 创建。`,
    });
    void session
      .createProfile(profileName, sourceProfile)
      .then(() =>
        setConfigValue(
          runtimeConfig.cwd,
          'global',
          `profile.${profileName}`,
          nextProfile,
        ),
      )
      .then((nextConfig) => {
        setRuntimeConfig(nextConfig);
        openProfileDetail(profileName, nextConfig);
      })
      .catch((error) => {
        session.notify(
          `Profile create failed: ${error instanceof Error ? error.message : String(error)}`,
        );
      });
  }

  function requestDeleteProfile(profileName: string): void {
    if (profileName === runtimeConfig.active_profile) {
      session.notify(`Cannot delete active profile: ${profileName}`);
      return;
    }
    if (runtimeConfig.profile[profileName] === undefined) {
      session.notify(`Unknown profile: ${profileName}`);
      return;
    }
    setOverlay({
      type: 'profile-delete-confirm',
      profile: profileName,
    });
  }

  function deleteProfile(profileName: string): void {
    if (profileName === runtimeConfig.active_profile) {
      session.notify(`Cannot delete active profile: ${profileName}`);
      return;
    }
    if (runtimeConfig.profile[profileName] === undefined) {
      session.notify(`Unknown profile: ${profileName}`);
      return;
    }
    if (Object.keys(runtimeConfig.profile).length <= 1) {
      session.notify('Cannot delete the final profile.');
      return;
    }
    void session
      .deleteProfile(profileName)
      .then(() =>
        deleteConfigValues(runtimeConfig.cwd, 'global', [
          `profile.${profileName}`,
        ]),
      )
      .then((nextConfig) => {
        setRuntimeConfig(nextConfig);
        openProfilesFrom(nextConfig);
      })
      .catch((error) => {
        session.notify(
          `Profile delete failed: ${error instanceof Error ? error.message : String(error)}`,
        );
      });
  }

  function activateProfile(profileName: string): void {
    void session
      .setProfile(profileName)
      .then((resolvedPrimary) =>
        setConfigValue(
          runtimeConfig.cwd,
          'global',
          'active_profile',
          profileName,
        ).then((nextConfig) => ({ nextConfig, resolvedPrimary })),
      )
      .then(({ nextConfig, resolvedPrimary }) => {
        setProfile(profileName);
        setPrimaryModel(resolvedPrimary);
        setRuntimeConfig(nextConfig);
        openProfilesFrom(nextConfig);
        session.notify(`Active profile set: ${profileName}`);
      })
      .catch((error) => {
        session.notify(
          `Set active profile failed: ${error instanceof Error ? error.message : String(error)}`,
        );
      });
  }

  const runningTools = useMemo(
    () => [...state.live.runningTools.values()],
    [state.live.runningTools],
  );
  const runningSubagents = useMemo(
    () => [...state.live.runningSubagents.values()],
    [state.live.runningSubagents],
  );

  const suggestions = useMemo(
    () => completeInput(input, profileSelections, fileSuggestions),
    [fileSuggestions, input, profileSelections],
  );
  const historyEntries = useMemo<readonly HistoryEntry[]>(
    () => [
      {
        kind: 'session_header',
        id: 'session-header',
        cwd: runtimeConfig.cwd,
        profile,
        model: primaryModel,
        approvalMode: runtimeConfig.approvalMode,
      },
      ...state.history,
    ],
    [
      primaryModel,
      profile,
      runtimeConfig.approvalMode,
      runtimeConfig.cwd,
      state.history,
    ],
  );

  return (
    <ThemeProvider theme={resolveTheme(themeName)}>
      <TerminalHistoryOutput
        entries={historyEntries}
        resetKey={historyResetKey}
      />
      <AppShell
        profile={`${profile} / ${primaryModel}`}
        approvalMode={runtimeConfig.approvalMode}
        liveAssistantText={state.live.assistantText}
        runningTools={runningTools}
        runningSubagents={runningSubagents}
        running={state.status === 'running'}
        workingSeconds={workingSeconds}
        pendingSteers={pendingSteers}
        {...(state.interruptNotice !== undefined
          ? { interruptNotice: state.interruptNotice }
          : {})}
        {...(state.usage !== undefined ? { usage: state.usage } : {})}
        overlay={
          <OverlayHost
            overlay={
              effectiveOverlay.type === 'approval'
                ? { type: 'none' }
                : effectiveOverlay
            }
            onApprove={onApprove}
            onSelectModel={(selected) => {
              setOverlay({ type: 'none' });
              applyPrimaryModelSelection(selected);
            }}
            onSelectProfile={(selected) => {
              openProfileDetail(selected);
            }}
            onCreateProfile={openCreateProfile}
            onRequestDeleteProfile={requestDeleteProfile}
            onConfirmDeleteProfile={deleteProfile}
            onActivateProfile={activateProfile}
            onSubmitNewProfile={createProfile}
            onSelectProfileRole={openRoleModelCatalog}
            onBindProfileRoleModel={applyProfileRoleModelSelection}
            onOpenProfiles={openProfiles}
            onSaveProfile={saveProfile}
            onSelectSession={onSelectSession}
            onSelectRewind={onSelectRewind}
            onSelectTheme={selectTheme}
          />
        }
        composer={
          effectiveOverlay.type === 'approval' ? (
            <OverlayHost
              overlay={effectiveOverlay}
              marginTop={0}
              onApprove={onApprove}
              onSelectModel={(selected) => {
                setOverlay({ type: 'none' });
                applyPrimaryModelSelection(selected);
              }}
              onSelectProfile={(selected) => {
                openProfileDetail(selected);
              }}
              onCreateProfile={openCreateProfile}
              onRequestDeleteProfile={requestDeleteProfile}
              onConfirmDeleteProfile={deleteProfile}
              onActivateProfile={activateProfile}
              onSubmitNewProfile={createProfile}
              onSelectProfileRole={openRoleModelCatalog}
              onBindProfileRoleModel={applyProfileRoleModelSelection}
              onOpenProfiles={openProfiles}
              onSaveProfile={saveProfile}
              onSelectSession={onSelectSession}
              onSelectRewind={onSelectRewind}
              onSelectTheme={selectTheme}
            />
          ) : (
            <Composer
              running={state.status === 'running'}
              isActive={effectiveOverlay.type === 'none'}
              history={inputHistory}
              value={input}
              {...(suggestions !== undefined ? { suggestions } : {})}
              onChange={(value) => {
                setInput(value);
                if (
                  detectTrigger(currentLineBeforeCursor(value))?.kind !== 'file'
                ) {
                  setFileSuggestions([]);
                }
              }}
              onSubmit={onSubmit}
              onCancel={cancelOrExit}
              onEscape={escapeOverlayOrAbort}
            />
          )
        }
      />
    </ThemeProvider>
  );
}

function formatMemoryStatus(status: CodingMemoryStatus): string {
  if (!status.enabled) {
    return [
      'Memory: disabled',
      `private: ${status.privateRoot}`,
      `team: ${status.teamRoot}`,
      'Enable with context.memory.enabled: true',
    ].join('\n');
  }
  return [
    'Memory: enabled',
    `private: ${status.privateRoot} (${status.privateEntries} topics)`,
    `team: ${status.teamRoot} (${status.teamEntries} topics)`,
    `jobs: ${status.queuedJobs} queued, ${status.runningJobs} running, ${status.failedJobs} failed`,
    status.activeDream === null
      ? 'dream: idle'
      : `dream: ${status.activeDream.id} ${status.activeDream.status}`,
  ].join('\n');
}

function buildRewindTargets(
  history: readonly HistoryEntry[],
): readonly RewindTarget[] {
  return history.flatMap((entry, index) => {
    if (entry.kind !== 'user') {
      return [];
    }
    if (entry.entryId === undefined) {
      return [];
    }
    return [
      {
        entryId: entry.entryId,
        index: index + 1,
        text: entry.text,
      },
    ];
  });
}

function currentPrimaryModel(config: CodingAgentConfig): string {
  const registry = createProviderRegistry(config);
  return registry.resolveRole(config.active_profile, 'primary').ref;
}

const profileRoleOrder: readonly ModelRole[] = [
  'primary',
  'small',
  'compact',
  'title',
  'review',
];

function buildProfileRoleOptions(
  config: CodingAgentConfig,
  profile: RuntimeProfileSuite,
): readonly SelectOption[] {
  const registry = createProviderRegistry(config);
  return profileRoleOrder.map((role) => {
    const model = registry.getModel(profile.models[role]);
    return {
      value: role,
      label: `${role.padEnd(8)} ${model.ref.padEnd(31)} ${String(model.limit.context).padEnd(10)} ${String(model.limit.output).padEnd(8)}`,
    };
  });
}

function bindRoleInConfig(
  config: CodingAgentConfig,
  profileName: string,
  role: ModelRole,
  modelReference: string,
): CodingAgentConfig {
  const profile = config.profile[profileName];
  if (profile === undefined) {
    throw new Error(`Unknown profile: ${profileName}`);
  }
  return {
    ...config,
    profile: {
      ...config.profile,
      [profileName]: {
        ...profile,
        models: {
          ...profile.models,
          [role]: modelReference,
        },
      },
    },
  };
}

export function buildProfileSelectorOptions(
  config: CodingAgentConfig,
): readonly SelectOption[] {
  const registry = createProviderRegistry(config);
  const options: SelectOption[] = [];
  const profiles = registry.listProfiles();
  options.push(groupOption('Profiles'));
  for (const profile of profiles) {
    options.push(profileOption(profile, config));
  }
  return options;
}

export function buildModelCatalogOptions(
  config: CodingAgentConfig,
): readonly SelectOption[] {
  const registry = createProviderRegistry(config);
  const options: SelectOption[] = [];
  const providers = registry
    .listProviders()
    .filter(
      (provider) =>
        provider.enabled && registry.listModels(provider.id).length > 0,
    );
  for (const provider of providers) {
    options.push(groupOption(provider.name));
    for (const model of registry.listModels(provider.id)) {
      options.push(modelOption(model));
    }
  }
  return options;
}

function groupOption(label: string): SelectOption {
  return {
    label,
    value: `group:${label}`,
    disabled: true,
  };
}

function profileOption(
  profile: RuntimeProfileSuite,
  config: CodingAgentConfig,
): SelectOption {
  const markers = [
    profile.name === config.active_profile ? 'active' : null,
  ].filter((item): item is string => item !== null);
  const label = profile.label ?? profile.name;
  const description = profile.description ?? '';
  return {
    label: `  ${profile.name}${markers.length > 0 ? ` [${markers.join(', ')}]` : ''}  ${label}${description.length > 0 ? `  ${description}` : ''}`,
    value: profile.name,
  };
}

function modelOption(model: RuntimeModel): SelectOption {
  return {
    label: `  ${model.ref}  ctx ${model.limit.context} / out ${model.limit.output}`,
    value: model.ref,
  };
}

async function completeFiles(
  query: string,
  cwd: string,
): Promise<readonly string[]> {
  const normalized = query.replace(/^["']/u, '');
  const partialDir = normalized.endsWith('/')
    ? normalized
    : path.dirname(normalized);
  const base = normalized.endsWith('/') ? '' : path.basename(normalized);
  const relativeDir = partialDir === '.' ? '' : partialDir;
  const dir = path.resolve(cwd, relativeDir);
  if (!isInside(cwd, dir)) {
    return [];
  }
  const entries = await readdir(dir, { withFileTypes: true });
  return rankCandidates(
    base,
    entries.map((entry) => entry.name),
    { limit: 8 },
  ).map((entry) => {
    const dirent = entries.find((item) => item.name === entry);
    if (dirent === undefined) {
      throw new Error(`Missing directory entry: ${entry}`);
    }
    const relativePath = path.join(relativeDir, dirent.name);
    return `@${relativePath}${dirent.isDirectory() ? '/' : ''}`;
  });
}

function currentLineBeforeCursor(input: string): string {
  return input.split('\n').at(-1) ?? '';
}

function resolvePromptPath(cwd: string, relative: string): string {
  const resolved = path.resolve(cwd, relative);
  if (!isInside(cwd, resolved)) {
    throw new Error(`Path not allowed: ${resolved}`);
  }
  return resolved;
}

function formatShellResult(
  command: string,
  result: {
    readonly exitCode: number;
    readonly stdout: string;
    readonly stderr: string;
  },
): string {
  const body = [result.stdout, result.stderr].filter(Boolean).join('\n');
  const output = body.length > 0 ? body : '<no output>';
  return `$ ${command}\nexit ${result.exitCode}\n${clip(output, 2000)}`;
}

function clip(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

function isInside(root: string, target: string): boolean {
  const relative = path.relative(path.resolve(root), path.resolve(target));
  return (
    relative === '' ||
    (!relative.startsWith('..') && !path.isAbsolute(relative))
  );
}

function isProfileName(value: string): boolean {
  return /^[A-Za-z0-9_-]+$/u.test(value);
}

function cloneProfileConfig(profile: ProfileSuiteConfig): ProfileSuiteConfig {
  return structuredClone(profile) as ProfileSuiteConfig;
}
