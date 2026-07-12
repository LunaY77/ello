# Troubleshooting

- Invalid workspace mount: keep the default `~/.ello` or set an absolute path with `ello config set workspace.mount /absolute/path --global`, then retry.
- Dirty worktree: run `ello --json workspace status <kind/name>`, preserve or commit changes, then retry. Use `--force` only with explicit approval.
- Branch conflict: run `ello --json workspace archived <kind/name>` and `ello --json workspace reconcile`, then repair the affected generation by ID. Archive normally detaches its checkouts and releases the selector branch; if another unmanaged worktree still occupies the branch, report its exact path instead of choosing a different selector or resetting it.
- Missing remote: inspect `ello --json repo remote show <key>`, then use `repo remote add` for a local-only repository or exclude it from keyed fetch.
- Tmux drift: run the failed workspace lifecycle command again; archive/delete clear a binding when the external session is already absent.
- Key collision: run `ello --json repo show <key>` and choose an explicit unused `--key`; import never merges or auto-renames keys.
- Filesystem drift: run `ello --json workspace reconcile <kind/name>` to inspect the selector-resolved generation, then `ello --json workspace repair <kind/name>`. For a manually deleted archive directory, select its ID from `workspace archived`, run `reconcile --id <workspace-id>`, then `repair --id <workspace-id>` before inspecting or deleting it.
- Multiple archived generations: never guess from the selector. Run `ello --json workspace archived <kind/name>`, then pass the chosen ID to `show`, `status`, `reconcile`, `repair`, or `delete`.
