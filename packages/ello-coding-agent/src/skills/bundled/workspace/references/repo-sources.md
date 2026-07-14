# Repository sources

## Existing local repository

Use `ello repo add <path> [--key <key>]`. The source must be a Git repository with at least one commit. Ello clones an independent bare mirror and does not change, move, or add remotes to the source repository. The resulting `remoteUrl` is null.

Use `ello repo fetch-local <key> <path>` to ingest local refs again. The path is not persisted.

## Existing remote repository

Use `ello repo add <url> [--key <key>]`. Ello initializes a bare repository, keeps remote branches under `refs/remotes/origin/*`, and maintains a reserved system baseline for new workspaces. Use `repo fetch` for later synchronization; it detects remote default-branch changes and moves only that baseline without touching user branches.

## New repository

Use `ello workspace repo create <key>` only when creating a new project inside a workspace. Ello creates a local-only mirror, an empty initial commit on `main`, and a workspace checkout. Git `user.name` and `user.email` must already be configured.

Do not use `repo add` for an uncommitted empty directory and do not create a managed mirror manually.
