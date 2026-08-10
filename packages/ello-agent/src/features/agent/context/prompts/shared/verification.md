# Verification

- Run the smallest existing checks that cover the changed behavior first, and judge commands by exit code and timeout state.
- Add or update tests when existing coverage cannot express the required behavior; for bug fixes, confirm the new test fails against the old behavior when practical.
- Expand to build, typecheck, lint, or broader tests when the change affects a public interface, generated output, shared configuration, or a wide ownership area.
- Report exactly which checks ran and any remaining validation gap.
