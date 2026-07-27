import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const repositoryRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
);
const blockedTerm = String.fromCodePoint(0x74, 0x75, 0x72, 0x61);
const pattern = new RegExp(`\\b${blockedTerm}\\b`, 'iu');
const extensions = new Set([
  '.ts',
  '.tsx',
  '.js',
  '.mjs',
  '.cjs',
  '.md',
  '.mdx',
  '.json',
]);
const ignoredDirectories = new Set([
  '.git',
  'coverage',
  'dist',
  'node_modules',
  'raw',
  'results',
]);
const roots = [
  path.join(repositoryRoot, 'packages'),
  path.join(repositoryRoot, 'docs'),
  path.join(repositoryRoot, 'scripts'),
];
const rootFiles = ['README.md', 'README-zh.md'].map((name) =>
  path.join(repositoryRoot, name),
);
const findings = [];

for (const root of roots) {
  for (const filePath of await listFiles(root)) {
    await verifyFile(filePath);
  }
}
for (const filePath of rootFiles) {
  await verifyFile(filePath);
}

if (findings.length > 0) {
  for (const finding of findings) {
    console.error(finding);
  }
  process.exitCode = 1;
} else {
  console.log('Public context verification passed.');
}

async function listFiles(root) {
  const entries = await readdir(root, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    if (entry.isDirectory() && ignoredDirectories.has(entry.name)) continue;
    const target = path.join(root, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await listFiles(target)));
    } else if (entry.isFile() && extensions.has(path.extname(entry.name))) {
      files.push(target);
    }
  }
  return files;
}

async function verifyFile(filePath) {
  const text = await readFile(filePath, 'utf8');
  if (!pattern.test(text)) return;
  findings.push(
    `${path.relative(repositoryRoot, filePath)} contains prohibited external context.`,
  );
}
