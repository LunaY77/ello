import { readFileSync } from 'node:fs';

interface PackageMetadata {
  readonly version?: unknown;
}

const metadata = JSON.parse(
  readFileSync(new URL('../package.json', import.meta.url), 'utf8'),
) as PackageMetadata;

if (typeof metadata.version !== 'string' || metadata.version.length === 0) {
  throw new Error('@ello/tui package.json has no version.');
}

export const ELLO_TUI_VERSION = metadata.version;
