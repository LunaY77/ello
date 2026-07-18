import { mkdir, open, readFile, rename, rm } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';

import { z } from 'zod';

import { themeNames } from '../tui/theme/index.js';

const LocalUiConfigSchema = z
  .object({
    schema: z.literal(1),
    theme: z.enum(themeNames),
    recentEndpoint: z.string().min(1).optional(),
    keymap: z.record(z.string().min(1), z.string().min(1)).default({}),
  })
  .strict();

export type LocalUiConfig = z.infer<typeof LocalUiConfigSchema>;

export const DEFAULT_LOCAL_UI_CONFIG: LocalUiConfig = {
  schema: 1,
  theme: 'tokyo-night',
  keymap: {},
};

/** Client 本地状态只保存显示偏好，不允许混入 provider、权限或 Server 配置。 */
export function localUiConfigPath(
  environment: NodeJS.ProcessEnv = process.env,
  home = homedir(),
): string {
  const root = environment.ELLO_HOME?.trim();
  return path.join(root === undefined || root === '' ? path.join(home, '.ello') : path.resolve(root), 'tui.json');
}

export async function loadLocalUiConfig(
  filePath = localUiConfigPath(),
): Promise<LocalUiConfig> {
  let text: string;
  try {
    text = await readFile(filePath, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return DEFAULT_LOCAL_UI_CONFIG;
    }
    throw error;
  }
  return LocalUiConfigSchema.parse(JSON.parse(text));
}

export async function saveLocalUiConfig(
  config: LocalUiConfig,
  filePath = localUiConfigPath(),
): Promise<void> {
  const parsed = LocalUiConfigSchema.parse(config);
  await mkdir(path.dirname(filePath), { recursive: true });
  const temporaryPath = `${filePath}.${process.pid}.tmp`;
  await rm(temporaryPath, { force: true });
  const handle = await open(temporaryPath, 'wx', 0o600);
  let handleClosed = false;
  try {
    await handle.writeFile(`${JSON.stringify(parsed, null, 2)}\n`, 'utf8');
    await handle.sync();
  } catch (error) {
    await handle.close();
    handleClosed = true;
    await rm(temporaryPath, { force: true });
    throw error;
  } finally {
    if (!handleClosed) await handle.close();
  }
  try {
    await rename(temporaryPath, filePath);
  } catch (error) {
    await rm(temporaryPath, { force: true });
    throw error;
  }
}
