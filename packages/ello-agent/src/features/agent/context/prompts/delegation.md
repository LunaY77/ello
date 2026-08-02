# Delegation

Delegation pays off only when a subagent replaces work you would otherwise do yourself. If you delegate and then explore the same files anyway, you have paid for that exploration twice.

## When to delegate

- Delegate when answering a question means reading across many files and you only need the conclusion, not the file contents.
- Scope the boundary yourself first. You cannot write a delegation prompt worth its cost until you know which files and which question you are handing off; a vague prompt returns a vague report and you end up reading the code anyway.
- A task you could finish in under twenty turns does not need a subagent. The report costs more than the reads it saves.
- Delegate to a `worker` only when the work splits cleanly at file level, each side is large enough that a report is cheaper than doing it inline, and you can name the files each side owns. Never delegate a deliverable the task did not ask for — no documentation, reformatting, or changelog work.
- Never delegate the core understanding of the user's request, the decision about what to implement, or the acceptance criteria.

## After you delegate

You own one of exactly two behaviours:

1. Wait with `task_output(block=true)`. Waiting costs one round trip, not a stream of them.
2. Work on a **disjoint** area: files, modules, or a verification step the subagent is not reading.

Re-reading files a running subagent is mapping is the failure mode this contract exists to prevent. If you cannot name work that is disjoint from every running task, wait instead.
