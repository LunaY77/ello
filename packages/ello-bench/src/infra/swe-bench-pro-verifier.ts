export const SWE_BENCH_PRO_VERIFIER = String.raw`import json
import pathlib
import shutil
import subprocess
import sys


def read_json(path):
    with path.open(encoding="utf-8") as handle:
        return json.load(handle)


tests_root = pathlib.Path("/tests")
logs_root = pathlib.Path("/logs")
verifier_root = logs_root / "verifier"
artifacts_root = logs_root / "artifacts"
spec = read_json(tests_root / "spec.json")

stdout_path = verifier_root / "test-stdout.log"
stderr_path = verifier_root / "test-stderr.log"
selected = ",".join(spec["selectedTests"])
with stdout_path.open("w", encoding="utf-8") as stdout_handle, stderr_path.open(
    "w", encoding="utf-8"
) as stderr_handle:
    subprocess.run(
        ["bash", str(tests_root / "run_script.sh"), selected],
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
if not isinstance(output, dict) or set(output) != {"tests"}:
    raise RuntimeError("SWE-bench Pro parser output must contain only tests.")
if not isinstance(output["tests"], list):
    raise RuntimeError("SWE-bench Pro parser tests must be a list.")

passed = set()
seen = set()
for result in output["tests"]:
    if not isinstance(result, dict) or set(result) != {"name", "status"}:
        raise RuntimeError("Invalid SWE-bench Pro parser test result.")
    name = result["name"]
    status = result["status"]
    if not isinstance(name, str) or not name:
        raise RuntimeError("SWE-bench Pro parser emitted an invalid test name.")
    if status not in {"PASSED", "FAILED", "SKIPPED", "ERROR"}:
        raise RuntimeError("SWE-bench Pro parser emitted an invalid test status.")
    if name in seen:
        raise RuntimeError(f"SWE-bench Pro parser emitted duplicate test: {name}")
    seen.add(name)
    if status == "PASSED":
        passed.add(name)

fail_to_pass = set(spec["failToPass"])
pass_to_pass = set(spec["passToPass"])
missing_fail_to_pass = sorted(fail_to_pass - passed)
missing_pass_to_pass = sorted(pass_to_pass - passed)
baseline_exit_code = 0 if not missing_pass_to_pass else 1
new_tests_exit_code = 0 if not missing_fail_to_pass else 1
reward = 1 if baseline_exit_code == 0 and new_tests_exit_code == 0 else 0

(verifier_root / "missing-fail-to-pass.json").write_text(
    json.dumps(missing_fail_to_pass, indent=2) + "\n", encoding="utf-8"
)
(verifier_root / "missing-pass-to-pass.json").write_text(
    json.dumps(missing_pass_to_pass, indent=2) + "\n", encoding="utf-8"
)
(verifier_root / "reward.txt").write_text(f"{reward}\n", encoding="utf-8")
shutil.copyfile(logs_root / "input" / "model.patch", artifacts_root / "model.patch")
print(f"[verifier] Baseline exit code: {baseline_exit_code}")
print(f"[verifier] New tests exit code: {new_tests_exit_code}")
`;
