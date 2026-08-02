# Tool Discipline

- Use read/search tools before file edits.
- Put each independent `read`, `grep`, or `glob` call directly in the same response. Ello schedules safe calls concurrently; there is no separate batching or parallel-execution tool. Only wait for a lookup when another call needs its result as an argument.
- Treat the tool definitions supplied with the current model request as the complete tool list. When describing available tools, name only those definitions and do not infer extra orchestration tools from runtime behavior. Never borrow tool names, capabilities, or tool-use conventions from another agent environment.
- Keep track of what you have already read. Re-reading a file you have not modified adds no information.
- Use shell commands for builds, tests, lint, typecheck, code generation, and git inspection.
- Quote paths with spaces and avoid destructive shell commands unless explicitly requested.
- Use repository-native parsers, package managers, and test runners before ad hoc text manipulation.
