import { useApp, useInput } from 'ink';
import React, {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';

import { cycleSessionMode } from '../api/protocol-types.js';
import { ThreadClient } from '../client/thread-client.js';

import { AppShell } from './component/AppShell.js';
import { Composer } from './component/Composer.js';
import { OverlayHost } from './component/OverlayHost.js';
import { TerminalHistoryOutput } from './component/TerminalHistoryOutput.js';
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
  const { state, workingSeconds, dispatch, queueSteer } = runtimeEvents;
  const { overlay, setOverlay } = useOverlay();
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
  useInput(
    (_input, key) => {
      if (!key.escape) return;
      if (effectiveOverlay.type !== 'none') {
        setOverlay({ type: 'none' });
      } else if (running) {
        void thread.interrupt('user interrupted from TUI').catch(onError);
      }
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
  return (
    <ThemeProvider theme={resolveTheme(themeName)}>
      <TerminalHistoryOutput
        entries={state.history}
        resetKey={state.historyResetKey + themeEpoch}
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
        runningSubagents={[...state.live.runningSubagents.values()]}
        running={running}
        {...(workingSeconds === undefined ? {} : { workingSeconds })}
        {...(state.interruptNotice === undefined
          ? {}
          : { interruptNotice: state.interruptNotice })}
        pendingSteers={state.pendingSteers.map((steer) => steer.text)}
        usage={state.usage}
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
          />
        }
        composer={
          <Composer
            isActive={effectiveOverlay.type === 'none'}
            running={ctrlCInterrupts}
            history={submission.inputHistory}
            {...(suggestions === undefined ? {} : { suggestions })}
            value={draft}
            onChange={(value, nextCursor) => {
              setDraft(value);
              setCursor(nextCursor);
            }}
            onSuggestionAccepted={() => undefined}
            onSubmit={(value) => {
              submission.rememberInput(value);
              void submitPrompt(value).catch(onError);
            }}
            onCancel={handleCancel}
            onEscape={() => {
              if (effectiveOverlay.type !== 'none') {
                setOverlay({ type: 'none' });
              } else if (running) {
                void thread
                  .interrupt('user interrupted from TUI')
                  .catch(onError);
              }
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
