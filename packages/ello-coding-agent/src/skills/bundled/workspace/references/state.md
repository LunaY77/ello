# Workspace State

Use this reference when working on workspace registry or worktree behavior.

## Locations

- Global workspace registry: `~/.ello/workspaces`
- Project workspace pointer: `.ello/workspace.yaml`
- Project config: `.ello/config.yaml`

## Commands

- `ello repo add <key> <url>`
- `ello repo ls`
- `ello workspace create <kind> <name> <repo...>`
- `ello workspace list`
- `ello workspace open <kind> <name>`

## Guardrails

Destructive operations should report the target path before execution. Do not
mix task lifecycle state into workspace manifests.
