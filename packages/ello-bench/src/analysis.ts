import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { runProcess } from './process.js';

export const ANALYSIS_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  'analysis',
);

const RENDERER = path.join(ANALYSIS_ROOT, 'render_report.py');

const RENDER_OPTIONS = {
  timeoutMs: 300_000,
  killGraceMs: 5_000,
  maxOutputBytes: 4 * 1024 * 1024,
} as const;

/**
 * Renders the human-readable report and charts for a completed run.
 *
 * Deliberately a separate process invoked after the experiment: chart rendering
 * cannot touch a recorded result, and a missing Python toolchain fails this
 * command alone.
 */
export async function renderAnalysis(runRoot: string): Promise<void> {
  const execution = await runProcess(
    'python3',
    [RENDERER, '--run-root', path.resolve(runRoot)],
    {
      cwd: ANALYSIS_ROOT,
      capture: true,
      ...RENDER_OPTIONS,
    },
  );
  if (execution.result.exitCode !== 0) {
    throw new Error(
      `Analysis rendering failed (exit ${String(execution.result.exitCode)}).\n` +
        `${execution.stderr ?? ''}` +
        `Install the renderer dependencies with: ` +
        `python3 -m pip install -r ${path.join(ANALYSIS_ROOT, 'requirements.txt')}`,
    );
  }
  process.stderr.write(execution.stdout ?? '');
}

/** Reports whether `report --charts` can run on this machine. */
export async function checkAnalysisToolchain(): Promise<{
  readonly ok: boolean;
  readonly detail: string;
}> {
  const modules = ['matplotlib', 'numpy'] as const;
  try {
    const execution = await runProcess(
      'python3',
      ['-c', `import ${modules.join(', ')}`],
      { cwd: ANALYSIS_ROOT, capture: true, ...RENDER_OPTIONS },
    );
    return execution.result.exitCode === 0
      ? { ok: true, detail: `python3 with ${modules.join(', ')}` }
      : {
          ok: false,
          detail: `python3 is missing renderer modules (${modules.join(', ')}); install analysis/requirements.txt`,
        };
  } catch (error) {
    return {
      ok: false,
      detail: error instanceof Error ? error.message : String(error),
    };
  }
}
