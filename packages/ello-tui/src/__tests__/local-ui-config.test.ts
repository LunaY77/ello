import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import {
  DEFAULT_LOCAL_UI_CONFIG,
  loadLocalUiConfig,
  localUiConfigPath,
  saveLocalUiConfig,
} from '../config/local-ui-config.js';

describe('local UI config', () => {
  let root: string | undefined;

  afterEach(async () => {
    if (root !== undefined) await rm(root, { force: true, recursive: true });
  });

  it('缺少文件时返回唯一默认值', async () => {
    root = await mkdtemp(join(tmpdir(), 'ello-tui-config-'));
    await expect(loadLocalUiConfig(join(root, 'missing.json'))).resolves.toEqual(
      DEFAULT_LOCAL_UI_CONFIG,
    );
  });

  it('以 0600 原子保存并严格读取 Client 显示偏好', async () => {
    root = await mkdtemp(join(tmpdir(), 'ello-tui-config-'));
    const filePath = join(root, 'nested', 'tui.json');
    await saveLocalUiConfig(
      { schema: 1, theme: 'github-dark', keymap: { submit: 'enter' } },
      filePath,
    );
    expect((await stat(filePath)).mode & 0o777).toBe(0o600);
    await expect(loadLocalUiConfig(filePath)).resolves.toEqual({
      schema: 1,
      theme: 'github-dark',
      keymap: { submit: 'enter' },
    });
    expect(await readFile(filePath, 'utf8')).toContain('"schema": 1');
  });

  it('拒绝 Server-owned 字段和未知 schema', async () => {
    root = await mkdtemp(join(tmpdir(), 'ello-tui-config-'));
    const filePath = join(root, 'tui.json');
    await writeFile(
      filePath,
      JSON.stringify({ schema: 2, theme: 'tokyo-night', provider: {} }),
    );
    await expect(loadLocalUiConfig(filePath)).rejects.toThrow();
  });

  it('ELLO_HOME 只决定 Client 配置位置', () => {
    expect(localUiConfigPath({ ELLO_HOME: '/tmp/ello-home' }, '/home/test')).toBe(
      '/tmp/ello-home/tui.json',
    );
  });
});
