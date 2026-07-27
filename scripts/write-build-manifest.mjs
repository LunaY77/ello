import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const repositoryRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
);
const packageDir = path.resolve(requiredEnvironment('ELLO_BUILD_PACKAGE_DIR'));
const distDir = path.resolve(requiredEnvironment('ELLO_DIST_DIR'));
const entries = requiredEnvironment('ELLO_BUILD_ENTRIES').split(',');
const packageJson = JSON.parse(
  await readFile(path.join(packageDir, 'package.json'), 'utf8'),
);
const gitRevision = await command('git', ['rev-parse', 'HEAD']);
const gitTree = await command('git', ['rev-parse', 'HEAD^{tree}']);
const gitStatus = await commandAllowEmpty('git', ['status', '--porcelain']);
const pnpmVersion = await command('pnpm', ['--version']);
const lockfileSha256 = sha256(
  await readFile(path.join(repositoryRoot, 'pnpm-lock.yaml')),
);
const entryHashes = Object.fromEntries(
  await Promise.all(
    entries.map(async (entry) => {
      if (entry === '')
        throw new Error('Build manifest entry must not be empty.');
      return [entry, sha256(await readFile(path.join(distDir, entry)))];
    }),
  ),
);

await writeFile(
  path.join(distDir, 'build-manifest.json'),
  `${JSON.stringify(
    {
      schema: 'ello.build-manifest.v1',
      packageName: packageJson.name,
      packageVersion: packageJson.version,
      gitRevision,
      gitTree,
      sourceClean: gitStatus === '',
      lockfileSha256,
      nodeVersion: process.versions.node,
      pnpmVersion,
      entries: entryHashes,
      builtAt: new Date().toISOString(),
    },
    null,
    2,
  )}\n`,
  'utf8',
);

async function command(commandName, args) {
  const stdout = await commandAllowEmpty(commandName, args);
  if (stdout === '') throw new Error(`${commandName} returned empty output.`);
  return stdout;
}

async function commandAllowEmpty(commandName, args) {
  const result = await execFileAsync(commandName, args, {
    cwd: repositoryRoot,
    encoding: 'utf8',
  });
  return result.stdout.trim();
}

function requiredEnvironment(name) {
  const value = process.env[name];
  if (value === undefined || value === '') {
    throw new Error(`Missing build environment variable: ${name}.`);
  }
  return value;
}

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}
