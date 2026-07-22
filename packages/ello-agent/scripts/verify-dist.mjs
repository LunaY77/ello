import { access, readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const packageDir = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
);
const distDir = path.resolve(
  process.env.ELLO_DIST_DIR ?? path.join(packageDir, 'dist'),
);
const required = [
  'main.js',
  'protocol/v1/index.js',
  'protocol/v1/fixtures/catalog.json',
  'features/config/templates/config.yaml',
  'features/agent/context/prompts/core-behavior.md',
  'features/agent/subagents/bundled/explore.md',
  'infra/database/migrations/0000_tiny_swordsman.sql',
  'infra/database/migrations/meta/_journal.json',
];

for (const asset of required) await access(path.join(distDir, asset));
for (const file of await listJavaScriptFiles(distDir)) {
  const source = await readFile(file, 'utf8');
  if (/\b(?:react|ink|commander)\b/u.test(source)) {
    throw new Error(`Server build contains a Client dependency: ${file}`);
  }
}

async function listJavaScriptFiles(directory) {
  const files = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const target = path.join(directory, entry.name);
    if (entry.isDirectory()) files.push(...(await listJavaScriptFiles(target)));
    else if (entry.name.endsWith('.js')) files.push(target);
  }
  return files;
}
