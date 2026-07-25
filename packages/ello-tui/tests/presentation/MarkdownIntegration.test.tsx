import { render } from 'ink-testing-library';
import { describe, expect, it } from 'vitest';

import { LiveViewport } from '../../src/tui/component/LiveViewport.js';
import type { HistoryEntry } from '../../src/tui/store/history-entry.js';
import { HistoryEntryRenderer } from '../../src/tui/store/HistoryRenderer.js';

function assistantEntry(text: string): HistoryEntry {
  return { kind: 'assistant', id: 'a1', text };
}

describe('HistoryRenderer assistant markdown', () => {
  it('heading renders without raw # prefix', () => {
    const view = render(
      <HistoryEntryRenderer entry={assistantEntry('# Done')} cwd="/tmp" />,
    );
    const frame = view.lastFrame() ?? '';
    expect(frame).toContain('Done');
    expect(frame).not.toContain('# Done');
  });

  it('code block content appears', () => {
    const view = render(
      <HistoryEntryRenderer
        entry={assistantEntry('```ts\nconst x = 1;\n```')}
        cwd="/tmp"
      />,
    );
    expect(view.lastFrame() ?? '').toMatch(/const[\s\S]*x = 1/su);
  });
});

describe('LiveViewport assistant streaming markdown', () => {
  it('half-open fence does not crash under streaming and renders content', () => {
    const view = render(
      <LiveViewport
        cwd="/tmp"
        assistantText={'# H\n\n```ts\nconst partial'}
        runningTools={[]}
        runningSubagents={[]}
        running
      />,
    );
    const frame = view.lastFrame() ?? '';
    expect(frame).toContain('partial');
    // markdown heading renders without raw # prefix
    expect(frame).not.toContain('# H');
  });

  it('blank assistantText does not render assistant block', () => {
    const view = render(
      <LiveViewport
        cwd="/tmp"
        assistantText="   "
        runningTools={[]}
        runningSubagents={[]}
        running
      />,
    );
    expect(view.lastFrame() ?? '').not.toContain('*');
  });
});
