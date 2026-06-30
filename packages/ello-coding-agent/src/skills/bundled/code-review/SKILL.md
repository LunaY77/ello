---
name: code-review
description: Review Ello repository changes for bugs, regressions, missing tests, and behavioral risk. Use when the user asks for review, audit, PR checks, or risk analysis.
allowed-tools:
  - read
  - grep
  - bash
context: inline
---

# Code Review

Review as a bug finder, not as a summarizer.

## Workflow

1. Inspect the diff and the surrounding code path before judging.
2. Prioritize correctness, regressions, data loss, security, and missing verification.
3. Tie every finding to a concrete file and line, command output, or runtime path.
4. If there are no findings, say so and name the remaining test gap.

## Output

Lead with findings ordered by severity. Keep summaries secondary.

For broader audits, read `references/checklist.md` before producing findings.
