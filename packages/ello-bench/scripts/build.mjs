import { chmod, cp, mkdir, rm } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const packageDir = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
);
const distDir = path.join(packageDir, 'dist');

await rm(distDir, { recursive: true, force: true });
await execFileAsync(
  'pnpm',
  ['exec', 'tsc', '-p', 'tsconfig.json', '--outDir', distDir],
  { cwd: packageDir },
);
await mkdir(path.join(distDir, 'config'), { recursive: true });
await cp(path.join(packageDir, 'config'), path.join(distDir, 'config'), {
  recursive: true,
});
await chmod(path.join(distDir, 'cli.js'), 0o755);
await chmod(path.join(distDir, 'server-entry.js'), 0o755);
await execFileAsync(
  process.execPath,
  ['../../scripts/write-build-manifest.mjs'],
  {
    cwd: packageDir,
    env: {
      ...process.env,
      ELLO_BUILD_PACKAGE_DIR: packageDir,
      ELLO_DIST_DIR: distDir,
      ELLO_BUILD_ENTRIES: 'index.js,cli.js,server-entry.js',
    },
  },
);
if (process.platform === 'win32') process.stdout.write('');
