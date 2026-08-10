export const SWE_BENCH_PRO_BASELINE_VERIFIER = String.raw`import json
import pathlib
import subprocess
import sys


def read_json(path):
    with path.open(encoding="utf-8") as handle:
        return json.load(handle)


tests_root = pathlib.Path("/tests")
logs_root = pathlib.Path("/logs")
verifier_root = logs_root / "verifier"
verifier_root.mkdir(parents=True, exist_ok=True)
spec = read_json(tests_root / "spec.json")
selected_tests = spec["passToPass"]

stdout_path = verifier_root / "test-stdout.log"
stderr_path = verifier_root / "test-stderr.log"
with stdout_path.open("w", encoding="utf-8") as stdout_handle, stderr_path.open(
    "w", encoding="utf-8"
) as stderr_handle:
    subprocess.run(
        ["bash", str(tests_root / "run_script.sh"), ",".join(selected_tests)],
        cwd="/app",
        stdout=stdout_handle,
        stderr=stderr_handle,
        check=False,
    )

output_path = verifier_root / "output.json"
subprocess.run(
    [
        sys.executable,
        str(tests_root / "parser.py"),
        str(stdout_path),
        str(stderr_path),
        str(output_path),
    ],
    check=True,
)
output = read_json(output_path)
passed = {
    result["name"]
    for result in output.get("tests", [])
    if result.get("status") == "PASSED"
}
result = 0 if set(selected_tests).issubset(passed) else 1
print(f"[verifier] Baseline exit code: {result}")
`;
