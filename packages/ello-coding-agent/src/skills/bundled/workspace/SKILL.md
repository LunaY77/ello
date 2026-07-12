---
name: workspace
description: Manage Ello multi-repository workspaces through the installed ello CLI. Use when the user asks to register or synchronize local/remote Git repositories, create feature/fix/explore workspaces, reuse a selector after archive, list or delete archived generations, repair filesystem/SQLite drift, keep one branch name across repositories, create a new repository inside a workspace, manage workspace-bound tmux lifecycle, or export/import the repo registry, including Chinese requests such as 创建工作空间、多仓开发、本地仓库没有远端、给工作空间加仓库、归档工作空间、删除归档、修复工作空间、迁移仓库列表.
---

# Ello Workspace

Use the installed `ello` CLI for every managed repository, worktree, workspace, and tmux mutation. Do not write installation scripts or probe the CLI version. If exact syntax is uncertain, run `ello <group> --help` or `ello <group> <command> --help`. Put global `--json` before the command when machine-readable output is needed.

Do not call `git worktree`, `git clone --mirror`, or `tmux` directly for managed state.

## Directory model

```text
<configured-mount>/
├── workspace/<kind>/<name>/{repos,tmp,docs}
└── archive/<kind>/<name>-<timestamp>-<workspace-id>/{repos,tmp,docs}

~/.ello/mirrors/<repository-id>.git
```

## Choose the operation

- Existing local repository with commits: `ello repo add <path>`.
- Existing remote URL: `ello repo add <url>`.
- New project inside the current workspace: `ello workspace repo create <key>`.
- Multi-repository feature or fix: register repositories first, then create one workspace; every checkout shares the workspace branch.
- Reusing an archived selector: run the same `workspace create`; Ello creates a new active generation while retaining archived generations as detached snapshots.
- Move repository registry state between machines: use `ello repo export` and `ello repo import`.
- Workspace/SQLite drift: run `workspace reconcile` first, then `workspace repair`; omit the selector to scan all registered workspaces.
- Never use workspace export/import.
- Create tmux only with `workspace create --tmux [name]` or `workspace tmux new`; do not attach or list sessions through Ello.

## Mutation workflow

1. Read active state with `list`, `show`, or `status`; use `archived` and then `--id` for a specific archived generation.
2. Run one explicit mutation.
3. Read its JSON result.
4. Run `show` or `status` again, with `--id` when verifying an archived generation.
5. Report the workspace path, shared branch, repository paths, tmux session, or archive path that changed.

## Guardrails

- Confirm that no active, archived, or missing workspace generation references a repository before `repo remove`.
- Check dirty status before workspace repo removal, archive, or delete.
- State explicitly when `remoteUrl` is null; adding a remote does not push commits.
- Archive preserves complete `repos/`, `docs/`, and `tmp/` content, converts every checkout to a detached commit snapshot, records its archive-time `headCommit`, repairs worktree paths, and kills bound tmux.
- Delete removes the complete workspace root, removes managed worktrees, and kills bound tmux.
- Delete archived generations with `--archived` only when one version matches; otherwise select an ID from `workspace archived` and use `--id`.
- Repair never overwrites dirty checkouts or deletes unmanaged directories; report conflicts that require user judgment.
- Do not modify coding-agent session, task, goal, context, memory, or checkpoint state.

Read the relevant reference before acting:

- [commands.md](references/commands.md): full command tree and global flag placement.
- [repo-sources.md](references/repo-sources.md): local import, remote import, fetch-local, and new repositories.
- [workspace-lifecycle.md](references/workspace-lifecycle.md): create/add/remove/rename/archive/delete behavior.
- [tmux-lifecycle.md](references/tmux-lifecycle.md): workspace-bound tmux create, rename, and kill behavior.
- [repo-portability.md](references/repo-portability.md): repository export/import contracts.
- [troubleshooting.md](references/troubleshooting.md): deterministic next commands for common failures.
