/**
 * Local Profile 的单实例 Host Environment adapter。
 *
 * 一个 Host 只有一个稳定 Environment Reference 与 generation；每次 attach 只绑定不同的
 * Working Directory 和不可变 Grant，关闭 Handle 不销毁 Environment。
 */
import { randomUUID } from 'node:crypto';
import { lstat, realpath } from 'node:fs/promises';
import path from 'node:path';

import type {
  CreateLocalEnvironmentsOptions,
  EnvironmentGrant,
  EnvironmentHandle,
  Environments,
  ExecutionLocation,
} from './contracts.js';
import { createLocalFileSystem } from './filesystem.js';
import {
  createLocalProcessRegistry,
  type LocalProcessRegistry,
} from './processes.js';

export const LOCAL_HOST_ENVIRONMENT_REFERENCE = 'local-host';
const LOCAL_HOST_GENERATION = 1;

/**
 * 创建一个 Host 生命周期内稳定的 Local Environment 集合。
 *
 * Args:
 * - `options`: 可选引用、shell executable 与进程输出保留上限。
 *
 * Returns:
 * - 返回只管理一个 Local Host Environment 的 adapter。
 */
export function createLocalEnvironments(
  options: CreateLocalEnvironmentsOptions = {},
): Environments {
  const environmentRef =
    options.environmentRef ?? LOCAL_HOST_ENVIRONMENT_REFERENCE;
  if (environmentRef.trim() === '') {
    throw new Error('Local Environment Reference must not be empty.');
  }
  return new LocalEnvironments(
    environmentRef,
    createLocalProcessRegistry(
      environmentRef,
      LOCAL_HOST_GENERATION,
      options.shellExecutable,
      options.processOutputLimitBytes,
    ),
  );
}

class LocalEnvironments implements Environments {
  private closed = false;

  constructor(
    private readonly environmentRef: string,
    private readonly processRegistry: LocalProcessRegistry,
  ) {}

  /**
   * 为 Local Host Environment 建立一个受限 Handle。
   *
   * Args:
   * - `location`: 必须指向唯一 Local Reference 和已存在的绝对目录。
   * - `grant`: Local v1 只接受真实表达无附加隔离的 grant。
   *
   * Returns:
   * - Promise 兑现为绑定当前 generation 的新 Handle。
   */
  async attach(
    location: ExecutionLocation,
    grant: EnvironmentGrant,
  ): Promise<EnvironmentHandle> {
    if (this.closed) throw new Error('Local Environments is closed.');
    if (location.environmentRef !== this.environmentRef) {
      throw new Error(
        `Unknown Local Environment Reference: ${location.environmentRef}`,
      );
    }
    if (grant.isolation !== 'none') {
      throw new Error(
        `Unsupported Local Environment isolation: ${grant.isolation}`,
      );
    }
    if (!path.isAbsolute(location.workingDirectory)) {
      throw new Error('Environment workingDirectory must be absolute.');
    }
    const workingDirectory = await realpath(location.workingDirectory);
    const info = await lstat(workingDirectory);
    if (!info.isDirectory()) {
      throw new Error(
        `Environment workingDirectory is not a directory: ${workingDirectory}`,
      );
    }
    const ownerId = randomUUID();
    let handleClosed = false;
    const assertOpen = () => {
      if (this.closed) throw new Error('Environment generation is closed.');
      if (handleClosed) throw new Error('Environment Handle is closed.');
    };
    const fileSystem = createLocalFileSystem(workingDirectory, assertOpen);
    const processes = this.processRegistry.createHandle(
      ownerId,
      workingDirectory,
      assertOpen,
    );
    return {
      environmentRef: this.environmentRef,
      generation: LOCAL_HOST_GENERATION,
      workingDirectory,
      grant: { ...grant },
      fileSystem,
      processes,
      getInstructions: async () => {
        assertOpen();
        return [
          '<environment-context>',
          `  <environment-reference>${this.environmentRef}</environment-reference>`,
          `  <generation>${LOCAL_HOST_GENERATION}</generation>`,
          `  <working-directory>${workingDirectory}</working-directory>`,
          '  <isolation>none</isolation>',
          '</environment-context>',
        ].join('\n');
      },
      close: async () => {
        if (handleClosed) return;
        handleClosed = true;
        await this.processRegistry.closeOwner(ownerId);
      },
    };
  }

  /**
   * 关闭 Local Environment generation 的全部进程。
   *
   * Args:
   * - 无：重复关闭直接返回。
   *
   * Returns:
   * - Promise 在 attached 与 background 进程全部退出后兑现。
   */
  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    await this.processRegistry.close();
  }
}
