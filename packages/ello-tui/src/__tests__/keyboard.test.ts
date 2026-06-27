import type { CodingAgentConfig, CodingAgentController } from '@ello/coding-agent';
import { describe, expect, it, vi } from 'vitest';


import { handleCodingAgentKey, type KeybindingOptions } from '../keyboard.js';
import { createInitialState, type TuiAction } from '../state/index.js';

const config: CodingAgentConfig = {
  model: 'openai-chat:gpt-4o-mini',
  modelCandidates: ['openai-chat:gpt-4o-mini', 'openai-chat:gpt-4.1'],
  baseUrl: null,
  cwd: '/repo',
  allowedPaths: ['/repo'],
  sessionDir: '/tmp/sessions',
  sessionId: 's1',
  approvalMode: 'on-request',
  permissionRules: [],
  mcpConfigPath: null,
  systemPromptProfile: 'coding',
  theme: 'default',
  tui: true,
  json: false,
};

function options(overrides: Partial<KeybindingOptions> = {}): {
  actions: TuiAction[];
  setInput: ReturnType<typeof vi.fn>;
  exit: ReturnType<typeof vi.fn>;
  controller: CodingAgentController;
  options: KeybindingOptions;
} {
  const actions: TuiAction[] = [];
  const setInput = vi.fn();
  const exit = vi.fn();
  const controller = {
    interrupt: vi.fn(),
    resumeInterruptedRun: vi.fn().mockResolvedValue(undefined),
    approveToolCall: vi.fn().mockResolvedValue(undefined),
    rejectToolCall: vi.fn().mockResolvedValue(undefined),
    switchModelByIndex: vi.fn().mockResolvedValue(undefined),
  } as unknown as CodingAgentController;
  return {
    actions,
    setInput,
    exit,
    controller,
    options: {
      controller,
      state: createInitialState(config),
      input: '',
      setInput,
      slashSuggestions: [],
      fileSuggestions: [],
      onResumeSelectedSession: vi.fn(),
      dispatch: (action) => {
        actions.push(action);
      },
      exit,
      ...overrides,
    },
  };
}

describe('handleCodingAgentKey', () => {
  it('requires a second Ctrl+C before exiting while idle', () => {
    const first = options();
    expect(handleCodingAgentKey(first.options, 'c', { ctrl: true })).toBe(true);
    expect(first.exit).not.toHaveBeenCalled();
    expect(first.actions).toContainEqual({ type: 'exit_pending', value: true });

    const second = options({
      state: { ...createInitialState(config), exitPending: true },
    });
    expect(handleCodingAgentKey(second.options, 'c', { ctrl: true })).toBe(true);
    expect(second.exit).toHaveBeenCalledOnce();
  });

  it('interrupts instead of exiting while a run is active', () => {
    const setup = options({
      state: { ...createInitialState(config), status: 'running' },
    });

    handleCodingAgentKey(setup.options, 'c', { ctrl: true });

    expect(setup.controller.interrupt).toHaveBeenCalledOnce();
    expect(setup.exit).not.toHaveBeenCalled();
  });

  it('applies file suggestions before slash suggestions on Tab', () => {
    const setup = options({
      input: 'read @sr',
      slashSuggestions: ['/resume'],
      fileSuggestions: [{ label: 'dir @src/', replacement: '@src/', isDirectory: true }],
    });

    handleCodingAgentKey(setup.options, '', { tab: true });

    expect(setup.setInput).toHaveBeenCalledWith('read @src/');
  });

  it('inserts a newline on Shift+Enter in the composer', () => {
    const setup = options({ input: 'first line' });

    expect(handleCodingAgentKey(setup.options, '', { return: true, shift: true })).toBe(true);

    expect(setup.setInput).toHaveBeenCalledWith('first line\n');
  });

  it('leaves Enter to overlays when a picker is open', () => {
    const setup = options({
      input: 'first line',
      state: { ...createInitialState(config), overlay: 'model', modelIndex: 1 },
    });

    handleCodingAgentKey(setup.options, '', { return: true, shift: true });

    expect(setup.setInput).not.toHaveBeenCalled();
    expect(setup.controller.switchModelByIndex).toHaveBeenCalledWith(1);
  });

  it('switches selected model from the model overlay', () => {
    const setup = options({
      state: { ...createInitialState(config), overlay: 'model', modelIndex: 1 },
    });

    handleCodingAgentKey(setup.options, '', { return: true });

    expect(setup.controller.switchModelByIndex).toHaveBeenCalledWith(1);
  });
});
