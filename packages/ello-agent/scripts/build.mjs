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
const assets = [
  ['src/features/config/templates', 'features/config/templates'],
  ['src/protocol/v1/fixtures', 'protocol/v1/fixtures'],
  ['src/features/agent/context/prompts', 'features/agent/context/prompts'],
  ['src/features/agent/subagents/bundled', 'features/agent/subagents/bundled'],
  ['src/infra/database/migrations', 'infra/database/migrations'],
];

await rm(buildDir, { recursive: true, force: true });
await rm(previousDir, { recursive: true, force: true });
try {
  await execFileAsync(
    'pnpm',
    ['exec', 'tsc', '-p', 'tsconfig.json', '--outDir', buildDir],
    { cwd: packageDir, shell: process.platform === 'win32' },
  );
  for (const [source, target] of assets) {
    await cp(path.join(packageDir, source), path.join(buildDir, target), {
      recursive: true,
    });
  }
  await chmod(path.join(buildDir, 'main.js'), 0o755);
  await execFileAsync(process.execPath, ['scripts/verify-dist.mjs'], {
    cwd: packageDir,
    env: { ...process.env, ELLO_DIST_DIR: buildDir },
  });
  const hadPrevious = await exists(distDir);
  try {
    if (hadPrevious) await renameRetry(distDir, previousDir);
    try {
      await renameRetry(buildDir, distDir);
    } catch (error) {
      if (hadPrevious) {
        await renameRetry(previousDir, distDir).catch(() => {});
      }
      throw error;
    }
  } catch {
    // Atomic rename swap failed, usually because a persistent Windows file
    // lock (antivirus / search indexer) holds the old dist open. Remove it
    // in place (rmRetry waits the lock out) and move the fresh build in.
    await rmRetry(distDir);
    await renameRetry(buildDir, distDir);
  }
  // swap 成功后清理旧 dist：此时新 dist 已就位，清理失败不影响产物。
  // 用 rmRetry 等待 Windows 文件锁，仍失败则静默（finally 还会再兜底一次）。
  await rmRetry(previousDir).catch(() => {});
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

// Windows often holds a transient handle on freshly built files (Defender /
// search indexer), making a one-shot rename fail with EPERM/EACCES. Retry with
// exponential backoff so the atomic swap survives that brief contention.
async function renameRetry(from, to, { attempts = 6, baseDelayMs = 100 } = {}) {
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      return await rename(from, to);
    } catch (error) {
      const code = error?.code;
      const retryable =
        code === 'EPERM' ||
        code === 'EACCES' ||
        code === 'ENOTEMPTY' ||
        code === 'EBUSY';
      if (!retryable || attempt === attempts) throw error;
      await new Promise((resolve) =>
        setTimeout(resolve, baseDelayMs * 2 ** (attempt - 1)),
      );
    }
  }
}

// Remove a path with retry, mirroring renameRetry so the fallback swap can
// wait out transient Windows file locks (antivirus / search indexer). `force`
// keeps it a no-op when the path is already gone.
async function rmRetry(target, { attempts = 6, baseDelayMs = 100 } = {}) {
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      await rm(target, { recursive: true, force: true });
      return;
    } catch (error) {
      const code = error?.code;
      const retryable =
        code === 'EPERM' ||
        code === 'EACCES' ||
        code === 'ENOTEMPTY' ||
        code === 'EBUSY';
      if (!retryable || attempt === attempts) throw error;
      await new Promise((resolve) =>
        setTimeout(resolve, baseDelayMs * 2 ** (attempt - 1)),
      );
    }
  }
}
