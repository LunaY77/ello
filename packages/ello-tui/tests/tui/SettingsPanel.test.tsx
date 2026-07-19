import { render } from 'ink-testing-library';
import { describe, expect, it, vi } from 'vitest';

import { SettingsPanel } from '../../src/tui/component/SettingsPanel.js';
import type { TuiSetting } from '../../src/tui/settings/types.js';

describe('SettingsPanel', () => {
  it('按路径、分组和说明搜索 setting', async () => {
    const view = render(
      <SettingsPanel
        settings={[
          setting(),
          setting({
            id: 'context.max_input_tokens',
            path: ['context', 'max_input_tokens'],
            label: 'Max Input Tokens',
            description: 'Context input budget.',
            group: 'Context',
            type: 'integer',
            value: 160_000,
          }),
        ]}
        onUpdate={async () => undefined}
      />,
    );

    view.stdin.write('routing');
    await vi.waitFor(() => {
      expect(view.lastFrame()).toContain('tools.routing_enabled');
      expect(view.lastFrame()).not.toContain('context.max_input_tokens');
    });
    view.unmount();
  });

  it('按选择的作用域提交类型化 boolean，并支持 reset', async () => {
    const onUpdate = vi.fn(async () => undefined);
    const view = render(
      <SettingsPanel settings={[setting()]} onUpdate={onUpdate} />,
    );

    view.stdin.write('\r');
    await vi.waitFor(() => expect(view.lastFrame()).toContain('Set project'));
    view.stdin.write('\u001b[B');
    view.stdin.write('\u001b[B');
    await vi.waitFor(() =>
      expect(selectedLine(view.lastFrame(), 'Set project')).toContain('›'),
    );
    view.stdin.write('\r');
    await vi.waitFor(() =>
      expect(view.lastFrame()).toContain('tools.routing_enabled → project'),
    );
    view.stdin.write('\u001b[B');
    await vi.waitFor(() =>
      expect(selectedLine(view.lastFrame(), 'true')).toContain('›'),
    );
    view.stdin.write('\r');

    await vi.waitFor(() =>
      expect(onUpdate).toHaveBeenCalledWith({
        setting: setting(),
        source: 'project',
        operation: 'set',
        value: true,
      }),
    );
    view.unmount();

    const reset = vi.fn(async () => undefined);
    const resetView = render(
      <SettingsPanel settings={[setting()]} onUpdate={reset} />,
    );
    resetView.stdin.write('\r');
    await vi.waitFor(() =>
      expect(resetView.lastFrame()).toContain('Reset global'),
    );
    resetView.stdin.write('\u001b[B');
    await vi.waitFor(() =>
      expect(selectedLine(resetView.lastFrame(), 'Reset global')).toContain(
        '›',
      ),
    );
    resetView.stdin.write('\r');
    await vi.waitFor(() =>
      expect(reset).toHaveBeenCalledWith({
        setting: setting(),
        source: 'global',
        operation: 'delete',
      }),
    );
    resetView.unmount();
  });

  it('敏感值输入只显示掩码', async () => {
    const onUpdate = vi.fn(async () => undefined);
    const secret = setting({
      id: 'provider.openai.api_key',
      path: ['provider', 'openai', 'api_key'],
      label: 'Api Key',
      description: 'Provider credential.',
      group: 'Providers',
      type: 'secret',
      sensitive: true,
      writableScopes: ['global'],
    });
    const view = render(
      <SettingsPanel settings={[secret]} onUpdate={onUpdate} />,
    );

    view.stdin.write('\r');
    await vi.waitFor(() => expect(view.lastFrame()).toContain('Set global'));
    view.stdin.write('\r');
    await vi.waitFor(() =>
      expect(view.lastFrame()).toContain('Current value is hidden'),
    );
    view.stdin.write('secret-value');
    await vi.waitFor(() => {
      expect(view.lastFrame()).toContain('••••');
      expect(view.lastFrame()).not.toContain('secret-value');
    });
    view.stdin.write('\r');
    await vi.waitFor(() =>
      expect(onUpdate).toHaveBeenCalledWith({
        setting: secret,
        source: 'global',
        operation: 'set',
        value: 'secret-value',
      }),
    );
    view.unmount();
  });
});

function setting(overrides: Partial<TuiSetting> = {}): TuiSetting {
  return {
    owner: 'server',
    id: 'tools.routing_enabled',
    path: ['tools', 'routing_enabled'],
    label: 'Routing Enabled',
    description: 'Route model tools through discovery.',
    group: 'Tools',
    type: 'boolean',
    value: false,
    source: 'global',
    writableScopes: ['global', 'project'],
    effect: 'nextTurn',
    sensitive: false,
    ...overrides,
  };
}

function selectedLine(frame: string | undefined, value: string): string {
  return frame?.split('\n').find((line) => line.includes(value)) ?? '';
}
