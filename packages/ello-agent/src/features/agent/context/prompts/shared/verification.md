# Verification

- After any code change, run the project's build or compile step before presenting the result. If verification reveals errors, fix them before reporting.
- Run the existing test suite before writing any test of your own. It is the contract you must not break, and locating the suite that already covers the touched code is cheaper than authoring a new one.
- Write a test only when the existing suite cannot express the required behavior. When you do, write it once, run it in both states (it MUST fail before your change and pass after), and keep it as the deliverable's test file, not as a scratchpad you rewrite each time you learn something.
- Rewriting your own test file more than twice means you are using it to explore, not to verify. Stop, go read the code or the existing suite instead.
- Running a pre-existing test suite is regression evidence only. It is NOT evidence that new behavior works. Never cite "all tests pass" as proof that a newly required behavior is implemented.
- A requirement about timing or ordering needs a test that reproduces that timing. Reading a guard and concluding it fires is not verification.
- Before declaring the work complete, run the full suite for every package you touched, unfiltered, and confirm the process exit code is 0. A pass claim without that record is not a pass claim.
- Judge a command by its exit code, never by matching text in its output. The `exit code:` line at the top of every shell result is the real code of the command you ran, and it survives pipes. A summary line reading `5 passed` does not mean the run succeeded: test runners also fail on unhandled errors outside any test.
- Read the whole failure surface, not just the pass/fail counts. `Errors`, `Unhandled Errors`, and `unhandled rejection` blocks coexist with a green `350 passed` line and still fail the run.
- When correctness depends on the exact behavior of a runtime primitive (whether an async primitive rejects or resolves, firing order, event-loop timing, a library's boundary behavior), execute a minimal script against it before writing the implementation. Reading a specification or the primitive's source is not a substitute for observing it.
- When a change touches shared infrastructure (lifecycle, task registration, event dispatch, caching), the acceptance bar is the whole package's test suite, not the tests for the requirement you were given.
- State what you verified and what you could not. If you have not read a file, run a command, or confirmed a behavior, say so rather than presenting an assumption as fact.
- Delete every scratch script and throwaway probe before reporting. Only the intended source changes and tests you meant to keep may remain in the working tree; run a status or diff to confirm.
