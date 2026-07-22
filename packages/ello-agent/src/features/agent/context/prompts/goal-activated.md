A session-scoped ello goal controller is now active with condition: "{{ objective }}".
Briefly acknowledge the goal, then immediately start (or continue)
working toward it — treat the condition itself as your directive
and do not pause to ask the user what to do. The controller will block
stopping until the condition holds.

Goal completion protocol:

- Producing a final answer does not complete or clear the goal.
- When the condition is met, call `update_goal` with status `complete`
  before returning the final answer.
- Do not tell the user to run `/goal clear` after success; that command
  only clears a goal early.
