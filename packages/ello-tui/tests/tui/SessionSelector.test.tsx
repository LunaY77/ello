import { render } from 'ink-testing-library';
import { describe, expect, it, vi } from 'vitest';

import type { ThreadSummary } from '../../src/api/protocol-types.js';
import { SessionSelector } from '../../src/tui/component/SessionSelector.js';
import {
  cycleSessionSelectorFocus,
  selectSessions,
} from '../../src/tui/component/session-selector-model.js';
import { resolveTheme, ThemeProvider } from '../../src/tui/theme/index.js';

const currentCwd = '/workspace/current';

describe('SessionSelector', () => {
  it('searches all fields, filters by cwd, and switches sort order', () => {
    const sessions = [
      session(
        'thr_current_old',
        currentCwd,
        'Needle current',
        '2026-07-20',
        '2026-07-23',
      ),
      session(
        'thr_current_new',
        currentCwd,
        'Current new',
        '2026-07-22',
        '2026-07-21',
      ),
      session(
        'thr_other',
        '/workspace/other',
        'Needle other',
        '2026-07-23',
        '2026-07-22',
      ),
    ];

    expect(
      selectSessions(sessions, 'needle', 'all', currentCwd, 'updated').map(
        (item) => item.id,
      ),
    ).toEqual(['thr_current_old', 'thr_other']);
    expect(
      selectSessions(sessions, '', 'current', currentCwd, 'updated').map(
        (item) => item.id,
      ),
    ).toEqual(['thr_current_old', 'thr_current_new']);
    expect(
      selectSessions(sessions, '', 'current', currentCwd, 'created').map(
        (item) => item.id,
      ),
    ).toEqual(['thr_current_new', 'thr_current_old']);
    expect(cycleSessionSelectorFocus('search', false)).toBe('cwd');
    expect(cycleSessionSelectorFocus('cwd', false)).toBe('sort');
    expect(cycleSessionSelectorFocus('search', true)).toBe('list');
  });

  it('keeps details collapsed until Ctrl+E and selects the highlighted session', async () => {
    const onSelect = vi.fn();
    const view = render(
      <ThemeProvider theme={resolveTheme('tokyo-night')}>
        <SessionSelector
          action="resume"
          sessions={[
            session(
              'thr_other',
              '/workspace/other',
              'Other session',
              '2026-07-23',
              '2026-07-23',
            ),
            session(
              'thr_current',
              currentCwd,
              'Current session',
              '2026-07-22',
              '2026-07-22',
            ),
          ]}
          currentCwd={currentCwd}
          onSelect={onSelect}
        />
      </ThemeProvider>,
    );

    expect(view.lastFrame()).not.toContain('Session:    thr_other');
    expect(view.lastFrame()).not.toContain('Directory:  /workspace/other');

    view.stdin.write('\u0005');
    await vi.waitFor(() =>
      expect(view.lastFrame()).toContain('Session:    thr_other'),
    );
    expect(view.lastFrame()).toContain('Directory:  /workspace/other');

    view.stdin.write('\u0005');
    await vi.waitFor(() =>
      expect(view.lastFrame()).not.toContain('Session:    thr_other'),
    );

    view.stdin.write('\r');

    expect(onSelect).toHaveBeenCalledWith('thr_other', 'resume');
    view.unmount();
  });

  it('filters while typing and submits the visible unarchive target', async () => {
    const onSelect = vi.fn();
    const view = render(
      <ThemeProvider theme={resolveTheme('tokyo-night')}>
        <SessionSelector
          action="unarchive"
          sessions={[
            session(
              'thr_alpha',
              currentCwd,
              'Alpha',
              '2026-07-23',
              '2026-07-23',
            ),
            session(
              'thr_beta',
              currentCwd,
              'Beta target',
              '2026-07-22',
              '2026-07-22',
            ),
          ]}
          currentCwd={currentCwd}
          onSelect={onSelect}
        />
      </ThemeProvider>,
    );

    view.stdin.write('beta');
    await vi.waitFor(() => expect(view.lastFrame()).toContain('Search: beta'));
    expect(view.lastFrame()).not.toContain('Alpha');
    view.stdin.write('\r');

    expect(onSelect).toHaveBeenCalledWith('thr_beta', 'unarchive');
    view.unmount();
  });
});

function session(
  id: string,
  cwd: string,
  name: string,
  created: string,
  updated: string,
): ThreadSummary {
  return {
    id,
    rootId: id,
    cwd,
    name,
    preview: `${name} conversation`,
    status: 'idle',
    archived: false,
    createdAt: `${created}T00:00:00.000Z`,
    updatedAt: `${updated}T00:00:00.000Z`,
  };
}
