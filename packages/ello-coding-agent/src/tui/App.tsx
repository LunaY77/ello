import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { useApp, useInput } from 'ink';
import { useEffect, useMemo, useState } from 'react';

import type { CodingAgentConfig } from '../config.js';
import type { CodingSession, ApprovalDecision } from '../runtime/index.js';
import { handleSlashCommand, type CommandResult } from '../slash-commands.js';

import { completeInput } from './completion.js';
import { AppShell } from './components/AppShell.js';
import { Composer } from './components/Composer.js';
import { useRuntimeEvents } from './hooks/use-runtime-events.js';
import { OverlayHost, type OverlayState } from './overlays/OverlayHost.js';

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
  const { state, pushUser } = useRuntimeEvents(session);
  const [overlay, setOverlay] = useState<OverlayState>({ type: 'none' });
  const [input, setInput] = useState('');
  const [model, setModel] = useState(config.model);
  const [fileSuggestions, setFileSuggestions] = useState<readonly string[]>([]);
  const [workingSeconds, setWorkingSeconds] = useState(0);
  const [lastWorkedFor, setLastWorkedFor] = useState<string | undefined>();
  const [inputHistory, setInputHistory] = useState<readonly string[]>([]);
  const [pendingSteers, setPendingSteers] = useState<readonly string[]>([]);
  const shouldCompleteFiles = input.trimStart().startsWith('@');

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
    if (!shouldCompleteFiles) {
      return;
    }
    let active = true;
    void completeFiles(input, config.cwd).then((items) => {
      if (active) {
        setFileSuggestions(items);
      }
    });
    return () => {
      active = false;
    };
  }, [config.cwd, input, shouldCompleteFiles]);

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
      setLastWorkedFor(
        formatDuration(Math.max(0, Math.floor((Date.now() - started) / 1000))),
      );
      setPendingSteers([]);
    };
  }, [state.status]);

  /** 执行一条 slash command 的产品动作。 */
  const runCommand = (command: CommandResult): void => {
    switch (command.type) {
      case 'open-overlay':
        if (command.overlay === 'model-selector') {
          setOverlay({
            type: 'model-selector',
            models: config.modelCandidates,
          });
        } else if (command.overlay === 'help') {
          setOverlay({ type: 'help' });
        } else if (command.overlay === 'settings') {
          setOverlay({ type: 'settings', config: { ...config, model } });
        } else if (command.overlay === 'session-selector') {
          void session.listSessions().then((sessions) =>
            setOverlay({ type: 'session-selector', sessions }),
          );
        } else if (command.overlay === 'session-tree') {
          void session
            .sessionTree()
            .then((tree) => setOverlay({ type: 'session-tree', tree }));
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
          const reason = command.args?.join(' ') || 'fork from TUI';
          void session.fork(reason);
        } else if (command.action === 'export') {
          void exportCurrentSession(command.args?.[0]);
        } else if (command.action === 'quit') {
          void session.close().then(() => exit());
        } else {
          session.notify(`Runtime action is not implemented: ${command.action}`);
        }
        return;
      case 'submit':
        pushUser(command.prompt);
        void session.submit(command.prompt);
        return;
      case 'set-model':
        void session.setModel(command.model).then(() => setModel(command.model));
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
    const prompt = value.trim();
    if (prompt === '') {
      return;
    }
    rememberInput(prompt);
    if (prompt.startsWith('!')) {
      void runShellEscape(prompt.slice(1).trim());
      return;
    }
    if (prompt.startsWith('@')) {
      void submitFileReference(prompt);
      return;
    }
    const slash = handleSlashCommand(prompt, config);
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
      setPendingSteers((current) => [...current, prompt]);
      session.steer(prompt);
      return;
    }
    pushUser(prompt);
    void session.submit(prompt);
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

  async function submitFileReference(prompt: string): Promise<void> {
    try {
      const expanded = await expandFileReference(prompt, config.cwd);
      pushUser(prompt);
      void session.submit(expanded);
    } catch (error) {
      session.notify(
        `Failed to attach file: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  function cancelOrExit(): void {
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
    void session.resumeSession(sessionId);
  };

  const onCheckout = (entryId: string | null): void => {
    setOverlay({ type: 'none' });
    void session.checkout(entryId);
  };

  async function exportCurrentSession(formatArg: string | undefined) {
    const format = formatArg === 'html' ? 'html' : 'jsonl';
    const content = await session.exportSession(format);
    const exportDir = path.join(config.cwd, '.ello', 'exports');
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

  const runningTools = useMemo(
    () => [...state.runningTools.values()],
    [state.runningTools],
  );

  const suggestions = useMemo(
    () => completeInput(input, config.modelCandidates, fileSuggestions),
    [config.modelCandidates, fileSuggestions, input],
  );

  return (
    <AppShell
      cwd={config.cwd}
      model={model}
      approvalMode={config.approvalMode}
      transcript={state.transcript}
      liveAssistantText={state.liveAssistantText}
      runningTools={runningTools}
      running={state.status === 'running'}
      workingSeconds={workingSeconds}
      pendingSteers={pendingSteers}
      {...(state.status !== 'running' && lastWorkedFor !== undefined
        ? { workedFor: lastWorkedFor }
        : {})}
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
            void session.setModel(selected).then(() => setModel(selected));
          }}
          onSelectSession={onSelectSession}
          onCheckout={onCheckout}
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
              void session.setModel(selected).then(() => setModel(selected));
            }}
            onSelectSession={onSelectSession}
            onCheckout={onCheckout}
          />
        ) : (
          <Composer
            running={state.status === 'running'}
            isActive={effectiveOverlay.type === 'none'}
            history={inputHistory}
            {...(suggestions !== undefined ? { suggestions } : {})}
            onChange={(value) => {
              setInput(value);
              if (!value.trimStart().startsWith('@')) {
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
  );
}

function formatDuration(totalSeconds: number): string {
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return minutes > 0 ? `${minutes}m ${seconds}s` : `${seconds}s`;
}

async function completeFiles(
  input: string,
  cwd: string,
): Promise<readonly string[]> {
  const raw = input.trimStart().slice(1);
  const normalized = raw.replace(/^["']/u, '');
  const partialDir = normalized.endsWith('/')
    ? normalized
    : path.dirname(normalized);
  const base = normalized.endsWith('/') ? '' : path.basename(normalized);
  const relativeDir = partialDir === '.' ? '' : partialDir;
  const dir = path.resolve(cwd, relativeDir);
  if (!isInside(cwd, dir)) {
    return [];
  }
  try {
    const entries = await readdir(dir, { withFileTypes: true });
    return entries
      .filter((entry) => entry.name.startsWith(base))
      .sort((a, b) => a.name.localeCompare(b.name))
      .slice(0, 8)
      .map((entry) => {
        const relativePath = path.join(relativeDir, entry.name);
        return `@${relativePath}${entry.isDirectory() ? '/' : ''}`;
      });
  } catch {
    return [];
  }
}

async function expandFileReference(input: string, cwd: string): Promise<string> {
  const [fileToken = '', ...rest] = input.trim().split(/\s+/u);
  const target = fileToken.slice(1);
  const resolved = path.resolve(cwd, target);
  if (!isInside(cwd, resolved)) {
    throw new Error(`Path not allowed: ${resolved}`);
  }
  const content = await readFile(resolved, 'utf8');
  const tail = rest.join(' ');
  const instruction =
    tail.length > 0 ? tail : 'Use this file as context for the next answer.';
  return `${instruction}\n\n<attached-file path="${path.relative(cwd, resolved)}">\n${content}\n</attached-file>`;
}

function formatShellResult(
  command: string,
  result: { readonly exitCode: number; readonly stdout: string; readonly stderr: string },
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
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}
