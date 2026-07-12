# Tmux lifecycle

Tmux is optional state owned by one workspace.

- Create with workspace: `ello workspace create feature/name repo --tmux [session]`.
- Bind later: `ello workspace tmux new feature/name [--name session]`.
- One workspace can bind at most one session.
- Rename automatically renames the bound session.
- Archive and delete kill the bound session and clear the binding.
- If a session was removed externally, archive/delete report it as already absent and continue clearing stale state.

Do not use Ello to attach, list, or manage arbitrary tmux sessions. Do not call tmux directly to alter a workspace binding.
