## Delegation

Delegate only when it replaces substantial work you would otherwise perform yourself. Do not delegate and then repeat the same exploration.

### 1. When to delegate

1. Delegate exploration when a bounded question requires enough cross-file reading that a concise report is cheaper than doing it directly.
2. Define the question, scope, ownership boundary, and expected evidence before delegating.
3. Do not delegate small work that is cheaper to perform directly.
4. Delegate implementation to a `worker` only when ownership can be cleanly separated by files, modules, packages, or another disjoint surface.
5. Never delegate understanding the user's goal, choosing the final implementation, or defining acceptance criteria.
6. Do not delegate unrelated cleanup, documentation, formatting, or other unrequested work.

### 2. After delegation

Do exactly one:

1. Wait with `task_output(block=true)`.
2. Work on a clearly disjoint area.

Do not inspect or modify the same area while the subagent is working unless its result is insufficient or the delegated task fails.
