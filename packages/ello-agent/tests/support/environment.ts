/**
 * 测试专用 Environment Handle。
 *
 * 不关心 I/O 的测试通过该夹具满足完整契约；一旦被测代码意外访问文件或进程，夹具会立即失败。
 */
import path from 'node:path';

import type {
  EnvironmentFileSystem,
  EnvironmentHandle,
  EnvironmentProcesses,
} from '../../src/features/environment/index.js';

/** 创建不执行外部 I/O 的严格测试 Handle。 */
export function createTestEnvironmentHandle(
  workingDirectory = '/workspace',
): EnvironmentHandle {
  let closed = false;
  const assertOpen = () => {
    if (closed) throw new Error('Test Environment Handle is closed.');
  };
  const unsupportedError = (operation: string): Error => {
    assertOpen();
    return new Error(`Unexpected test Environment operation: ${operation}`);
  };
  const fileSystem: EnvironmentFileSystem = {
    resolvePath(targetPath) {
      assertOpen();
      return path.resolve(workingDirectory, targetPath);
    },
    stat: () => Promise.reject(unsupportedError('fileSystem.stat')),
    readFile: () => Promise.reject(unsupportedError('fileSystem.readFile')),
    readText: () => Promise.reject(unsupportedError('fileSystem.readText')),
    writeFile: () => Promise.reject(unsupportedError('fileSystem.writeFile')),
    writeText: () => Promise.reject(unsupportedError('fileSystem.writeText')),
    listDir: () => Promise.reject(unsupportedError('fileSystem.listDir')),
    remove: () => Promise.reject(unsupportedError('fileSystem.remove')),
  };
  const processes: EnvironmentProcesses = {
    exec: () => Promise.reject(unsupportedError('processes.exec')),
    spawn: () => Promise.reject(unsupportedError('processes.spawn')),
    inspect: () => Promise.reject(unsupportedError('processes.inspect')),
    write: () => Promise.reject(unsupportedError('processes.write')),
    closeStdin: () =>
      Promise.reject(unsupportedError('processes.closeStdin')),
    wait: () => Promise.reject(unsupportedError('processes.wait')),
    signal: () => Promise.reject(unsupportedError('processes.signal')),
  };
  return {
    environmentRef: 'test',
    generation: 1,
    workingDirectory: path.resolve(workingDirectory),
    grant: { isolation: 'none' },
    fileSystem,
    processes,
    getInstructions: () => {
      assertOpen();
      return Promise.resolve(null);
    },
    close: () => {
      closed = true;
      return Promise.resolve();
    },
  };
}
