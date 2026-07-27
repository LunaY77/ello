#!/usr/bin/env python3
"""Renders a human-readable report and charts from a completed run tree.

Runs strictly after an experiment, never inside it: a defect here can only
require re-rendering, it cannot change a recorded result.
"""

from __future__ import annotations

import argparse
import sys
from datetime import datetime, timezone
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))

from artifacts import load_run_tree  # noqa: E402
from charts.comparisons import render_paired_outcomes  # noqa: E402
from charts.pass_rate import (  # noqa: E402
    render_pass_rate_by_agent,
    render_pass_rate_by_task,
)
from charts.resources import (  # noqa: E402
    render_resource_tradeoff,
    render_token_breakdown,
)
from charts.timeline import render_round_timeline  # noqa: E402
from charts.tool_failures import render_tool_failure_pareto  # noqa: E402
from config import configure_style  # noqa: E402
from markdown_report import CHART_FILENAMES, build_markdown  # noqa: E402

RENDERERS = (
    render_pass_rate_by_agent,
    render_paired_outcomes,
    render_pass_rate_by_task,
    render_resource_tradeoff,
    render_round_timeline,
    render_token_breakdown,
    render_tool_failure_pareto,
)
CHARTS = tuple(zip(CHART_FILENAMES, RENDERERS, strict=True))


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--run-root", required=True, type=Path)
    arguments = parser.parse_args()
    run_root = arguments.run_root.resolve()

    tree = load_run_tree(run_root)
    provenance = (
        f"runRoot={tree.run_root}  configHash={tree.config_hash[:12]}  "
        f"reportGeneratedAt={tree.generated_at}  "
        f"renderedAt={datetime.now(timezone.utc).isoformat(timespec='seconds')}"
    )
    configure_style()
    charts_root = run_root / "results" / "charts"
    charts_root.mkdir(parents=True, exist_ok=True)
    for filename, render in CHARTS:
        render(tree, provenance, charts_root / filename)
    report_path = run_root / "results" / "report.md"
    report_path.write_text(build_markdown(tree, provenance), encoding="utf8")
    print(f"{report_path}")
    for filename, _ in CHARTS:
        print(f"{charts_root / filename}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
