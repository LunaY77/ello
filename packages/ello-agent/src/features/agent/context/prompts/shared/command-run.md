## Command Run

`command_run` is the only model-visible Tool. Use Commands inside it for all environment and Ello capabilities.

### 1. Batch and order

1. Emit at most one `command_run` per model response.
2. A single `command_run` is your only parallelism unit: Include all currently known actions whose inputs are available in this batch.
3. Commands in the same `step` must be independent; dependent Commands use a later `step`. Two dependency kinds decide placement:
   - Step dependency: a later Command only needs the earlier one to have _run_; its inputs are already fully known (e.g. create a script, then run it). Put it in a later `step` of the same batch.
   - Output dependency: a later Command consumes the _content_ of an earlier result, invisible inside a batch. Send it in the next model turn.
4. Never construct a Command from output you have not yet seen; do not treat step dependencies as output dependencies.
5. Batch independent work to minimize model round trips, including speculative read-only probes that may fail cheaply. Do not chain independent reads or searches inside one `bash` line to save a frame.
6. Do not emit empty batches.
7. When a result is reduced to a bounded preview, narrow the next Command instead of rerunning the same one.

Example batch: independent probes in step 1; creating a script in step 2; running it in step 3 — every input known in advance, so it is one batch.

### 2. Command Frames

1. Treat the current Command Catalog as authoritative. Do not invent Commands, fields, arguments, or calling conventions.
2. Frames may use only `step`, `command`, `args`, `body`, `input`, and `onFailure` as allowed by the selected Command.
3. Put positional arguments and options in `args` as separate strings without shell quoting.
4. Use `body` only when the Command accepts Shell code, patches, or file content.
5. Use `input` only when the Command requires structured input.
6. Prefer the registered `search` Command for repository search. Use `rg` in `bash` only when already known to be available.

### 3. Capability discovery

1. Use `command_search` when the required capability name or schema is unknown.
2. If invocation depends on its result, invoke that capability in the next model turn rather than guessing.
3. Do not place dependent work after a Deferred Command.

### 4. Failure

1. Commands in the same `step` must be independent; dependent Commands use a later `step`. They are attempted independently of each other; `onFailure` only governs the later `step`s.
2. For batched independent read-only probes, explicitly set `onFailure: "continue"`. The runtime default is `stop` when the field is omitted, so keep it only when a later step depends on this Command succeeding or its failure would corrupt later mutations.
3. Use `onFailure: "diagnose"` only for permitted read-only diagnosis of an earlier failure.
4. Do not assume rollback. After uncertain or partial mutation, establish durable state before retrying.

### 5. Local programs

1. Use short Python, Node, or Shell programs through `bash` when they materially reduce dependent loops, filtering, aggregation, polling, or verification.
2. Use `write` plus `bash` for reusable scripts.
3. Local programs must not bypass Tool policy, authorization, Skills, Tasks, Subagents, MCP, Memory, or user-input mechanisms.
4. Keep ordinary repository edits visible through `write` or `apply_patch`.
