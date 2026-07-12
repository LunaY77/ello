# Command tree

Put the global flag before the command: `ello --json workspace show feature/name`.

```text
ello repo add [source] [--key <key>]
ello repo list
ello repo show <key>
ello repo rename <key> <new-key>
ello repo remove <key>
ello repo fetch <key...>
ello repo fetch --all
ello repo fetch-local <key> <path>
ello repo remote show <key>
ello repo remote add <key> <url>
ello repo remote set <key> <url>
ello repo remote remove <key>
ello repo export [key...] --output <dir>
ello repo import <dir>

ello workspace create <kind/name> <repo...> [--tmux [name]]
ello workspace list [--kind <kind>] [--status <status>]
ello workspace archived [<kind/name>]
ello workspace show [<kind/name>] [--id <workspace-id>]
ello workspace path [<kind/name>] [--id <workspace-id>]
ello workspace status [<kind/name>] [--id <workspace-id>]
ello workspace repo add <repo...> [--workspace <kind/name>]
ello workspace repo create <key> [--workspace <kind/name>]
ello workspace repo remove <repo...> [--workspace <kind/name>] [--force]
ello workspace rename <kind/name> <new-name>
ello workspace archive <kind/name>
ello workspace delete [<kind/name>] [--archived|--id <workspace-id>] [--force]
ello workspace reconcile [<kind/name>] [--id <workspace-id>]
ello workspace repair [<kind/name>] [--id <workspace-id>]
ello workspace tmux new <kind/name> [--name <name>]
```

`ello ws` is an alias for `ello workspace`. There is no top-level `ello tmux`, workspace open, or workspace export/import command.

Target resolution is command-specific:

- `show`, `path`, and `status` accept either a selector or `--id`; never provide both. `show` and `path` require one of them. A selector prefers the active generation, then resolves one archived generation, and fails when multiple archived generations are ambiguous.
- `status` with no selector or ID resolves the active workspace from the exact current workspace root.
- `reconcile` and `repair` with no selector or ID scan every active, archived, and missing record.
- `delete <kind/name>` uses normal selector resolution and therefore prefers the active generation. For archived deletion intent, add `--archived` when exactly one archived generation matches. Use `delete --id <workspace-id>` for an exact active or archived generation.
- `repo fetch` requires either one or more keys or `--all`; do not provide both and do not omit both.
- Workspace repo mutations and tmux creation accept active workspaces only. Without `--workspace`, repo mutations require the exact workspace root as the current directory.
