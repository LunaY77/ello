# Skill Format

An Ello skill is a directory with a required `SKILL.md` file and optional
resources.

```text
skill-name/
  SKILL.md
  references/
  scripts/
  assets/
```

## SKILL.md

The file starts with YAML frontmatter:

```markdown
---
name: skill-name
description: Trigger guidance that explains when to use the skill.
allowed-tools:
  - read
  - bash
context: inline
---

# Skill Name

Concise workflow instructions.
```

Only `name` and `description` are essential for discovery. Put large procedural
details in `references/` and deterministic operations in `scripts/`.
