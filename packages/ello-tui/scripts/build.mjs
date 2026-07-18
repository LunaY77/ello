import { execFile } from 'node:child_process';
import { access, chmod, rename, rm } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const packageDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const distDir = path.join(packageDir, 'dist');
const buildDir = path.join(packageDir, `.dist-build-${process.pid}`);
const previousDir = path.join(packageDir, `.dist-previous-${process.pid}`);

await rm(buildDir, { force: true, recursive: true });
await rm(previousDir, { force: true, recursive: true });
try {
  await execFileAsync(
    'pnpm',
    ['exec', 'tsc', '-p', 'tsconfig.json', '--outDir', buildDir],
    { cwd: packageDir },
  );
  await chmod(path.join(buildDir, 'cli/main.js'), 0o755);
  await execFileAsync(process.execPath, ['scripts/verify-dist.mjs'], {
    cwd: packageDir,
    env: { ...process.env, ELLO_DIST_DIR: buildDir },
  });
  const hadPrevious = await exists(distDir);
  if (hadPrevious) await rename(distDir, previousDir);
  try {
    await rename(buildDir, distDir);
  } catch (error) {
    if (hadPrevious) await rename(previousDir, distDir);
    throw error;
  }
  await rm(previousDir, { force: true, recursive: true });
} finally {
  await rm(buildDir, { force: true, recursive: true });
  await rm(previousDir, { force: true, recursive: true });
}

async function exists(target) {
  try {
    await access(target);
    return true;
  } catch {
    return false;
  }
}
