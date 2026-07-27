"""Smoke tests for direct paired-outcome comparison charts."""

from __future__ import annotations

import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace

import matplotlib

matplotlib.use("Agg")

from charts.comparisons import render_paired_outcomes


def comparison_tree(comparisons):
    return SimpleNamespace(
        report={
            "suite": {"selectedTaskCount": 30, "upstreamTaskCount": 731},
            "plannedJobs": 60,
            "scoredJobs": 58,
            "invalidJobs": 2,
            "comparisons": comparisons,
        }
    )


class ComparisonChartsTest(unittest.TestCase):
    def test_paired_outcomes_renders_wins_ties_losses_and_exclusions(self):
        tree = comparison_tree(
            [
                {
                    "leftAgentId": "ello",
                    "rightAgentId": "claude-code",
                    "matchedRuns": 28,
                    "excludedPairs": 2,
                    "wins": 6,
                    "ties": 18,
                    "losses": 4,
                }
            ]
        )
        with tempfile.TemporaryDirectory() as directory:
            target = Path(directory) / "paired-outcomes.png"
            render_paired_outcomes(tree, "provenance", target)
            self.assertTrue(target.is_file())
            self.assertGreater(target.stat().st_size, 0)

    def test_empty_comparison_set_still_renders(self):
        with tempfile.TemporaryDirectory() as directory:
            target = Path(directory) / "paired-outcomes.png"
            render_paired_outcomes(comparison_tree([]), "provenance", target)
            self.assertTrue(target.is_file())


if __name__ == "__main__":
    unittest.main(verbosity=2)
