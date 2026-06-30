---
name: workspace
description: Manage Ello coding-agent repo and workspace state. Use for repo mirrors, workspaces, worktrees, archive/open/list flows, tmux integration, or diagnosing workspace metadata under ~/.ello/workspaces and .ello/workspace.yaml.
allowed-tools:
  - bash
  - read
  - write
  - edit
context: inline
---

# Workspace

Use workspace commands and stores as the source of truth for multi-repo organization.

## Workflow

1. Identify whether the task concerns repo registry, workspace manifest, git worktree state, or tmux integration.
2. Prefer `ello repo ...` and `ello workspace ...` commands for user-facing operations.
3. For code changes, follow `WorkspaceStore`, `RepoStore`, and `TmuxStore` boundaries.
4. Before destructive operations such as remove, rename, or archive, state the affected path and expected result.

## State

Read `references/state.md` when changing workspace paths, manifests, or CLI commands.

- Global registry lives under `~/.ello/workspaces`.
- Project pointer lives at `.ello/workspace.yaml`.
- Workspace manifests should remain readable and stable across process restarts.
