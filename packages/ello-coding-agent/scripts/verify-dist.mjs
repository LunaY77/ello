import { access, readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const packageDir = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
);
const distDir =
  process.env.ELLO_DIST_DIR === undefined
    ? path.join(packageDir, 'dist')
    : path.resolve(process.env.ELLO_DIST_DIR);
const requiredAssets = [
  'context/prompts/core-behavior.md',
  'agents/bundled/explore.md',
  'agents/bundled/implement.md',
  'agents/bundled/review.md',
  'agents/bundled/verify.md',
  'storage/migrations/0003-artifacts.sql',
  'storage/migrations/0004-usage-model-calls.sql',
  'storage/migrations/0005-drop-structured-memory.sql',
  'storage/migrations/0010-workspace-references.sql',
];

for (const asset of requiredAssets) {
  await access(path.join(distDir, asset));
}

for (const file of await listJavaScriptFiles(distDir)) {
  const source = await readFile(file, 'utf8');
  if (source.includes('@ello/agent/internal')) {
    throw new Error(`Build output references @ello/agent/internal: ${file}`);
  }
}

async function listJavaScriptFiles(dir) {
  const files = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const target = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await listJavaScriptFiles(target)));
    } else if (entry.name.endsWith('.js')) {
      files.push(target);
    }
  }
  return files;
}
