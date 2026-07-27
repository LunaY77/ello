"""Horizontal Pareto view of failed tool calls."""

from __future__ import annotations

from collections import Counter
from pathlib import Path

import matplotlib.pyplot as plt
from artifacts import collect_tool_failures
from config import (
    GRID,
    INK,
    MUTED,
    add_editorial_footer,
    add_editorial_header,
    agent_color,
    agent_label,
)


def render_tool_failure_pareto(tree, provenance: str, target: Path) -> None:
    failures = collect_tool_failures(tree)
    totals = Counter()
    for counter in failures.values():
        totals.update(counter)
    figure, axes = plt.subplots(
        figsize=(12.8, max(6.6, 4.9 + 0.43 * max(len(totals), 2)))
    )
    figure.subplots_adjust(left=0.20, right=0.92, bottom=0.18, top=0.70)
    add_editorial_header(
        figure,
        "Reliability · tool failure Pareto",
        "Which failed tools deserve attention first",
        "Ranked by failed calls in final scored attempts; stacked colors separate agents.",
    )
    if not totals:
        axes.text(
            0.5,
            0.5,
            "No failed tool call was recorded in final scored attempts.",
            transform=axes.transAxes,
            ha="center",
            va="center",
            fontsize=10,
            color=MUTED,
        )
        axes.set_axis_off()
    else:
        ranked = totals.most_common()
        names = [name for name, _ in ranked][::-1]
        counts = [count for _, count in ranked][::-1]
        agents = [agent for agent in sorted(failures) if failures[agent]]
        left = [0] * len(names)
        for index, agent_id in enumerate(agents):
            values = [failures[agent_id].get(name, 0) for name in names]
            axes.barh(
                names,
                values,
                left=left,
                height=0.58,
                color=agent_color(agent_id, index),
                label=agent_label(agent_id),
            )
            left = [base + value for base, value in zip(left, values)]
        grand_total = sum(counts)
        running = 0
        cumulative_by_name = {}
        for name, count in ranked:
            running += count
            cumulative_by_name[name] = running / grand_total
        padding = max(counts) * 0.025
        for row, (name, count) in enumerate(zip(names, counts)):
            axes.text(
                count + padding,
                row,
                f"{count} · {cumulative_by_name[name]:.0%} cumulative",
                va="center",
                color=INK,
                fontsize=8.5,
            )
        axes.set_xlim(0, max(counts) * 1.35)
        axes.set_xlabel("failed calls in final scored attempts")
        axes.xaxis.grid(True)
        axes.set_axisbelow(True)
        axes.tick_params(axis="y", length=0, labelsize=9)
        if len(agents) > 1:
            axes.legend(loc="lower right", fontsize=8)
    for spine in ("top", "right", "left"):
        axes.spines[spine].set_visible(False)
    axes.spines["bottom"].set_color(GRID)
    axes.tick_params(length=0, pad=7)
    add_editorial_footer(
        figure,
        tree,
        "READING · The first few rows are the smallest high-impact set; cumulative share measures coverage, not quality.",
        provenance,
    )
    figure.savefig(target)
    plt.close(figure)
