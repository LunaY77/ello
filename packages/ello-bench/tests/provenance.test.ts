import { access } from 'node:fs/promises';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { REPOSITORY_ROOT } from '../src/infra/provenance.js';

describe('run provenance', () => {
  it('resolves the monorepo root after infrastructure compilation', async () => {
    expect(REPOSITORY_ROOT).toBe(path.resolve(process.cwd(), '..', '..'));
    await expect(
      access(path.join(REPOSITORY_ROOT, 'pnpm-lock.yaml')),
    ).resolves.toBeUndefined();
  });
});
