import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

process.env.ELLO_HOME = mkdtempSync(path.join(tmpdir(), 'ello-test-home-'));
