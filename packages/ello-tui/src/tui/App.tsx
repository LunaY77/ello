import { useApp, useInput, useStdout } from 'ink';
import React, {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';

import { cycleSessionMode } from '../api/protocol-types.js';
import { ThreadClient } from '../client/thread-client.js';

import { AgentSwitcher } from './component/AgentSwitcher.js';
import { AgentTranscript } from './component/AgentTranscript.js';
import { AppShell } from './component/AppShell.js';
import {
  Composer,
  composerTextWidthForTerminal,
} from './component/Composer.js';
import { OverlayHost } from './component/OverlayHost.js';
import { TerminalHistoryOutput } from './component/TerminalHistoryOutput.js';
import { useAgentNavigation } from './hooks/use-agent-navigation.js';
import { useAgentTasks } from './hooks/use-agent-tasks.js';
import { useCatalogs } from './hooks/use-catalogs.js';
import type { CatalogLoadState } from './hooks/use-catalogs.js';
import { useComposerState } from './hooks/use-composer-state.js';
import { useComposerSuggestions } from './hooks/use-composer-suggestions.js';
import { useOverlay } from './hooks/use-overlay.js';
import { useRequestResolution } from './hooks/use-request-resolution.js';
import {
  rewindTargets,
  useRuntimeActions,
} from './hooks/use-runtime-actions.js';
import { useRuntimeEvents } from './hooks/use-runtime-events.js';
import { useSettings } from './hooks/use-settings.js';
import { useStableInput } from './hooks/use-stable-input.js';
import { useSubmission } from './hooks/use-submission.js';
import { useThemeState } from './hooks/use-theme-state.js';
import { buildModelCatalogOptions } from './model-selectors.js';
import {
  isDisposableThread,
  isShiftTab,
  overlayForRequest,
} from './screen-utils.js';
import {
  bypassEnabledFromConfig,
  globalModelSelectionsFromConfig,
} from './settings/config.js';
import {
  agentTaskToRunView,
  terminalAgentTaskEntry,
} from './store/agent-task-view.js';
import { resolveTheme, ThemeProvider } from './theme/index.js';
import { createThreadCommandRunner } from './thread-command-runner.js';

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

/** ThreadScreen 只组合 hooks 与视图；提交、审批、配置和 runtime action 各有单一状态边界。 */
function ThreadScreen({
  thread,
  initialDraft,
  onThreadChange,
}: ThreadScreenProps): React.ReactElement {
  const runtimeEvents = useRuntimeEvents(thread);
  const onError = useCallback(
    (error: unknown) => notify(runtimeEvents.dispatch, error),
    [runtimeEvents.dispatch],
  );
  const catalogs = useCatalogs(thread);

  useEffect(() => {
    void thread.loadHistory().catch(onError);
  }, [onError, thread]);

  if (catalogs.status === 'loading') return <></>;
  if (catalogs.status === 'failed') {
    if (catalogs.error instanceof Error) throw catalogs.error;
    throw new Error(`Catalog loading failed: ${String(catalogs.error)}`);
  }
  return (
    <ReadyThreadScreen
      thread={thread}
      initialDraft={initialDraft}
      onThreadChange={onThreadChange}
      runtimeEvents={runtimeEvents}
      catalogs={catalogs}
      onError={onError}
    />
  );
}

type ReadyCatalogs = Extract<CatalogLoadState, { readonly status: 'ready' }>;
type RuntimeEvents = ReturnType<typeof useRuntimeEvents>;

function ReadyThreadScreen({
  thread,
  initialDraft,
  onThreadChange,
  runtimeEvents,
  catalogs,
  onError,
}: ThreadScreenProps & {
  readonly runtimeEvents: RuntimeEvents;
  readonly catalogs: ReadyCatalogs;
  onError(error: unknown): void;
}): React.ReactElement {
  const { exit } = useApp();
  const { stdout } = useStdout();
  const { state, workingSeconds, dispatch, queueSteer } = runtimeEvents;
  const { overlay, setOverlay } = useOverlay();
  const commitTerminalTask = useCallback(
    (task: Parameters<typeof terminalAgentTaskEntry>[0]) => {
      const entry = terminalAgentTaskEntry(task);
      if (entry !== undefined) {
        dispatch({ type: 'ui.subagent.committed', entry });
      }
    },
    [dispatch],
  );
  const agentTasks = useAgentTasks(thread, onError, commitTerminalTask);
  useEffect(() => {
    for (const task of agentTasks.tasks) commitTerminalTask(task);
  }, [agentTasks.tasks, commitTerminalTask, state.historyResetKey]);
  const { draft, setDraft, cursor, setCursor, fileSearch, setFileSearch } =
    useComposerState(initialDraft);
  const { themeName, themeEpoch, setThemeName, setThemeEpoch } =
    useThemeState(onError);
  const bypassEnabled = bypassEnabledFromConfig(catalogs.config);
  const globalModelSelections = globalModelSelectionsFromConfig(
    catalogs.config,
  );
  const modelOptions = useMemo(
    () => buildModelCatalogOptions(catalogs.models, globalModelSelections),
    [catalogs.models, globalModelSelections],
  );
  const suggestions = useComposerSuggestions({
    thread,
    draft,
    cursor,
    fileSearch,
    skills: catalogs.skills,
    setFileSearch,
    onError,
  });
  const running =
    state.status === 'running' ||
    state.status === 'awaitingApproval' ||
    state.status === 'awaitingUserInput';
  const visibleAgentTasks = agentTasks.tasks.filter((task) => {
    if (task.status === 'queued' || task.status === 'running') return true;
    if (
      agentTasks.activeView.kind === 'task' &&
      agentTasks.activeView.taskId === task.taskId
    ) {
      return true;
    }
    return (
      state.runStartedAt !== undefined &&
      Date.parse(task.createdAt) >= state.runStartedAt
    );
  });
  const submission = useSubmission({
    thread,
    state,
    running,
    draft,
    dispatch,
    queueSteer,
    setDraft,
    onError,
  });
  const pendingOverlay = overlayForRequest(
    state.pendingRequest,
    state.snapshot.plan,
  );
  const effectiveOverlay = pendingOverlay ?? overlay;
  const switchingMode = useRef(false);

  const closeCurrentThread = async (): Promise<void> => {
    const discard = isDisposableThread(state.snapshot);
    await thread.close();
    if (discard) {
      await thread.request('thread/delete', { threadId: thread.threadId });
    }
  };
  const switchThread = async (
    next: ThreadClient,
    nextDraft = '',
  ): Promise<void> => {
    await closeCurrentThread();
    onThreadChange(next, nextDraft);
  };
  const runtime = useRuntimeActions({
    thread,
    history: state.history,
    dispatch,
    setOverlay,
    switchThread,
    closeCurrentThread,
    exit,
    onError,
  });

  const { submitPrompt } = createThreadCommandRunner({
    thread,
    state,
    catalogs,
    runtime,
    dispatch,
    setOverlay,
    submitText: submission.submitText,
  });
  const requests = useRequestResolution({
    thread,
    dispatch,
    onError,
    submitPrompt,
  });
  const settings = useSettings({
    thread,
    themeName,
    setConfig: catalogs.setConfig,
    setOverlay,
    setThemeName,
    setThemeEpoch,
  });

  const handleCancel = (): void => {
    if (runtime.cancelCompaction()) return;
    if (submission.cancel()) return;
    void closeCurrentThread().then(exit).catch(onError);
  };
  useStableInput((input, key) => {
    if (effectiveOverlay.type === 'none' || !key.ctrl || input !== 'c') return;
    handleCancel();
  });
  useAgentNavigation({
    thread,
    agentTasks,
    visibleTasks: visibleAgentTasks,
    overlay: effectiveOverlay,
    running,
    setOverlay,
    onError,
  });
  useInput(
    (input, key) => {
      if (
        effectiveOverlay.type !== 'none' ||
        agentTasks.focus !== 'composer' ||
        !isShiftTab(input, key) ||
        switchingMode.current
      ) {
        return;
      }
      switchingMode.current = true;
      void thread
        .setMode(cycleSessionMode(state.settings.mode, bypassEnabled))
        .catch(onError)
        .finally(() => {
          switchingMode.current = false;
        });
    },
    { isActive: true },
  );

  const selectedModel = selectedModelForAgent(
    catalogs.agents,
    state.settings.agent,
    globalModelSelections,
  );
  const contextWindow = modelContextWindow(catalogs.models, selectedModel);
  const contextPercent = contextRemainingPercent(
    contextWindow,
    state.usage.lastInputTokens,
  );
  const ctrlCInterrupts =
    running || submission.submissionPending || runtime.compactionRunning;
  const taskRunViews = agentTasks.tasks.map(agentTaskToRunView);
  const runningTaskViews = taskRunViews.filter(
    (task) => task.status === 'queued' || task.status === 'running',
  );
  useEffect(() => {
    if (
      visibleAgentTasks.length === 0 &&
      agentTasks.focus === 'agent-switcher'
    ) {
      agentTasks.setFocus('composer');
    }
  }, [agentTasks, visibleAgentTasks.length]);
  return (
    <ThemeProvider theme={resolveTheme(themeName)}>
      <TerminalHistoryOutput
        entries={agentTasks.activeView.kind === 'main' ? state.history : []}
        resetKey={
          state.historyResetKey + themeEpoch + agentTasks.viewEpoch * 1_000_000
        }
        cwd={thread.cwd}
        settings={state.settings}
      />
      <AppShell
        cwd={thread.cwd}
        model={`primary: ${globalModelSelections.primaryModel} · auxiliary: ${globalModelSelections.auxiliaryModel}`}
        mode={{ mode: state.settings.mode }}
        {...(contextPercent === undefined ? {} : { contextPercent })}
        {...(contextWindow === undefined ? {} : { contextWindow })}
        pendingPlanApproval={effectiveOverlay.type === 'plan-approval'}
        liveAssistantText={state.live.assistantText}
        liveReasoningText={state.live.reasoningText}
        liveCompactionText={state.live.compactionText}
        runningTools={[...state.live.runningTools.values()]}
        runningSubagents={
          agentTasks.activeView.kind === 'main'
            ? runningTaskViews
            : [...state.live.runningSubagents.values()]
        }
        running={
          agentTasks.activeTask === undefined
            ? running
            : agentTasks.activeTask.status === 'running'
        }
        {...(workingSeconds === undefined ? {} : { workingSeconds })}
        {...(state.interruptNotice === undefined
          ? {}
          : { interruptNotice: state.interruptNotice })}
        pendingSteers={state.pendingSteers.map((steer) => steer.text)}
        usage={agentTasks.activeTask?.usage ?? state.usage}
        {...(state.goal === undefined ? {} : { goal: state.goal })}
        overlay={
          <OverlayHost
            overlay={effectiveOverlay}
            {...(requests.resolvingRequestId === undefined
              ? {}
              : { resolvingRequestId: requests.resolvingRequestId })}
            onApprove={requests.onApprove}
            onResolveUserInput={requests.onResolveUserInput}
            onAcceptPlan={requests.onAcceptPlan}
            onChatAboutPlan={requests.onChatAboutPlan}
            onDenyPlan={requests.onDenyPlan}
            onClosePlanPreview={() => setOverlay({ type: 'none' })}
            onSelectModelSelector={(selector) => {
              setOverlay({
                type: 'models',
                selector,
                title: `Select ${selector}`,
                options: modelOptions,
              });
            }}
            onSelectModel={(model) => {
              if (effectiveOverlay.type !== 'models') {
                throw new Error('Model selection requires a model overlay.');
              }
              void thread
                .request('config/write', {
                  cwd: thread.cwd,
                  source: 'global',
                  path: [effectiveOverlay.selector],
                  operation: 'set',
                  value: model,
                })
                .then((result) => {
                  catalogs.setConfig(result.config);
                  setOverlay({ type: 'none' });
                })
                .catch(onError);
            }}
            onSelectSession={(threadId) => {
              void thread.resume(threadId).then(switchThread).catch(onError);
            }}
            onSelectRewind={(entryId) => {
              const target = rewindTargets(state.history).find(
                (candidate) => candidate.entryId === entryId,
              );
              if (target !== undefined) {
                void runtime.rewindToTarget(target).catch(onError);
              }
            }}
            onUpdateSetting={settings.updateSetting}
            onConfirmAgentStop={(taskId) => {
              void agentTasks.client
                ?.stop(taskId)
                .then(() => setOverlay({ type: 'none' }))
                .catch(onError);
            }}
            onCancelAgentStop={() => setOverlay({ type: 'none' })}
          />
        }
        agentTranscript={
          agentTasks.activeTask === undefined ? undefined : (
            <AgentTranscript
              task={agentTasks.activeTask}
              {...(agentTasks.activeDetail === undefined
                ? {}
                : { detail: agentTasks.activeDetail })}
            />
          )
        }
        agentSwitcher={
          <AgentSwitcher
            tasks={visibleAgentTasks}
            activeView={agentTasks.activeView}
            focus={agentTasks.focus}
            highlightedTaskId={agentTasks.highlightedTaskId}
          />
        }
        composer={
          <Composer
            isActive={
              effectiveOverlay.type === 'none' &&
              agentTasks.focus === 'composer'
            }
            running={
              agentTasks.activeTask === undefined
                ? ctrlCInterrupts
                : agentTasks.activeTask.status === 'running'
            }
            history={submission.inputHistory}
            {...(agentTasks.activeTask === undefined &&
            suggestions !== undefined
              ? { suggestions }
              : {})}
            {...(agentTasks.activeTask === undefined
              ? {}
              : {
                  target:
                    agentTasks.activeTask.name ??
                    agentTasks.activeTask.definitionName,
                })}
            value={draft}
            textWidth={composerTextWidthForTerminal(stdout.columns ?? 100)}
            onChange={(value, nextCursor) => {
              setDraft(value);
              setCursor(nextCursor);
            }}
            onSuggestionAccepted={() => undefined}
            onSubmit={(value) => {
              submission.rememberInput(value);
              if (agentTasks.activeTask === undefined) {
                void submitPrompt(value).catch(onError);
              } else if (agentTasks.activeTask.status === 'running') {
                void agentTasks.client
                  ?.steer(value, agentTasks.activeTask.taskId)
                  .catch(onError);
              } else {
                onError(
                  new Error(
                    `Agent task ${agentTasks.activeTask.taskId} is ${agentTasks.activeTask.status}; resume it explicitly.`,
                  ),
                );
              }
            }}
            onCancel={handleCancel}
            onEscape={() => undefined}
            onMovePastEnd={() => {
              if (visibleAgentTasks.length > 0) {
                agentTasks.setHighlightedTaskId(
                  agentTasks.activeView.kind === 'task'
                    ? agentTasks.activeView.taskId
                    : visibleAgentTasks[0]!.taskId,
                );
                agentTasks.setFocus('agent-switcher');
                return true;
              }
              return false;
            }}
          />
        }
      />
    </ThemeProvider>
  );
}

function contextRemainingPercent(
  contextWindow: number | undefined,
  used: number | undefined,
): number | undefined {
  if (used === undefined || contextWindow === undefined) return undefined;
  return Math.max(
    0,
    Math.round(((contextWindow - used) / contextWindow) * 100),
  );
}

function modelContextWindow(
  models: readonly {
    readonly id: string;
    readonly metadata: Record<string, unknown>;
  }[],
  model: string,
): number | undefined {
  const selected = models.find((entry) => entry.id === model);
  const contextWindow = selected?.metadata.contextWindow;
  return typeof contextWindow === 'number' && contextWindow > 0
    ? contextWindow
    : undefined;
}

function selectedModelForAgent(
  agents: ReadyCatalogs['agents'],
  agentName: string,
  references: {
    readonly primaryModel: string;
    readonly auxiliaryModel: string;
  },
): string {
  const agent = agents.find((entry) => entry.id === agentName);
  if (agent === undefined) {
    throw new Error(`Selected Agent is absent from the catalog: ${agentName}`);
  }
  const selector = agent.metadata.model;
  if (selector === 'primary_model') return references.primaryModel;
  if (selector === 'auxiliary_model') return references.auxiliaryModel;
  throw new Error(`Agent ${agentName} has an invalid model selector.`);
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
