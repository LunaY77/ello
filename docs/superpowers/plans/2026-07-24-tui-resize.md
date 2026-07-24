# TUI Terminal Resize Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the Ink TUI re-render its application-level layout and Composer wrapping from the terminal's current width after every stdout `resize` event.

**Architecture:** Add a focused `useTerminalSize()` hook that reads Ink's injected stdout stream, stores its current column count in React state, and subscribes/unsubscribes to its `resize` event. Replace the AppShell-local width snapshot and Composer's direct stdout read with that hook; their existing width offsets and layout algorithms remain unchanged.

**Tech Stack:** TypeScript 6, React 19, Ink 6, ink-testing-library 4, Vitest 4.

## Global Constraints

- Keep the existing fallback width exactly `100` when `stdout.columns` is `undefined`.
- Do not change the existing width formulas: AppShell remains `Math.max(tuiTokens.width.minMain, columns - 2)` and Composer remains `Math.max(1, columns - 10)`.
- Do not introduce a Provider, Context, layout model, `rows` value, or change the Composer wrapping algorithms.
- Use Ink's `useStdout()` rather than `process.stdout` so tests and alternate stdout streams work correctly.
- Preserve unrelated working-tree changes; stage only resize-related files in commits.

---

## File Structure

- Create: `packages/ello-tui/src/tui/hooks/use-terminal-size.ts` - owns the responsive terminal-column subscription and the `TerminalSize` interface.
- Create: `packages/ello-tui/tests/hooks/use-terminal-size.test.tsx` - verifies initial/fallback values, resize updates, and listener cleanup using an injected controllable stdout stream.
- Modify: `packages/ello-tui/src/tui/component/AppShell.tsx` - consumes the shared hook instead of retaining its local width snapshot.
- Modify: `packages/ello-tui/src/tui/component/Composer.tsx` - consumes the shared hook for responsive visual wrapping and cursor movement.
- Modify: `packages/ello-tui/tests/input/composer.test.ts` - verifies a Composer instance recalculates its visual width after a stdout resize.

### Task 1: Create and Verify the Responsive Terminal-Size Hook

**Files:**

- Create: `packages/ello-tui/tests/hooks/use-terminal-size.test.tsx`
- Create: `packages/ello-tui/src/tui/hooks/use-terminal-size.ts`

**Interfaces:**

- Consumes: Ink `useStdout(): { stdout: NodeJS.WriteStream }` and the stdout stream's Node `resize` event.
- Produces:

```ts
export interface TerminalSize {
  readonly columns: number;
}

export function useTerminalSize(): TerminalSize;
```

- Later consumers use `useTerminalSize().columns` for derived widths.

- [ ] **Step 1: Write failing hook tests with a controllable stdout stream**

Create `packages/ello-tui/tests/hooks/use-terminal-size.test.tsx`:

```tsx
import { EventEmitter } from 'node:events';

import { render } from 'ink-testing-library';
import StdoutContext from 'ink/build/components/StdoutContext.js';
import { createElement } from 'react';
import { describe, expect, it } from 'vitest';

import { useTerminalSize } from '../../src/tui/hooks/use-terminal-size.js';

class ResizeableStdout extends EventEmitter {
  columns: number | undefined;

  constructor(columns: number | undefined) {
    super();
    this.columns = columns;
  }
}

function SizeProbe({
  onColumns,
}: {
  readonly onColumns: (columns: number) => void;
}) {
  onColumns(useTerminalSize().columns);
  return null;
}

function renderProbe(
  stdout: ResizeableStdout,
  onColumns: (columns: number) => void,
) {
  return render(
    createElement(
      StdoutContext.Provider,
      {
        value: {
          stdout: stdout as unknown as NodeJS.WriteStream,
          write: () => {},
        },
      },
      createElement(SizeProbe, { onColumns }),
    ),
  );
}

describe('useTerminalSize', () => {
  it('uses stdout columns initially and updates after resize', () => {
    const stdout = new ResizeableStdout(120);
    const columns: number[] = [];
    const view = renderProbe(stdout, (columnCount) => columns.push(columnCount));

    stdout.columns = 40;
    stdout.emit('resize');

    expect(columns).toEqual([120, 40]);
    view.unmount();
  });

  it('falls back to 100 columns and removes its resize listener on unmount', () => {
    const stdout = new ResizeableStdout(undefined);
    const columns: number[] = [];
    const view = renderProbe(stdout, (columnCount) => columns.push(columnCount));

    expect(columns).toEqual([100]);
    expect(stdout.listenerCount('resize')).toBe(1);

    view.unmount();

    expect(stdout.listenerCount('resize')).toBe(0);
  });
});
```

`ResizeableStdout` intentionally only supplies the members this hook needs. The cast is limited to the context boundary because Ink's runtime accepts its stdout dependency structurally, while the test does not render text or call stream methods.

- [ ] **Step 2: Run the focused hook test and verify it fails**

Run:

```powershell
pnpm --filter @ello/tui test -- tests/hooks/use-terminal-size.test.tsx
```

Expected: FAIL during test collection because `../../src/tui/hooks/use-terminal-size.js` does not exist.

- [ ] **Step 3: Implement the minimal responsive hook**

Create `packages/ello-tui/src/tui/hooks/use-terminal-size.ts`:

```ts
import { useStdout } from 'ink';
import { useEffect, useState } from 'react';

export interface TerminalSize {
  readonly columns: number;
}

function columnsFor(stdout: NodeJS.WriteStream): number {
  return stdout.columns ?? 100;
}

export function useTerminalSize(): TerminalSize {
  const { stdout } = useStdout();
  const [columns, setColumns] = useState(() => columnsFor(stdout));

  useEffect(() => {
    const onResize = (): void => {
      setColumns(columnsFor(stdout));
    };
    stdout.on('resize', onResize);
    return () => {
      stdout.off('resize', onResize);
    };
  }, [stdout]);

  return { columns };
}
```

This hook deliberately observes columns only through the resize event. React state is the missing bridge between Ink's terminal resize notification and the application components that calculate explicit widths.

- [ ] **Step 4: Run the hook test and typecheck**

Run:

```powershell
pnpm --filter @ello/tui test -- tests/hooks/use-terminal-size.test.tsx
pnpm --filter @ello/tui typecheck
```

Expected: the two hook tests PASS, and both source/test TypeScript projects typecheck without errors.

- [ ] **Step 5: Commit the hook and its tests**

Run:

```powershell
git add packages/ello-tui/src/tui/hooks/use-terminal-size.ts packages/ello-tui/tests/hooks/use-terminal-size.test.tsx
git commit -m "feat(tui): track terminal resize"
```

Expected: one commit containing only the new hook and its dedicated tests.

### Task 2: Wire Responsive Width into AppShell and Composer

**Files:**

- Modify: `packages/ello-tui/src/tui/component/AppShell.tsx`
- Modify: `packages/ello-tui/src/tui/component/Composer.tsx`
- Modify: `packages/ello-tui/tests/input/composer.test.ts`

**Interfaces:**

- Consumes: `useTerminalSize(): TerminalSize` from `../hooks/use-terminal-size.js`.
- Produces: AppShell and Composer re-render when the shared hook receives a stdout `resize` event.
- `wrapWidth` remains a local number derived as `Math.max(1, size.columns - 10)` and continues to be passed to `visualLineCount`, `moveUpVisual`, `moveDownVisual`, and `wrapComposerLines`.

- [ ] **Step 1: Write the failing Composer resize behavior test**

Append this test to `packages/ello-tui/tests/input/composer.test.ts`, after the current long-paste visual wrapping test:

```ts
  it('recalculates visual wrapping after a terminal resize', () => {
    const changes: Array<{
      readonly value: string;
      readonly cursor: { readonly line: number; readonly column: number };
    }> = [];
    const view = render(
      createElement(Composer, {
        running: false,
        onSubmit: () => {},
        onChange: (
          value: string,
          cursor: { readonly line: number; readonly column: number },
        ) => changes.push({ value, cursor }),
        onCancel: () => {},
        onEscape: () => {},
      }),
    );

    const pasted = 'x'.repeat(100);
    view.stdin.write(pasted);
    Object.defineProperty(view.stdout, 'columns', {
      configurable: true,
      value: 40,
    });
    view.stdout.emit('resize');
    view.stdin.write('\u001b[A');

    expect(changes.at(-1)).toEqual({
      value: pasted,
      cursor: { line: 0, column: 70 },
    });
    view.unmount();
  });
```

With `columns = 40`, Composer's specified `columns - 10` visual width is 30. The cursor begins at column 100, on the row that starts at column 90 with an offset of 10; moving up therefore targets column `60 + 10 = 70`. The `Object.defineProperty` setup is intentional: ink-testing-library's stdout is an EventEmitter but exposes its normal columns value through a read-only getter.

- [ ] **Step 2: Run the focused Composer test and verify it fails**

Run:

```powershell
pnpm --filter @ello/tui test -- tests/input/composer.test.ts
```

Expected: the new test FAILS because Composer continues using the initial 100-column width and moves the cursor to column `10`, rather than column `70` after resize.

- [ ] **Step 3: Replace AppShell's width snapshot with the shared hook**

In `packages/ello-tui/src/tui/component/AppShell.tsx`, add the import next to the existing local imports:

```ts
import { useTerminalSize } from '../hooks/use-terminal-size.js';
```

Keep the existing component calculation unchanged:

```ts
export function AppShell(props: AppShellProps) {
  const size = useTerminalSize();
  const mainWidth = Math.max(tuiTokens.width.minMain, size.columns - 2);
```

Delete the complete local `useTerminalSize` function at the bottom of the file:

```ts
function useTerminalSize(): {
  readonly columns: number;
} {
  return {
    columns: process.stdout.columns ?? 100,
  };
}
```

- [ ] **Step 4: Replace Composer's direct stdout read with the shared hook**

In `packages/ello-tui/src/tui/component/Composer.tsx`:

1. Change the Ink import from:

```ts
import { Box, Text, useInput, useStdout } from 'ink';
```

to:

```ts
import { Box, Text, useInput } from 'ink';
```

2. Add the hook import after the existing Composer-store imports:

```ts
import { useTerminalSize } from '../hooks/use-terminal-size.js';
```

3. Replace:

```ts
  const { stdout } = useStdout();
  const { onChange } = props;
  // ...
  const wrapWidth = Math.max(1, (stdout.columns ?? 100) - 10);
```

with:

```ts
  const size = useTerminalSize();
  const { onChange } = props;
  // ...
  const wrapWidth = Math.max(1, size.columns - 10);
```

Do not alter `wrapComposerLines`, `visualLineCount`, `moveUpVisual`, `moveDownVisual`, the `- 10` offset, or any input event logic.

- [ ] **Step 5: Run the Composer tests and presentation regression tests**

Run:

```powershell
pnpm --filter @ello/tui test -- tests/input/composer.test.ts tests/presentation/AppShell.test.tsx
```

Expected: all focused tests PASS. The new test proves Composer uses the resized width; existing tests prove its prior input behavior and AppShell rendering remain intact.

- [ ] **Step 6: Run the full TUI verification suite**

Run:

```powershell
pnpm --filter @ello/tui test
pnpm --filter @ello/tui typecheck
pnpm --filter @ello/tui lint
```

Expected: all commands exit `0` with no test failures, TypeScript diagnostics, or ESLint errors.

- [ ] **Step 7: Manually verify the TUI in a real terminal**

Run:

```powershell
pnpm --filter @ello/tui build
pnpm --filter @ello/tui run ello
```

Expected: after entering a long multi-line draft, reduce and enlarge the terminal width. The main content width redraws, the Composer wraps at the new width, its cursor remains on the rendered character, and Up/Down navigation follows the visible rows.

- [ ] **Step 8: Commit the consumer wiring and integration test**

Run:

```powershell
git add packages/ello-tui/src/tui/component/AppShell.tsx packages/ello-tui/src/tui/component/Composer.tsx packages/ello-tui/tests/input/composer.test.ts
git commit -m "fix(tui): adapt layout to terminal resize"
```

Expected: one commit containing only the two component integrations and the Composer resize behavior test.

## Plan Self-Review

- Spec coverage: Task 1 covers the responsive stdout subscription, the 100-column fallback, and unsubscription. Task 2 covers AppShell and Composer adoption, the unchanged width offsets, a real Composer resize behavior assertion, package checks, and manual terminal acceptance criteria.
- Placeholder scan: no TBD/TODO/deferred instructions; every implementation and test step includes exact paths, code, commands, and expected results.
- Type consistency: `TerminalSize` and `useTerminalSize` are defined in Task 1 and consumed under the same names in Task 2. The hook's `columns` field is always a `number` after fallback.
