"""Covers resource charts that accept partial Agent usage evidence."""

from __future__ import annotations

import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace

import matplotlib

matplotlib.use("Agg")

from charts.resources import render_token_breakdown


def tree_with_tokens(*, input_tokens, cache_read, output, cache_write):
    return SimpleNamespace(
        report={
            "suite": {"selectedTaskCount": 1, "upstreamTaskCount": 731},
            "plannedJobs": 1,
            "scoredJobs": 1,
            "invalidJobs": 0,
            "agents": [
                {
                    "agentId": "claude-code",
                    "invalidRuns": 0,
                    "resources": {
                        "inputTokens": {"median": input_tokens},
                        "cacheReadTokens": {"median": cache_read},
                        "outputTokens": {"median": output},
                        "cacheWriteTokens": {"median": cache_write},
                    },
                }
            ]
        }
    )


class ResourceChartsTest(unittest.TestCase):
    def test_partial_cache_evidence_renders_as_unavailable(self):
        tree = tree_with_tokens(
            input_tokens=25630,
            cache_read=None,
            output=0,
            cache_write=None,
        )
        with tempfile.TemporaryDirectory() as directory:
            target = Path(directory) / "token-breakdown.png"
            render_token_breakdown(tree, "provenance", target)
            self.assertTrue(target.is_file())
            self.assertGreater(target.stat().st_size, 0)

    def test_cache_reads_cannot_exceed_total_input(self):
        tree = tree_with_tokens(
            input_tokens=10,
            cache_read=11,
            output=1,
            cache_write=0,
        )
        with tempfile.TemporaryDirectory() as directory:
            with self.assertRaisesRegex(ValueError, "Cache components exceed"):
                render_token_breakdown(
                    tree,
                    "provenance",
                    Path(directory) / "token-breakdown.png",
                )


if __name__ == "__main__":
    unittest.main(verbosity=2)
