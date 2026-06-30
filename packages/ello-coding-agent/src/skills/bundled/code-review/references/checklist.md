# Code Review Checklist

Use this reference when a review needs a deeper pass than the short workflow in
`SKILL.md`.

## Findings

Prefer findings that can be acted on immediately:

- correctness regressions
- data loss or persistence bugs
- security and permission boundary failures
- missing validation at trust boundaries
- broken public API or CLI behavior
- missing tests for risky behavior

## Non-Findings

Do not report style preferences unless they create a concrete maintenance risk.
Do not repeat what the diff already says.

## Output Shape

Lead with issues, ordered by severity. Each issue should include file and line
evidence, impact, and a concrete fix direction.
