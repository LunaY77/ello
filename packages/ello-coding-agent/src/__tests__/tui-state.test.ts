import { describe, expect, it } from 'vitest';

import { ProductEventStore } from '../product/event-store.js';
import { composerReducer, initialComposerState, suggestComposer } from '../tui/state/composer-reducer.js';
import { initialViewState, topOverlay, viewReducer } from '../tui/state/view-reducer.js';

describe('TUI state reducers', () => {
  it('handles multiline paste, history, and command suggestions', () => {
    const pasted = composerReducer(initialComposerState, { type: 'insert', text: 'line 1\nline 2' });
    expect(pasted.value).toBe('line 1\nline 2');
    const submitted = composerReducer(pasted, { type: 'submitted', value: pasted.value });
    expect(submitted.history).toEqual(['line 1\nline 2']);
    const history = composerReducer(submitted, { type: 'history.prev' });
    expect(history.value).toBe('line 1\nline 2');
    expect(suggestComposer('/mo', ['model', 'memory', 'compact'])).toEqual(['/model']);
    expect(suggestComposer('@pa', [])).toContain('@package.json');
    expect(suggestComposer('!pn', [])).toContain('!pnpm test');
  });

  it('keeps overlays as a stack', () => {
    const first = viewReducer(initialViewState, { type: 'overlay.push', overlay: { type: 'help' } });
    const second = viewReducer(first, { type: 'overlay.push', overlay: { type: 'settings' } });
    expect(topOverlay(second)).toEqual({ type: 'settings' });
    expect(topOverlay(viewReducer(second, { type: 'overlay.pop' }))).toEqual({ type: 'help' });
  });

  it('folds many streaming deltas into one current assistant item', () => {
    const store = new ProductEventStore();
    const createdAt = new Date().toISOString();
    store.append({ type: 'run.started', sessionId: 's', runId: 'r', input: { prompt: 'hello', source: 'submit' }, createdAt });
    for (let index = 0; index < 100; index += 1) {
      store.append({ type: 'message.delta', sessionId: 's', runId: 'r', messageId: 'm', text: 'x', createdAt });
    }
    const snapshot = store.snapshot();
    expect(snapshot.currentAssistantText).toHaveLength(100);
    expect(snapshot.transcript).toHaveLength(1);
  });
});
