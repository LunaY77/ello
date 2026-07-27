"""Reads a completed run tree into the shapes the charts consume.

This layer is a pure consumer: it never writes into the run tree and never
repairs missing data. A metric that is absent stays absent so the charts can
leave it blank rather than plot a zero that was never measured.
"""

from __future__ import annotations

import json
from collections import Counter
from dataclasses import dataclass, field
from pathlib import Path


@dataclass(frozen=True)
class Round:
    index: int
    status: str
    finish_reason: str | None
    tool_calls: tuple[dict, ...]
    duration_ms: float | None
    input_tokens: int | None
    output_tokens: int | None


@dataclass(frozen=True)
class Attempt:
    attempt_id: str
    attempt_number: int
    task_id: str
    agent_id: str
    is_final: bool
    status: str
    outcome: str | None
    reward: int | None
    rounds: tuple[Round, ...] = field(default=())
    tool_audit: dict | None = None
    unknown_fields: tuple[str, ...] = field(default=())
    terminal_stop_reason: str | None = None
    failure: dict | None = None


@dataclass(frozen=True)
class RunTree:
    run_root: Path
    config_hash: str
    generated_at: str
    report: dict
    attempts: tuple[Attempt, ...]


def load_run_tree(run_root: Path) -> RunTree:
    report_path = run_root / "results" / "suite-report.json"
    if not report_path.exists():
        raise FileNotFoundError(
            f"No suite report at {report_path}. Run `ello-bench report --run-root` first."
        )
    report = _read_json(report_path)
    suite = _read_json(run_root / "suite-manifest.json")
    reported_failures = {
        entry["attemptId"]: entry["failure"] for entry in report["invalidLedger"]
    }
    attempts = tuple(
        _load_attempt(
            Path(attempt_path),
            index == len(attempt_paths) - 1,
            reported_failures,
        )
        for attempt_paths in suite["attempts"].values()
        for index, attempt_path in enumerate(attempt_paths)
    )
    return RunTree(
        run_root=run_root,
        config_hash=report["configHash"],
        generated_at=report["generatedAt"],
        report=report,
        attempts=attempts,
    )


def _load_attempt(
    attempt_path: Path, is_final: bool, reported_failures: dict[str, dict]
) -> Attempt:
    manifest = _read_json(attempt_path)
    harness = manifest.get("harness")
    evidence_reference = manifest.get("agentEvidence")
    rounds: tuple[Round, ...] = ()
    unknown_fields: tuple[str, ...] = ()
    terminal_stop_reason = None
    if evidence_reference is not None:
        evidence = _read_json(Path(evidence_reference["path"]))
        unknown_fields = tuple(
            field
            for field in evidence["unknownFields"]
            if field
            not in {
                "Claude assistant event.error",
                "Claude assistant message.stop_details",
            }
        )
        terminal_stop_reason = evidence["terminalStopReason"]
        rounds = _load_rounds(Path(evidence["rounds"]["path"]))
    audit_reference = manifest.get("toolAudit")
    return Attempt(
        attempt_id=manifest["attemptId"],
        attempt_number=manifest["attempt"],
        task_id=manifest["job"]["taskId"],
        agent_id=manifest["job"]["agentId"],
        is_final=is_final,
        status=manifest["status"],
        outcome=manifest.get("outcome"),
        reward=None if harness is None else harness["reward"],
        rounds=rounds,
        tool_audit=(
            None
            if audit_reference is None
            else _read_json(Path(audit_reference["path"]))
        ),
        unknown_fields=unknown_fields,
        terminal_stop_reason=terminal_stop_reason,
        failure=reported_failures.get(manifest["attemptId"]),
    )


def _load_rounds(rounds_path: Path) -> tuple[Round, ...]:
    rounds = []
    for line in rounds_path.read_text(encoding="utf8").splitlines():
        if not line:
            continue
        record = json.loads(line)
        usage = record["usage"]
        complete = usage["status"] == "complete"
        rounds.append(
            Round(
                index=record["round"],
                status=record["status"],
                finish_reason=record.get("finishReason"),
                tool_calls=tuple(record["toolCalls"]),
                duration_ms=record["durationMs"],
                input_tokens=usage["inputTokens"] if complete else None,
                output_tokens=usage["outputTokens"] if complete else None,
            )
        )
    return tuple(rounds)


def collect_tool_failures(tree: RunTree) -> dict[str, Counter]:
    """Failed tool calls per agent, keyed by tool name."""
    failures: dict[str, Counter] = {}
    for attempt in tree.attempts:
        if not attempt.is_final or attempt.status != "completed":
            continue
        counter = failures.setdefault(attempt.agent_id, Counter())
        for round_record in attempt.rounds:
            for tool in round_record.tool_calls:
                if tool["status"] == "failed":
                    counter[tool["name"].strip().lower()] += 1
    return failures


def _read_json(target: Path) -> dict:
    return json.loads(target.read_text(encoding="utf8"))
