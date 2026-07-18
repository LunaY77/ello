import { execFile } from 'node:child_process';
import { access, chmod, cp, rename, rm } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const packageDir = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
);
const distDir = path.join(packageDir, 'dist');
const buildDir = path.join(packageDir, `.dist-build-${process.pid}`);
const previousDir = path.join(packageDir, `.dist-previous-${process.pid}`);

const assetDirectories = [
  ['src/config/templates', 'config/templates'],
  ['src/context/prompts', 'context/prompts'],
  ['src/agents/bundled', 'agents/bundled'],
  ['src/storage/migrations', 'storage/migrations'],
];

await rm(buildDir, { recursive: true, force: true });
await rm(previousDir, { recursive: true, force: true });

try {
  // 所有编译和资源复制都在临时目录完成，避免运行中的 CLI 看到半成品 dist。
  await execFileAsync(
    'pnpm',
    ['exec', 'tsc', '-p', 'tsconfig.json', '--outDir', buildDir],
    { cwd: packageDir },
  );
  for (const [source, target] of assetDirectories) {
    await cp(path.join(packageDir, source), path.join(buildDir, target), {
      recursive: true,
    });
  }
  await chmod(path.join(buildDir, 'cli.js'), 0o755);
  await execFileAsync(process.execPath, ['scripts/verify-dist.mjs'], {
    cwd: packageDir,
    env: { ...process.env, ELLO_DIST_DIR: buildDir },
  });

  const hadPreviousBuild = await exists(distDir);
  if (hadPreviousBuild) {
    await rename(distDir, previousDir);
  }
  try {
    await rename(buildDir, distDir);
  } catch (error) {
    if (hadPreviousBuild) {
      await rename(previousDir, distDir);
    }
    throw error;
  }
  await rm(previousDir, { recursive: true, force: true });
} finally {
  await rm(buildDir, { recursive: true, force: true });
  await rm(previousDir, { recursive: true, force: true });
}

async function exists(target) {
  try {
    await access(target);
    return true;
  } catch {
    return false;
  }
}
