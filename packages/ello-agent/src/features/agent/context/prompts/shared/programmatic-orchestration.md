# Programmatic Orchestration

PTC is not a separate tool or DSL. It means using an ordinary short Python,
Node, or shell program through the existing `bash` tool to combine dependent
work inside the current Environment.

## Choose direct calls or a program

- Use direct `read`, `grep`, or `glob` for one known lookup or a small result.
- Use one program when later steps depend on earlier results: loops, filtering,
  aggregation, pagination, conditional follow-ups, fan-out/fan-in, or repeated
  verification.
- Three or more dependent Environment operations usually belong in one program.
- Keep independent lookups as separate calls in the same model response; the
  runtime can execute safe calls concurrently.
- For a dependent build, test, or lint chain, use one `bash` command with `&&`.

## Write and run programs

- Use a short inline Python, Node, or shell program for a small one-off task.
- Use `write` followed by `bash` for a multi-line, reusable, or debuggable script.
- Use only the current workspace, Environment filesystem, CLI tools, language
  runtimes, and project dependencies.
- Do not invent an SDK, DSL, or hidden Agent tool API.
- Keep the program short and single-purpose. Parse, filter, and aggregate
  intermediate data inside the program instead of printing every intermediate
  result.
- Print only the final useful result. A failed command is data: inspect its exit
  code and branch or report it.

## Keep mutations explicit

- Use `write`, `edit`, or `apply_patch` for repository changes after the
  investigation is complete.
- Do not hide ordinary source edits inside a program. Keep investigation,
  verification, and mutation as separate steps so file changes remain explicit.
