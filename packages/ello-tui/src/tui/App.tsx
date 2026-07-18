import { relative } from 'node:path';

import { useApp, useInput } from 'ink';
import React, { useEffect, useMemo, useRef, useState } from 'react';

import { cycleSessionMode } from '../api/protocol-types.js';
import type {
  AgentCatalogEntry,
  AgentSkill,
  ApprovalDecision,
  CatalogEntry,
  Plan,
  Task,
  UserInput,
  UserInputResolution,
} from '../api/protocol-types.js';
import type { ClientServerRequest } from '../api/server-requests.js';
import {
  handleSlashCommand,
  type CommandResult,
} from '../cli/slash-commands.js';
import { ThreadClient } from '../client/thread-client.js';
import {
  loadLocalUiConfig,
  saveLocalUiConfig,
} from '../config/local-ui-config.js';

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
  buildModelCatalogOptions,
  buildProfileSelectorOptions,
} from './model-selectors.js';
import {
  PROFILE_ROLES,
  type ProfileRole,
  type TuiProfile,
} from './profile-types.js';
import { detectTrigger } from './store/autocomplete.js';
import type { HistoryEntry } from './store/history-entry.js';
import {
  defaultThemeName,
  resolveTheme,
  ThemeProvider,
  type ThemeName,
} from './theme/index.js';

const NO_FILE_SUGGESTIONS: readonly string[] = [];

export interface AppProps {
  readonly thread: ThreadClient;
}

/** 根组件只负责切换不可变 ThreadClient；每个 thread 用独立 subtree 保证历史不会串线。 */
export function App({ thread }: AppProps): React.ReactElement {
  return <ActiveThread key={thread.threadId} initialThread={thread} />;
}

function ActiveThread({
  initialThread,
}: {
  readonly initialThread: ThreadClient;
}): React.ReactElement {
  const [active, setActive] = useState({ thread: initialThread, draft: '' });
  return (
    <ThreadScreen
      key={active.thread.threadId}
      thread={active.thread}
      initialDraft={active.draft}
      onThreadChange={(next, draft = '') => setActive({ thread: next, draft })}
    />
  );
}

interface ThreadScreenProps {
  readonly thread: ThreadClient;
  readonly initialDraft: string;
  onThreadChange(thread: ThreadClient, draft?: string): void;
}

function ThreadScreen({
  thread,
  initialDraft,
  onThreadChange,
}: ThreadScreenProps): React.ReactElement {
  const { exit } = useApp();
  const { state, workingSeconds, dispatch, queueSteer } =
    useRuntimeEvents(thread);
  const [overlay, setOverlay] = useState<OverlayState>({ type: 'none' });
  const [draft, setDraft] = useState(initialDraft);
  const [cursor, setCursor] = useState({ line: 0, column: 0 });
  const [themeName, setThemeName] = useState<ThemeName>(defaultThemeName);
  const [models, setModels] = useState<readonly CatalogEntry[]>([]);
  const [providers, setProviders] = useState<readonly CatalogEntry[]>([]);
  const [skills, setSkills] = useState<readonly AgentSkill[]>([]);
  const [agents, setAgents] = useState<readonly AgentCatalogEntry[]>([]);
  const [tasks, setTasks] = useState<readonly Task[]>([]);
  const [profiles, setProfiles] = useState<readonly TuiProfile[]>([]);
  const [config, setConfig] = useState<unknown>();
  const resolvingRequests = useRef(new Set<string>());
  const switchingMode = useRef(false);
  const [resolvingRequestId, setResolvingRequestId] = useState<string>();
  const [fileSearch, setFileSearch] = useState<{
    readonly query: string;
    readonly suggestions: readonly string[];
  }>();

  const activeTrigger = detectTrigger(currentLineBeforeCursor(draft, cursor));
  const fileSuggestions =
    activeTrigger?.kind === 'file' && fileSearch?.query === activeTrigger.query
      ? fileSearch.suggestions
      : NO_FILE_SUGGESTIONS;
  const suggestions = useMemo(
    () =>
      completeInput(
        draft,
        models.map((model) => model.id),
        fileSuggestions,
        skills,
        cursor,
      ),
    [cursor, draft, fileSuggestions, models, skills],
  );
  const modelOptions = useMemo(
    () => buildModelCatalogOptions(models, providers),
    [models, providers],
  );
  const activeProfile = activeProfileFromConfig(config);
  const bypassEnabled = bypassEnabledFromConfig(config);
  const profileOptions = useMemo(
    () => buildProfileSelectorOptions(profiles, activeProfile),
    [activeProfile, profiles],
  );

  useEffect(() => {
    void thread
      .loadHistory()
      .catch((error: unknown) => notify(dispatch, error));
    void loadCatalogs(thread)
      .then((loaded) => {
        setModels(loaded.models);
        setProviders(loaded.providers);
        setSkills(loaded.skills);
        setAgents(loaded.agents);
        setTasks(loaded.tasks);
        setProfiles(loaded.profiles);
        setConfig(loaded.config);
      })
      .catch((error: unknown) => notify(dispatch, error));
  }, [dispatch, thread]);

  useEffect(() => {
    void loadLocalUiConfig()
      .then((local) => setThemeName(local.theme))
      .catch((error: unknown) => notify(dispatch, error));
  }, [dispatch]);

  useEffect(() => {
    if (activeTrigger?.kind !== 'file') return;
    const query = activeTrigger.query;
    let live = true;
    void thread
      .request('fs/search', { cwd: thread.cwd, query, kind: 'any', limit: 20 })
      .then((result) => {
        if (!live) return;
        setFileSearch({
          query,
          suggestions: result.data.map(
            (entry) => `@${displayFilePath(entry.path, thread.cwd)}`,
          ),
        });
      })
      .catch((error: unknown) => {
        if (live) notify(dispatch, error);
      });
    return () => {
      live = false;
    };
  }, [activeTrigger?.kind, activeTrigger?.query, dispatch, thread]);

  const pendingOverlay = overlayForRequest(
    state.pendingRequest,
    state.snapshot.plan,
  );
  const effectiveOverlay = pendingOverlay ?? overlay;
  const running =
    state.status === 'running' ||
    state.status === 'awaitingApproval' ||
    state.status === 'awaitingUserInput';

  useInput(
    (_input, key) => {
      if (!key.escape) return;
      if (effectiveOverlay.type !== 'none') {
        setOverlay({ type: 'none' });
        return;
      }
      if (running)
        void thread
          .interrupt('user interrupted from TUI')
          .catch((error: unknown) => notify(dispatch, error));
    },
    { isActive: true },
  );

  useInput(
    (input, key) => {
      if (
        effectiveOverlay.type !== 'none' ||
        !isShiftTab(input, key) ||
        switchingMode.current
      ) {
        return;
      }
      switchingMode.current = true;
      const mode = cycleSessionMode(state.settings.mode, bypassEnabled);
      void thread
        .setMode(mode)
        .catch((error: unknown) => notify(dispatch, error))
        .finally(() => {
          switchingMode.current = false;
        });
    },
    { isActive: true },
  );

  const submitPrompt = async (value: string): Promise<void> => {
    const trimmed = value.trim();
    if (trimmed === '') return;
    if (trimmed.startsWith('/')) {
      const parsed = handleSlashCommand(trimmed);
      if (parsed.command !== undefined) await runCommand(parsed.command);
      else if (parsed.output !== '')
        dispatch({ type: 'ui.message', text: parsed.output });
      return;
    }
    if (trimmed.startsWith('!')) {
      await runShellCommand(trimmed.slice(1).trim());
      return;
    }
    const input = await resolveUserInput(value);
    if (running) {
      queueSteer(value);
      await thread.steerInput(input);
    } else {
      await thread.submitInput(input);
    }
  };

  const runShellCommand = async (command: string): Promise<void> => {
    if (command === '') return;
    try {
      const result = await thread.request('thread/shellCommand', {
        threadId: thread.threadId,
        command,
      });
      const output = [result.stdout, result.stderr]
        .filter((part) => part !== '')
        .join('\n');
      dispatch({
        type: 'ui.message',
        text: `$ ${command}\n${output || `exit ${result.exitCode}`}`,
        level: result.exitCode === 0 ? 'info' : 'error',
      });
    } catch (error: unknown) {
      notify(dispatch, error);
    }
  };

  const runCommand = async (command: CommandResult): Promise<void> => {
    try {
      switch (command.type) {
        case 'message':
          dispatch({ type: 'ui.message', text: command.message });
          return;
        case 'submit':
          await submitPrompt(command.prompt);
          return;
        case 'set-mode':
          await thread.setMode(command.mode);
          return;
        case 'set-profile':
          await thread.setProfile(command.profile);
          return;
        case 'open-overlay':
          await openOverlay(command.overlay);
          return;
        case 'runtime-action':
          await runRuntimeAction(command.action, command.args ?? []);
          return;
      }
    } catch (error: unknown) {
      notify(dispatch, error);
    }
  };

  const openOverlay = async (
    name: Extract<CommandResult, { type: 'open-overlay' }>['overlay'],
  ): Promise<void> => {
    switch (name) {
      case 'help':
        setOverlay({ type: 'help' });
        return;
      case 'models':
        setOverlay({
          type: 'models',
          title: 'Model catalog',
          options: modelOptions,
        });
        return;
      case 'profiles':
        setOverlay({ type: 'profiles', options: profileOptions });
        return;
      case 'settings':
        setOverlay({ type: 'settings', config });
        return;
      case 'theme':
        setOverlay({ type: 'theme', active: themeName });
        return;
      case 'agents':
        setOverlay({ type: 'agents', agents });
        return;
      case 'skills':
        setOverlay({ type: 'skills', skills });
        return;
      case 'tasks':
        setOverlay({ type: 'tasks', tasks });
        return;
      case 'workspace': {
        const result = await thread.request('workspace/list', {});
        setOverlay({ type: 'workspace', workspaces: result.data });
        return;
      }
      case 'session-selector': {
        const result = await thread.request('thread/list', {
          cwd: thread.cwd,
          archived: false,
          limit: 50,
        });
        setOverlay({ type: 'session-selector', sessions: result.data });
        return;
      }
      case 'rewind-selector':
        setOverlay({
          type: 'rewind-selector',
          targets: rewindTargets(state.history),
        });
        return;
      case 'permission-rules':
        dispatch({
          type: 'ui.message',
          text: 'Permission decisions are owned by the App Server.',
        });
        return;
    }
  };

  const runRuntimeAction = async (
    action: Extract<CommandResult, { type: 'runtime-action' }>['action'],
    args: readonly string[],
  ): Promise<void> => {
    switch (action) {
      case 'clear':
        await switchThread(await thread.startNewThread());
        return;
      case 'compact': {
        const result = await thread.request('thread/compact/start', {
          threadId: thread.threadId,
        });
        dispatch({
          type: 'ui.message',
          text: `Compaction job ${result.jobId} started.`,
        });
        return;
      }
      case 'new-thread':
        await switchThread(await thread.startNewThread());
        return;
      case 'fork':
        await switchThread(await thread.fork(args[0]));
        return;
      case 'rewind':
        if (args[0] === undefined) {
          setOverlay({
            type: 'rewind-selector',
            targets: rewindTargets(state.history),
          });
        } else {
          const target = rewindTargets(state.history).find(
            (candidate) => candidate.entryId === args[0],
          );
          if (target === undefined) {
            throw new Error(`Unknown rewind target ${args[0]}.`);
          }
          await rewindToTarget(target);
        }
        return;
      case 'memory': {
        if (args[0] === 'reload')
          await thread.request('memory/reload', {
            cwd: thread.cwd,
            threadId: thread.threadId,
          });
        const result = await thread.request('memory/status', {
          cwd: thread.cwd,
          threadId: thread.threadId,
        });
        dispatch({
          type: 'ui.message',
          text: `memory ${result.state}, ${result.pendingJobs} pending job(s)`,
        });
        return;
      }
      case 'dream': {
        const result = await thread.request('memory/dream/start', {
          cwd: thread.cwd,
          threadId: thread.threadId,
        });
        dispatch({
          type: 'ui.message',
          text: `Memory dream job ${result.jobId} started.`,
        });
        return;
      }
      case 'goal':
        await runGoal(args);
        return;
      case 'export': {
        const format =
          args[0] === 'jsonl' || args[0] === 'html' || args[0] === 'markdown'
            ? args[0]
            : 'markdown';
        const result = await thread.request('thread/export', {
          threadId: thread.threadId,
          format,
        });
        dispatch({
          type: 'ui.message',
          text:
            result.kind === 'inline'
              ? result.content
              : `Export artifact ${result.artifactId} (${result.byteCount} bytes).`,
        });
        return;
      }
      case 'quit':
        await thread.close();
        exit();
        return;
    }
  };

  const runGoal = async (args: readonly string[]): Promise<void> => {
    const operation = args[0] ?? 'get';
    if (operation === 'get') {
      const result = await thread.request('thread/goal/get', {
        threadId: thread.threadId,
      });
      dispatch({
        type: 'ui.message',
        text:
          result.goal === null
            ? 'No active goal.'
            : `${result.goal.status}: ${result.goal.objective}`,
      });
    } else if (operation === 'clear') {
      await thread.request('thread/goal/clear', { threadId: thread.threadId });
    } else if (operation === 'set' && args.length > 1) {
      await thread.request('thread/goal/set', {
        threadId: thread.threadId,
        objective: args.slice(1).join(' '),
      });
    } else {
      throw new Error('Usage: /goal <get|set <objective>|clear>.');
    }
  };

  const resolveUserInput = async (
    value: string,
  ): Promise<readonly UserInput[]> => {
    const matches = [...value.matchAll(/(^|\s)@([^\s]+)/gu)];
    if (matches.length === 0) return [{ type: 'text', text: value }];
    const files: UserInput[] = [];
    let text = value;
    for (const match of matches) {
      const query = match[2];
      if (query === undefined) continue;
      const result = await thread.request('fs/search', {
        cwd: thread.cwd,
        query,
        kind: 'any',
        limit: 50,
      });
      const found = result.data.find(
        (entry) => entry.path.endsWith(`/${query}`) || entry.name === query,
      );
      if (found === undefined) continue;
      files.push({
        type: 'file',
        path: found.path,
        displayName: displayFilePath(found.path, thread.cwd),
      });
      text = text.replace(match[0], match[1] ?? '');
    }
    return text.trim() === ''
      ? files
      : [{ type: 'text', text: text.trim() }, ...files];
  };

  const onApprove = (requestId: string, decision: ApprovalDecision): void => {
    if (!beginRequestResolution(requestId)) return;
    void thread
      .approve(requestId, decision.decision)
      .then(() => dispatch({ type: 'interaction.resolved', requestId }))
      .catch((error: unknown) => notify(dispatch, error))
      .finally(() => finishRequestResolution(requestId));
  };
  const onResolveUserInput = (
    requestId: string,
    resolution: UserInputResolution,
  ): void => {
    if (!beginRequestResolution(requestId)) return;
    void thread
      .resolveUserInput(requestId, resolution)
      .then(() =>
        dispatch({ type: 'interaction.resolved', requestId, resolution }),
      )
      .catch((error: unknown) => notify(dispatch, error))
      .finally(() => finishRequestResolution(requestId));
  };
  const beginRequestResolution = (requestId: string): boolean => {
    if (resolvingRequests.current.has(requestId)) return false;
    resolvingRequests.current.add(requestId);
    setResolvingRequestId(requestId);
    return true;
  };
  const finishRequestResolution = (requestId: string): void => {
    resolvingRequests.current.delete(requestId);
    setResolvingRequestId((current) =>
      current === requestId ? undefined : current,
    );
  };
  const onAcceptPlan = (requestId: string): void =>
    onApprove(requestId, { decision: 'accept' });
  const onDenyPlan = (requestId: string): void =>
    onApprove(requestId, { decision: 'decline' });
  const onChatAboutPlan = (requestId: string, prompt: string): void => {
    void thread
      .approve(requestId, 'decline')
      .then(() => submitPrompt(prompt))
      .catch((error: unknown) => notify(dispatch, error));
  };

  const switchThread = async (
    next: ThreadClient,
    nextDraft = '',
  ): Promise<void> => {
    await thread.close();
    onThreadChange(next, nextDraft);
  };

  const rewindToTarget = async (target: RewindTarget): Promise<void> => {
    const next = await thread.fork(target.turnId);
    await switchThread(next, target.text);
  };

  const applyConfig = (value: unknown): readonly TuiProfile[] => {
    const nextProfiles = profilesFromConfig(value);
    setConfig(value);
    setProfiles(nextProfiles);
    return nextProfiles;
  };

  const writeGlobalConfig = async (
    path: readonly string[],
    operation: 'set' | 'delete',
    value?: unknown,
  ): Promise<readonly TuiProfile[]> => {
    const result = await thread.request('config/write', {
      cwd: thread.cwd,
      source: 'global',
      path,
      operation,
      ...(operation === 'set' ? { value } : {}),
    });
    return applyConfig(result.config);
  };

  const showProfiles = (
    items: readonly TuiProfile[],
    selectedProfile = activeProfile,
  ): void => {
    setOverlay({
      type: 'profiles',
      options: buildProfileSelectorOptions(items, selectedProfile),
    });
  };

  const openProfiles = (): void => showProfiles(profiles);

  const showProfile = (items: readonly TuiProfile[], name: string): void => {
    const profile = items.find((candidate) => candidate.name === name);
    if (profile === undefined) throw new Error(`Unknown profile ${name}.`);
    setOverlay({
      type: 'profile-detail',
      profile,
      options: profileRoleOptions(profile),
    });
  };

  const openProfile = (name: string): void => showProfile(profiles, name);

  const createProfile = (sourceProfile: string): void => {
    setOverlay({ type: 'profile-create', sourceProfile });
  };

  const submitNewProfile = (name: string, sourceProfile: string): void => {
    const source = profiles.find(
      (candidate) => candidate.name === sourceProfile,
    );
    if (source === undefined) {
      notify(dispatch, new Error(`Unknown source profile ${sourceProfile}.`));
      return;
    }
    if (profiles.some((candidate) => candidate.name === name)) {
      notify(dispatch, new Error(`Profile ${name} already exists.`));
      return;
    }
    void writeGlobalConfig(['profile', name], 'set', source.raw)
      .then((items) => showProfile(items, name))
      .catch((error: unknown) => notify(dispatch, error));
  };

  const requestDeleteProfile = (profile: string): void => {
    setOverlay({ type: 'profile-delete-confirm', profile });
  };

  const confirmDeleteProfile = (profile: string): void => {
    if (profile === activeProfile || profile === state.settings.profile) {
      notify(dispatch, new Error('The active profile cannot be deleted.'));
      return;
    }
    void writeGlobalConfig(['profile', profile], 'delete')
      .then(showProfiles)
      .catch((error: unknown) => notify(dispatch, error));
  };

  const activateProfile = (profile: string): void => {
    void writeGlobalConfig(['active_profile'], 'set', profile)
      .then((items) => showProfiles(items, profile))
      .catch((error: unknown) => notify(dispatch, error));
  };

  const selectProfileRole = (profileName: string, role: ProfileRole): void => {
    setOverlay({
      type: 'profile-model-catalog',
      target: { profileName, role },
      options: modelOptions,
    });
  };

  const bindProfileRoleModel = (
    profileName: string,
    role: ProfileRole,
    model: string,
  ): void => {
    void writeGlobalConfig(
      ['profile', profileName, 'models', role],
      'set',
      model,
    )
      .then((items) => showProfile(items, profileName))
      .catch((error: unknown) => notify(dispatch, error));
  };

  const saveProfile = (profileName: string): void => {
    void thread
      .request('config/read', { cwd: thread.cwd, includeSources: false })
      .then((result) => {
        showProfile(applyConfig(result.config), profileName);
      })
      .catch((error: unknown) => notify(dispatch, error));
  };

  const onEscape = (): void => {
    if (effectiveOverlay.type !== 'none') setOverlay({ type: 'none' });
    else if (running)
      void thread
        .interrupt('user interrupted from TUI')
        .catch((error: unknown) => notify(dispatch, error));
  };

  return (
    <ThemeProvider theme={resolveTheme(themeName)}>
      <TerminalHistoryOutput
        entries={state.history}
        resetKey={state.historyResetKey}
        cwd={thread.cwd}
        settings={state.settings}
      />
      <AppShell
        cwd={thread.cwd}
        profile={state.settings.profile}
        mode={{ mode: state.settings.mode }}
        pendingPlanApproval={effectiveOverlay.type === 'plan-approval'}
        liveAssistantText={state.live.assistantText}
        runningTools={[...state.live.runningTools.values()]}
        runningSubagents={[...state.live.runningSubagents.values()]}
        running={running}
        {...(workingSeconds === undefined ? {} : { workingSeconds })}
        {...(state.interruptNotice === undefined
          ? {}
          : { interruptNotice: state.interruptNotice })}
        pendingSteers={state.pendingSteers}
        usage={state.usage}
        {...(state.goal === undefined ? {} : { goal: state.goal })}
        overlay={
          <OverlayHost
            overlay={effectiveOverlay}
            {...(resolvingRequestId === undefined
              ? {}
              : { resolvingRequestId })}
            onApprove={onApprove}
            onResolveUserInput={onResolveUserInput}
            onAcceptPlan={onAcceptPlan}
            onChatAboutPlan={onChatAboutPlan}
            onDenyPlan={onDenyPlan}
            onClosePlanPreview={() => setOverlay({ type: 'none' })}
            onSelectModel={(model) => {
              void thread
                .setModel(model)
                .then(() => setOverlay({ type: 'none' }))
                .catch((error: unknown) => notify(dispatch, error));
            }}
            onSelectProfile={openProfile}
            onCreateProfile={createProfile}
            onRequestDeleteProfile={requestDeleteProfile}
            onConfirmDeleteProfile={confirmDeleteProfile}
            onActivateProfile={activateProfile}
            onSubmitNewProfile={submitNewProfile}
            onSelectProfileRole={selectProfileRole}
            onBindProfileRoleModel={bindProfileRoleModel}
            onSaveProfile={saveProfile}
            onSelectSession={(threadId) => {
              void thread
                .resume(threadId)
                .then(switchThread)
                .catch((error: unknown) => notify(dispatch, error));
            }}
            onSelectRewind={(entryId) => {
              const target = rewindTargets(state.history).find(
                (candidate) => candidate.entryId === entryId,
              );
              if (target !== undefined) {
                void rewindToTarget(target).catch((error: unknown) =>
                  notify(dispatch, error),
                );
              }
            }}
            onSelectTheme={(name) => {
              void loadLocalUiConfig()
                .then((local) => saveLocalUiConfig({ ...local, theme: name }))
                .then(() => {
                  setThemeName(name);
                  setOverlay({ type: 'none' });
                })
                .catch((error: unknown) => notify(dispatch, error));
            }}
            onOpenProfiles={openProfiles}
          />
        }
        composer={
          <Composer
            isActive={effectiveOverlay.type === 'none'}
            running={running}
            {...(suggestions === undefined ? {} : { suggestions })}
            value={draft}
            onChange={(value, nextCursor) => {
              setDraft(value);
              setCursor(nextCursor);
            }}
            onSuggestionAccepted={() => undefined}
            onSubmit={(value) => {
              void submitPrompt(value).catch((error: unknown) =>
                notify(dispatch, error),
              );
            }}
            onCancel={() => {
              if (running)
                void thread
                  .interrupt('user cancelled')
                  .catch((error: unknown) => notify(dispatch, error));
              else
                void thread
                  .close()
                  .then(exit)
                  .catch((error: unknown) => notify(dispatch, error));
            }}
            onEscape={onEscape}
          />
        }
      />
    </ThemeProvider>
  );
}

function overlayForRequest(
  request: ClientServerRequest | undefined,
  plan: Plan | null,
): OverlayState | undefined {
  if (request === undefined) return undefined;
  if (request.method === 'item/tool/requestUserInput')
    return { type: 'user-input', request };
  if (request.method === 'item/plan/requestApproval' && plan !== null)
    return { type: 'plan-approval', request, plan };
  return { type: 'approval', request };
}

function rewindTargets(
  entries: readonly HistoryEntry[],
): readonly RewindTarget[] {
  return entries
    .filter(
      (entry): entry is Extract<HistoryEntry, { kind: 'user' }> =>
        entry.kind === 'user',
    )
    .map((entry, index) => ({
      entryId: entry.id,
      turnId: entry.turnId,
      index,
      text: entry.text,
    }));
}

async function loadCatalogs(thread: ThreadClient): Promise<{
  readonly models: readonly CatalogEntry[];
  readonly providers: readonly CatalogEntry[];
  readonly skills: readonly AgentSkill[];
  readonly agents: readonly AgentCatalogEntry[];
  readonly tasks: readonly Task[];
  readonly profiles: readonly TuiProfile[];
  readonly config: unknown;
}> {
  const [models, providers, skills, agents, tasks, config] = await Promise.all([
    thread.request('model/list', { cwd: thread.cwd }),
    thread.request('provider/list', { cwd: thread.cwd }),
    thread.request('skills/list', {
      cwd: thread.cwd,
      threadId: thread.threadId,
    }),
    thread.request('agent/list', {
      cwd: thread.cwd,
      threadId: thread.threadId,
    }),
    thread.request('task/list', { limit: 50 }),
    thread.request('config/read', { cwd: thread.cwd, includeSources: false }),
  ]);
  return {
    models: models.data,
    providers: providers.data,
    skills: skills.data,
    agents: agents.data,
    tasks: tasks.data,
    profiles: profilesFromConfig(config.config),
    config: config.config,
  };
}

function profilesFromConfig(config: unknown): readonly TuiProfile[] {
  if (typeof config !== 'object' || config === null) return [];
  const profiles = (config as Record<string, unknown>).profile;
  if (typeof profiles !== 'object' || profiles === null) return [];
  return Object.entries(profiles as Record<string, unknown>).map(
    ([name, value]) => parseProfile(name, value),
  );
}

function activeProfileFromConfig(config: unknown): string | undefined {
  if (typeof config !== 'object' || config === null) return undefined;
  const activeProfile = (config as Record<string, unknown>).active_profile;
  return typeof activeProfile === 'string' ? activeProfile : undefined;
}

function bypassEnabledFromConfig(config: unknown): boolean {
  return (
    typeof config === 'object' &&
    config !== null &&
    (config as Record<string, unknown>).bypass_enabled === true
  );
}

function isShiftTab(
  input: string,
  key: { readonly tab?: boolean; readonly shift?: boolean },
): boolean {
  return input === '\u001b[Z' || (key.tab === true && key.shift === true);
}

function parseProfile(name: string, value: unknown): TuiProfile {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error(`Profile ${name} is not an object.`);
  }
  const raw = value as Record<string, unknown>;
  const models = raw.models;
  if (typeof models !== 'object' || models === null || Array.isArray(models)) {
    throw new Error(`Profile ${name} has no model bindings.`);
  }
  const bindings = models as Record<string, unknown>;
  const parsedModels = Object.fromEntries(
    PROFILE_ROLES.map((role) => {
      const model = bindings[role];
      if (typeof model !== 'string' || model.length === 0) {
        throw new Error(`Profile ${name} has no ${role} model.`);
      }
      return [role, model];
    }),
  ) as Record<ProfileRole, string>;
  return {
    id: name,
    name,
    ...(typeof raw.label === 'string' ? { label: raw.label } : {}),
    ...(typeof raw.description === 'string'
      ? { description: raw.description }
      : {}),
    models: parsedModels,
    raw,
  };
}

function profileRoleOptions(profile: TuiProfile) {
  return PROFILE_ROLES.map((role) => ({
    value: role,
    label: `${role.padEnd(8)} ${profile.models[role]}`,
  }));
}

function currentLineBeforeCursor(
  value: string,
  cursor: { readonly line: number; readonly column: number },
): string {
  return (value.split('\n')[cursor.line] ?? '').slice(0, cursor.column);
}

function displayFilePath(filePath: string, cwd: string): string {
  const result = relative(cwd, filePath);
  return result === '' ? '.' : result;
}

function notify(
  dispatch: ReturnType<typeof useRuntimeEvents>['dispatch'],
  error: unknown,
): void {
  dispatch({
    type: 'ui.message',
    level: 'error',
    text: error instanceof Error ? error.message : String(error),
  });
}
