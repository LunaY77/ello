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
import { useProfileSettings } from './hooks/use-profile-settings.js';
import { useRequestResolution } from './hooks/use-request-resolution.js';
import {
  rewindTargets,
  useRuntimeActions,
} from './hooks/use-runtime-actions.js';
import { useRuntimeEvents } from './hooks/use-runtime-events.js';
import { useStableInput } from './hooks/use-stable-input.js';
import { useSubmission } from './hooks/use-submission.js';
import { useThemeState } from './hooks/use-theme-state.js';
import {
  buildModelCatalogOptions,
  buildProfileSelectorOptions,
} from './model-selectors.js';
import {
  activeProfileFromConfig,
  bypassEnabledFromConfig,
} from './profile-config.js';
import {
  isDisposableThread,
  isShiftTab,
  overlayForRequest,
} from './screen-utils.js';
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
  const activeProfile = activeProfileFromConfig(catalogs.config);
  const bypassEnabled = bypassEnabledFromConfig(catalogs.config);
  const modelOptions = useMemo(
    () => buildModelCatalogOptions(catalogs.models, catalogs.providers),
    [catalogs.models, catalogs.providers],
  );
  const profileOptions = useMemo(
    () => buildProfileSelectorOptions(catalogs.profiles, activeProfile),
    [activeProfile, catalogs.profiles],
  );
  const suggestions = useComposerSuggestions({
    thread,
    draft,
    cursor,
    fileSearch,
    profiles: catalogs.profiles,
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
  });

  const { submitPrompt } = createThreadCommandRunner({
    thread,
    state,
    catalogs,
    modelOptions,
    profileOptions,
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
  const profiles = useProfileSettings({
    thread,
    profiles: catalogs.profiles,
    activeProfile,
    currentProfile: state.settings.profile,
    modelOptions,
    themeName,
    setProfiles: catalogs.setProfiles,
    setConfig: catalogs.setConfig,
    setOverlay,
    setThemeName,
    setThemeEpoch,
    onError,
  });

  const handleCancel = (): void => {
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

  const contextPercent = contextRemainingPercent(
    catalogs.models,
    state.settings.model,
    state.usage.inputTokens + state.usage.outputTokens,
  );
  const ctrlCInterrupts = running || submission.submissionPending;
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
        model={state.settings.model}
        mode={{ mode: state.settings.mode }}
        {...(contextPercent === undefined ? {} : { contextPercent })}
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
            {...(requests.resolvingRequestId === undefined
              ? {}
              : { resolvingRequestId: requests.resolvingRequestId })}
            onApprove={requests.onApprove}
            onResolveUserInput={requests.onResolveUserInput}
            onAcceptPlan={requests.onAcceptPlan}
            onChatAboutPlan={requests.onChatAboutPlan}
            onDenyPlan={requests.onDenyPlan}
            onClosePlanPreview={() => setOverlay({ type: 'none' })}
            onSelectModel={(model) => {
              void thread
                .setModel(model)
                .then(() => setOverlay({ type: 'none' }))
                .catch(onError);
            }}
            onSelectProfile={profiles.openProfile}
            onCreateProfile={profiles.createProfile}
            onRequestDeleteProfile={profiles.requestDeleteProfile}
            onConfirmDeleteProfile={profiles.confirmDeleteProfile}
            onActivateProfile={profiles.activateProfile}
            onSubmitNewProfile={profiles.submitNewProfile}
            onSelectProfileRole={profiles.selectProfileRole}
            onBindProfileRoleModel={profiles.bindProfileRoleModel}
            onSaveProfile={profiles.saveProfile}
            onSelectSession={(threadId, action) => {
              const resume =
                action === 'resume'
                  ? thread.resume(threadId)
                  : thread
                      .request('thread/unarchive', { threadId })
                      .then(() => thread.resume(threadId));
              void resume.then(switchThread).catch(onError);
            }}
            onSelectRewind={(entryId) => {
              const target = rewindTargets(state.history).find(
                (candidate) => candidate.entryId === entryId,
              );
              if (target !== undefined) {
                void runtime.rewindToTarget(target).catch(onError);
              }
            }}
            onUpdateSetting={profiles.updateSetting}
            onOpenProfiles={profiles.openProfiles}
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
  models: readonly {
    readonly id: string;
    readonly metadata: Record<string, unknown>;
  }[],
  model: string,
  used: number,
): number | undefined {
  const contextWindow = models.find((entry) => entry.id === model)?.metadata
    .context;
  if (typeof contextWindow !== 'number' || contextWindow <= 0) return undefined;
  return Math.max(
    0,
    Math.round(((contextWindow - used) / contextWindow) * 100),
  );
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
