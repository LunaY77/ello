import { renderToString } from 'ink';
import { describe, expect, it } from 'vitest';

import { OverlayHost } from '../../src/tui/component/OverlayHost.js';
import { InlineSelect } from '../../src/tui/ui/List.js';
import { overlayCallbacks } from '../support/overlay-fixture.js';

describe('bottom dock pickers', () => {
  it('renders the Codex-style session selector collapsed by default', () => {
    const output = renderToString(
      <OverlayHost
        {...overlayCallbacks()}
        overlay={{
          type: 'session-selector',
          action: 'resume',
          currentCwd: '/repo',
          sessions: Array.from({ length: 8 }, (_, index) => ({
            id: `session-${index}`,
            rootId: `session-${index}`,
            cwd: '/repo',
            name: `session ${index}`,
            preview: `session ${index}`,
            status: 'idle' as const,
            archived: false,
            createdAt: '2026-07-18T00:00:00.000Z',
            updatedAt: '2026-07-18T00:00:00.000Z',
          })),
        }}
      />,
      { columns: 100 },
    );

    expect(output).toContain('Resume a previous session');
    expect(output).toContain('Type to search');
    expect(output).toContain('Cwd [All]');
    expect(output).toContain('[Updated] Created');
    expect(output).not.toContain('Session:    session-7');
    expect(output).not.toContain('Directory:  /repo');
    expect(output).toContain('Ctrl+E expand/collapse');
    expect(output).toContain('1 / 8');
  });

  it('renders only rewindable user entries in the rewind selector', () => {
    const output = renderToString(
      <OverlayHost
        {...overlayCallbacks()}
        overlay={{
          type: 'rewind-selector',
          targets: [
            {
              entryId: '0123456789abcdef',
              turnId: 'turn-3',
              index: 3,
              text: 'update docs',
            },
          ],
        }}
      />,
      { columns: 100 },
    );

    expect(output).toContain('rewind target  1-1 of 1');
    expect(output).toContain('01234567');
    expect(output).toContain('update docs');
  });

  it('renders a bounded selection window with a scrollbar', () => {
    const output = renderToString(
      <InlineSelect
        label="sessions"
        visibleRows={3}
        options={Array.from({ length: 8 }, (_, index) => ({
          value: `value-${index}`,
          label: `item ${index}`,
        }))}
        onChange={() => {}}
      />,
      { columns: 100 },
    );

    expect(output).toContain('sessions  1-3 of 8');
    expect(output).toContain('item 2');
    expect(output).not.toContain('item 3');
    expect(output).toContain('scrollbar  [####------]');
  });
});
