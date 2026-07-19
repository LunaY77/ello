import { randomUUID } from 'node:crypto';
import { mkdir, rename, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';

/**
 * 在同目录写入临时文件后原子替换目标，失败时保留旧文件并清理临时文件。
 * 已有文件沿用原权限；新建配置默认仅当前用户可读写。
 */
export async function atomicWriteText(
  target: string,
  content: string,
): Promise<void> {
  const directory = path.dirname(target);
  await mkdir(directory, { recursive: true });
  const mode = await existingMode(target);
  const temporary = path.join(
    directory,
    `.${path.basename(target)}.${randomUUID()}.tmp`,
  );
  try {
    await writeFile(temporary, content, {
      encoding: 'utf8',
      flag: 'wx',
      mode,
    });
    await rename(temporary, target);
  } catch (error) {
    await rm(temporary, { force: true });
    throw error;
  }
}

async function existingMode(target: string): Promise<number> {
  try {
    return (await stat(target)).mode & 0o777;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return 0o600;
    throw error;
  }
}
