import { access, readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const packageDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const distDir = path.resolve(
  process.env.ELLO_DIST_DIR ?? path.join(packageDir, 'dist'),
);

for (const asset of ['cli/main.js', 'index.js', 'api/client.js', 'tui/App.js']) {
  await access(path.join(distDir, asset));
}

for (const file of await listJavaScriptFiles(distDir)) {
  const source = await readFile(file, 'utf8');
  if (/from ['"]@ello\/agent['"]/u.test(source)) {
    throw new Error(`TUI build imports the Server root: ${file}`);
  }
  if (
    /better-sqlite3|drizzle-orm|@ai-sdk\/|@langfuse\/|@opentelemetry\//u.test(
      source,
    )
  ) {
    throw new Error(`TUI build contains a Server-only dependency: ${file}`);
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
