# Workspace lifecycle

- Create: `feature` and `fix` checkouts share the `<kind>/<name>` branch; `explore` checkouts are detached. Repositories live under `repos/`; `tmp/` and `docs/` start empty. Only an active or missing record blocks the selector.
- Reuse selector: archived and deleted records do not block create. A new workspace ID and active root are created, the repository set may differ, and every archived generation remains a detached snapshot under its unique timestamp/ID path.
- Add repository: run from the exact workspace root or pass `--workspace <kind/name>`. The checkout adopts the existing shared branch or detached mode.
- Remove repository: dirty worktrees fail. Use `--force` only when the user explicitly accepts losing changes.
- Rename: changes the workspace directory and bound tmux session, repairs Git worktree paths, and keeps the existing development branch.
- Archive: requires clean worktrees, converts every checkout to detached mode, records its archive-time `headCommit`, preserves complete `repos/`, `docs/`, and `tmp/` content, moves the root to a unique timestamp/ID path, repairs every mirror's worktree path, and releases the shared branch for a new generation.
- Delete: `delete <kind/name>` prefers active through normal selector resolution. Use `delete <kind/name> --archived` for explicit archived intent when exactly one archived generation matches, or `delete --id <workspace-id>` after listing generations. It removes managed worktrees and the complete workspace root. Use `--force` only with explicit user intent.
- Reconcile: use `ello workspace reconcile <kind/name>` for the selector-resolved generation, `--id` for an exact archived generation, or omit both to diagnose all active/archived/missing records. It records observations but does not repair the filesystem.
- Repair: use `ello workspace repair <kind/name>` for the selector-resolved generation, `--id` for an exact archived generation, or omit both to repair all. It recreates `repos/tmp/docs`, restores deleted managed checkouts from mirrors, restores archived checkouts at their recorded commit, repairs worktree metadata, and normalizes SQLite paths. It preserves dirty checkout content and fails on unmanaged directories, invalid checkouts, and destructive conflicts.

Selector-based `show`, `path`, `status`, `reconcile`, and `repair` prefer the active generation. List archived generations and IDs with `ello --json workspace archived [<kind/name>]`, then inspect or repair a specific generation with `--id` and report its exact path.
