/**
 * 容器与宿主机 runner 交替写同一个 bind mount 里的 Git 仓库，因此容器必须以
 * 宿主机 uid/gid 运行，否则容器写出的 `.git` 对象与产物目录归 root，宿主机
 * 随后的 `git add -A` 与临时目录清理会因权限不足失败。任务镜像以 root
 * 构建，因此运行时接管镜像 HOME 的目录所有权，让任意 HOME-bound 工具链
 * 保持可发现、可创建状态，同时不复制整个 root HOME。
 */
export const CONTAINER_HOME = '/root';

export function hostContainerIdentity(): {
  readonly uid: number;
  readonly gid: number;
} {
  if (process.getuid === undefined || process.getgid === undefined) {
    throw new Error(
      'Benchmark containers require a POSIX host that exposes uid and gid.',
    );
  }
  return { uid: process.getuid(), gid: process.getgid() };
}

export function hostContainerUser(): string {
  const user = hostContainerIdentity();
  return `${String(user.uid)}:${String(user.gid)}`;
}
