---
name: skill-creator
description: Create or update Ello/Codex-style skill packages. Use when users ask to add a reusable skill, convert prompt text into a skill, validate a skill directory, or package workflow knowledge as SKILL.md plus resources.
allowed-tools:
  - read
  - write
  - edit
  - bash
context: inline
---

# Skill Creator

Skills are directories, not inline prompt blobs.

## Required Layout

Read `references/skill-format.md` when exact structure or metadata fields matter.

```text
skill-name/
  SKILL.md
  references/
  scripts/
  assets/
```

Only `SKILL.md` is required. Add references, scripts, or assets only when they reduce repeated context or make execution more reliable.

## SKILL.md

Use YAML frontmatter followed by concise Markdown instructions:

```markdown
---
name: skill-name
description: Clear trigger guidance that explains when to use the skill.
allowed-tools:
  - read
  - bash
context: inline
---

# Skill Name

Core workflow and routing guidance.
```

## Rules

- Put trigger information in `description`; keep body for workflow.
- Prefer short `SKILL.md` files with links to `references/` for details.
- Do not add extra README or changelog files unless the skill genuinely needs them.
- Validate with `scripts/validate_skill.mjs <skill-dir>` or by loading the parent skills directory with the project skill loader.
