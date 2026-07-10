# Dream: Memory Consolidation

You are performing a dream — a reflective pass over your memory files. Synthesize what you've learned recently into durable, well-organized memories so that future sessions can orient quickly.
Private memory directory: `{{ private_memory_dir }}`
Team memory directory: `{{ team_memory_dir }}`
These directories already exist — write to them directly with the memory tools (do not run mkdir or check for their existence).
Session transcripts: `{{ session_dir }}` (large JSONL files — search narrowly, don't read whole files)

---

## Phase 1 — Orient

- Use `memory_list` for both scopes and read both `MEMORY.md` indexes.
- Read relevant existing topic files so you improve them rather than creating duplicates.
- Use `session_list_recent` to inspect the bounded recent session catalog.

## Phase 2 — Gather recent signal

Look for new information worth persisting. Sources in rough priority order:

1. **Recent sessions** — use `session_list_recent` for the most recent 1–3 days, then `session_search` with a narrow query, explicit date range, and bounded limit.
2. **Existing memories that drifted** — facts that contradict something you see in the codebase now.
3. **Transcript search** — if you need specific context, use `session_search`; never exhaustively read transcripts.
   Don't exhaustively read transcripts. Look only for things you already suspect matter.

## Phase 3 — Consolidate

For each thing worth remembering, write or update a top-level memory topic using the memory tools. Use the memory file format and type conventions from your system prompt's auto-memory section — it's the source of truth for what to save, how to structure it, and what NOT to save.
Focus on:

- Merging new signal into existing topic files rather than creating near-duplicates.
- Converting relative dates ("yesterday", "last week") to absolute dates so they remain interpretable after time passes.
- Deleting contradicted facts — if today's investigation disproves an old memory, fix it at the source.
- Using `repo_current_read` and `repo_current_search` only to verify a specific stale claim; they cannot access memory roots.

## Phase 4 — Prune and index

Keep both `MEMORY.md` files under 200 lines AND under ~25KB. They are indexes, not dumps — each entry is one line: `- [Title](file.md) — one-line hook`. The repository regenerates the index after every topic mutation.

- Remove pointers to memories that are now stale, wrong, or superseded by deleting or updating the source topic.
- Demote verbose entries by shortening the topic description and moving detail into the topic body.
- Add pointers to newly important memories through `memory_write`.
- Resolve contradictions — if two files disagree, fix the wrong one.

---

Return a brief summary of what you consolidated, updated, or pruned. If nothing changed (memories are already tight), say so.
