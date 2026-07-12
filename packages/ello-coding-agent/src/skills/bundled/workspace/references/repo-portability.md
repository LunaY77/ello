# Repository portability

Export all repositories with `ello repo export --output <dir>` or select keys before `--output`.

The output contains `repos.yaml` and `bundles/`. Remote-backed repositories export fetchable metadata only. Local-only repositories include a Git bundle with all refs. Credentials embedded in a remote URL make export fail.

Import with `ello repo import <dir>`. Import validates every entry and key conflict first, generates new repository IDs, rebuilds mirrors, and restores only repository registry state. It does not create workspaces, worktrees, sessions, tasks, goals, or memory.

Remote-backed unpushed refs are not included. Push them before export if they must move to the target machine.
