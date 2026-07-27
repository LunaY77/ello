"""Covers the Markdown report against a synthetic run tree.

Runs without the chart toolchain so report content stays verifiable on a machine
that has no matplotlib.
"""

from __future__ import annotations

import json
import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))

from artifacts import Attempt, Round, RunTree, collect_tool_failures
from markdown_report import build_markdown

ROUNDS = (
    Round(
        index=1,
        status="completed",
        finish_reason="tool_call",
        tool_calls=(
            {"name": "grep", "status": "failed", "category": "search"},
            {"name": "grep", "status": "failed", "category": "search"},
            {"name": "read", "status": "completed", "category": "read"},
        ),
        duration_ms=1200.0,
        input_tokens=100,
        output_tokens=20,
    ),
    Round(
        index=2,
        status="completed",
        finish_reason="stop",
        tool_calls=({"name": "shell", "status": "failed", "category": "shell"},),
        duration_ms=None,
        input_tokens=None,
        output_tokens=None,
    ),
)


def build_tree(pass_rate, valid_runs, passed_runs, unknown_fields=()):
    report = {
        "suite": {
            "id": "deep-swe-v1.1",
            "benchmarkId": "ello.benchmark.deepswe.v1.1",
            "displayName": "DeepSWE v1.1 curated",
            "selectedTaskCount": 20,
            "upstreamTaskCount": 113,
            "selectionKind": "curated",
        },
        "configHash": "a" * 64,
        "planHash": "b" * 64,
        "generatedAt": "2026-07-26T00:00:00.000Z",
        "plannedJobs": 2,
        "scoredJobs": valid_runs,
        "invalidJobs": 0,
        "publishable": False,
        "agents": [
            {
                "agentId": "ello",
                "validRuns": valid_runs,
                "passedRuns": passed_runs,
                "passRate": pass_rate,
                "invalidRuns": 0,
                "taskMacroAverage": pass_rate,
                "tasks": [
                    {
                        "taskId": "happy-dom-abort",
                        "agentId": "ello",
                        "validRuns": valid_runs,
                        "passedRuns": passed_runs,
                        "passRate": pass_rate,
                    }
                ],
                "resources": {
                    "outputTokens": {"count": 1, "median": 28000, "p95": 28000},
                    "inputTokens": {"count": 1, "median": 120000, "p95": 120000},
                    "cacheReadTokens": {"count": 0, "median": None, "p95": None},
                    "cacheWriteTokens": {"count": 0, "median": None, "p95": None},
                },
            }
        ],
        "comparisons": [
            {
                "leftAgentId": "ello",
                "rightAgentId": "claude-code",
                "matchedRuns": 0,
                "excludedPairs": 1,
                "wins": 0,
                "ties": 0,
                "losses": 0,
                "pairedPassRateDelta": None,
            }
        ],
        "invalidLedger": [],
    }
    attempt = Attempt(
        attempt_id="a" * 24,
        attempt_number=1,
        task_id="happy-dom-abort",
        agent_id="ello",
        is_final=True,
        status="completed",
        outcome="failed",
        reward=0,
        rounds=ROUNDS,
        tool_audit={"status": "passed"},
        unknown_fields=tuple(unknown_fields),
        terminal_stop_reason="stop",
    )
    return RunTree(
        run_root=Path("/tmp/run"),
        config_hash="a" * 64,
        generated_at="2026-07-26T00:00:00.000Z",
        report=report,
        attempts=(attempt,),
    )


class MarkdownReportTest(unittest.TestCase):
    def test_small_sample_reports_n_instead_of_an_interval(self):
        markdown = build_markdown(build_tree(0.5, 2, 1), "prov")
        self.assertIn("n<3 (n=2)", markdown)

    def test_sufficient_sample_reports_a_wilson_interval(self):
        markdown = build_markdown(build_tree(0.5, 4, 2), "prov")
        self.assertNotIn("n<3", markdown)
        self.assertRegex(markdown, r"\d+\.\d% – \d+\.\d%")

    def test_absent_metric_renders_as_a_dash_not_zero(self):
        markdown = build_markdown(build_tree(None, 0, 0), "prov")
        self.assertIn("| -- |", markdown)
        self.assertNotIn("| 0.0% |", markdown)

    def test_unmatched_comparison_is_called_out(self):
        markdown = build_markdown(build_tree(0.5, 4, 2), "prov")
        self.assertIn("comparison unavailable", markdown)

    def test_tool_failures_are_ranked(self):
        markdown = build_markdown(build_tree(0.5, 4, 2), "prov")
        self.assertIn("| ello | grep | 2 |", markdown)
        self.assertIn("| ello | shell | 1 |", markdown)
        self.assertLess(markdown.index("| grep |"), markdown.index("| shell |"))

    def test_failure_counter_matches_rounds(self):
        failures = collect_tool_failures(build_tree(0.5, 4, 2))
        self.assertEqual(dict(failures["ello"]), {"grep": 2, "shell": 1})

    def test_drift_section_reports_unknown_fields(self):
        markdown = build_markdown(
            build_tree(0.5, 4, 2, unknown_fields=("Claude usage.speed",)), "prov"
        )
        self.assertIn("Claude usage.speed", markdown)

    def test_drift_section_states_absence_explicitly(self):
        markdown = build_markdown(build_tree(0.5, 4, 2), "prov")
        self.assertIn("No unknown Agent field was observed.", markdown)

    def test_provenance_is_stamped(self):
        markdown = build_markdown(build_tree(0.5, 4, 2), "prov-stamp")
        self.assertIn("prov-stamp", markdown)

    def test_provider_failures_are_grouped_without_claiming_zero_pass_rate(self):
        tree = build_tree(0.5, 4, 2)
        tree.report["plannedJobs"] = 2
        tree.report["invalidJobs"] = 1
        tree.report["agents"].append(
            {
                "agentId": "claude-code",
                "validRuns": 0,
                "passedRuns": 0,
                "passRate": None,
                "invalidRuns": 1,
                "taskMacroAverage": None,
                "tasks": [],
                "resources": {"elapsedMs": {"count": 0, "median": None}},
            }
        )
        invalid = Attempt(
            attempt_id="b" * 24,
            attempt_number=2,
            task_id="happy-dom-abort",
            agent_id="claude-code",
            is_final=True,
            status="invalid_infrastructure",
            outcome=None,
            reward=None,
            failure={
                "kind": "provider",
                "phase": "agent-model-call",
                "message": "Claude Code provider error model_not_found: unavailable",
            },
        )
        tree = RunTree(
            run_root=tree.run_root,
            config_hash=tree.config_hash,
            generated_at=tree.generated_at,
            report=tree.report,
            attempts=tree.attempts + (invalid,),
        )

        markdown = build_markdown(tree, "prov")

        self.assertIn("claude-code has no valid sample", markdown)
        self.assertIn("model_not_found", markdown)
        self.assertIn("| claude-code | provider / agent-model-call | 1 | 1 |", markdown)
        self.assertNotIn("| claude-code | 0 | 0 | 0.0%", markdown)

    def test_report_is_valid_json_free_markdown(self):
        markdown = build_markdown(build_tree(0.5, 4, 2), "prov")
        self.assertTrue(markdown.startswith("# Benchmark report"))
        self.assertIn("`ello.benchmark.deepswe.v1.1`", markdown)


if __name__ == "__main__":
    unittest.main(verbosity=2)
