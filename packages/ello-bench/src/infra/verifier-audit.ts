import { runChecked } from './process.js';

const GIT_OPTIONS = {
  timeoutMs: 5 * 60_000,
  killGraceMs: 5_000,
  maxOutputBytes: 512 * 1024 * 1024,
} as const;

export async function patchChangedFiles(
  workspace: string,
  patchPath: string,
): Promise<string[]> {
  const output = (
    await runChecked(
      'git',
      ['-C', workspace, 'apply', '--numstat', '-z', patchPath],
      { cwd: workspace, ...GIT_OPTIONS },
    )
  ).stdout;
  const files = output
    .split('\0')
    .filter((record) => record !== '')
    .map((record) => {
      const file = record.split('\t')[2];
      if (file === undefined || file === '') {
        throw new Error(`Invalid verifier patch numstat record: ${record}`);
      }
      return file;
    });
  if (new Set(files).size !== files.length) {
    throw new Error('Verifier patch contains duplicate changed files.');
  }
  return files;
}

export function auditVerifierPatchOverlap(
  modelChangedFiles: readonly string[],
  hiddenPatchChangedFiles: readonly string[],
): string[] {
  const hidden = new Set(hiddenPatchChangedFiles);
  const conflicts = modelChangedFiles.filter((file) => hidden.has(file));
  const productionConflicts = conflicts.filter((file) => !isTestPath(file));
  if (productionConflicts.length > 0) {
    throw new Error(
      `Hidden verifier patch overlaps model production files: ${productionConflicts.join(', ')}.`,
    );
  }
  return conflicts;
}

function isTestPath(filePath: string): boolean {
  const segments = filePath.split('/');
  const name = segments.at(-1);
  if (name === undefined) throw new Error(`Invalid verifier path: ${filePath}`);
  return (
    name === 'test.sh' ||
    segments.some((segment) =>
      ['test', 'tests', '__tests__', 'testdata', 'fixtures'].includes(segment),
    ) ||
    /(?:^test[._-]|[_-]tests?\.|\.tests?\.|\.spec\.|_test\.|test\.config\.|vitest.*\.config\.)/u.test(
      name,
    )
  );
}
