/**
 * 容器与宿主机 runner 交替写同一个 bind mount 里的 Git 仓库，因此容器必须以
 * 宿主机 uid/gid 运行，否则容器写出的 `.git` 对象与产物目录归 root，宿主机
 * 随后的 `git add -A` 与临时目录清理会因权限不足失败。
 */
export const CONTAINER_HOME = '/tmp/ello-bench-home';

export function hostContainerUser(): string {
  if (process.getuid === undefined || process.getgid === undefined) {
    throw new Error(
      'Benchmark containers require a POSIX host that exposes uid and gid.',
    );
  }
  return `${String(process.getuid())}:${String(process.getgid())}`;
}
