"""Outcome views by agent and task."""

from __future__ import annotations

from pathlib import Path

import matplotlib.pyplot as plt
import numpy as np
from config import (
    FAIL,
    GRID,
    INK,
    INVALID,
    MISSING,
    MUTED,
    PASS,
    add_editorial_footer,
    add_editorial_header,
    agent_color,
    agent_label,
    short_task_label,
)
from matplotlib.colors import BoundaryNorm, ListedColormap
from matplotlib.patches import Patch
from matplotlib.ticker import PercentFormatter
from wilson import MIN_INTERVAL_SAMPLES, interval_or_none


def render_pass_rate_by_agent(tree, provenance: str, target: Path) -> None:
    agents = tree.report["agents"]
    figure, axes = plt.subplots(figsize=(12.8, max(6.2, 4.7 + 0.7 * len(agents))))
    figure.subplots_adjust(left=0.18, right=0.94, bottom=0.18, top=0.69)
    add_editorial_header(
        figure,
        "Core outcome · valid pass rate",
        "Valid verifier pass rate by agent",
        "The denominator contains valid verifier rewards only; infrastructure-invalid jobs remain visible.",
    )
    positions = np.arange(len(agents))
    axes.barh(positions, [1] * len(agents), height=0.46, color="#e4e0d7")

    for index, agent in enumerate(agents):
        rate = agent["passRate"]
        valid = agent["validRuns"]
        invalid = agent["invalidRuns"]
        if rate is None:
            axes.barh(index, 1, height=0.46, color=MISSING)
            axes.text(
                0.03,
                index,
                f"No valid result · {invalid} invalid",
                va="center",
                color=INK,
                fontsize=10,
                weight="bold",
            )
            continue
        axes.barh(
            index,
            rate,
            height=0.46,
            color=agent_color(agent["agentId"], index),
        )
        label_inside = rate >= 0.30
        axes.text(
            rate - 0.018 if label_inside else rate + 0.018,
            index,
            f"{rate:.1%}",
            va="center",
            ha="right" if label_inside else "left",
            color="white" if label_inside else INK,
            fontsize=13,
            weight="bold",
            zorder=5,
        )
        axes.text(
            1.015,
            index,
            f"{agent['passedRuns']}/{valid} passed · {invalid} invalid",
            va="center",
            color=MUTED,
            fontsize=8.5,
        )
        interval = interval_or_none(agent["passedRuns"], valid)
        if interval is not None:
            axes.errorbar(
                rate,
                index,
                xerr=[[rate - interval.low], [interval.high - rate]],
                fmt="none",
                ecolor=INK,
                elinewidth=1,
                capsize=4,
                zorder=4,
            )

    axes.set_yticks(positions)
    axes.set_yticklabels(
        [agent_label(agent["agentId"]) for agent in agents],
        color=INK,
        weight="bold",
    )
    axes.invert_yaxis()
    axes.set_xlim(0, 1.18)
    axes.xaxis.set_major_formatter(PercentFormatter(1))
    axes.xaxis.grid(True, alpha=0.6)
    axes.set_axisbelow(True)
    axes.tick_params(length=0, pad=8)
    axes.spines[["top", "right", "left"]].set_visible(False)
    axes.spines["bottom"].set_color(GRID)
    add_editorial_footer(
        figure,
        tree,
        f"INTERVAL · 95% Wilson intervals appear at n≥{MIN_INTERVAL_SAMPLES}; smaller samples are shown without pseudo-precision.",
        provenance,
    )
    figure.savefig(target)
    plt.close(figure)


def render_pass_rate_by_task(tree, provenance: str, target: Path) -> None:
    agents = tree.report["agents"]
    task_ids = [task["taskId"] for task in agents[0]["tasks"]]
    if not task_ids:
        raise ValueError("Suite report contains no task results.")
    final_attempts = {
        (attempt.task_id, attempt.agent_id): attempt
        for attempt in tree.attempts
        if attempt.is_final
    }
    states = np.full((len(task_ids), len(agents)), 3, dtype=int)
    labels = np.full((len(task_ids), len(agents)), "—", dtype=object)
    for row, task_id in enumerate(task_ids):
        for column, agent in enumerate(agents):
            attempt = final_attempts.get((task_id, agent["agentId"]))
            if attempt is None:
                continue
            if attempt.status == "invalid_infrastructure":
                states[row, column] = 2
                labels[row, column] = "INVALID"
            elif attempt.reward == 1:
                states[row, column] = 1
                labels[row, column] = "PASS"
            elif attempt.reward == 0:
                states[row, column] = 0
                labels[row, column] = "FAIL"
            else:
                raise ValueError(
                    f"Completed final attempt has no verifier reward: {attempt.attempt_id}"
                )

    figure, axes = plt.subplots(
        figsize=(12.8, max(8.2, 4.6 + 0.39 * len(task_ids)))
    )
    figure.subplots_adjust(left=0.30, right=0.94, bottom=0.15, top=0.73)
    add_editorial_header(
        figure,
        "Task detail · outcome matrix",
        "Every final task outcome in one comparable matrix",
        "One cell is one final task × agent job; invalid infrastructure is not scored as failure.",
    )
    colormap = ListedColormap([FAIL, PASS, INVALID, MISSING])
    norm = BoundaryNorm([-0.5, 0.5, 1.5, 2.5, 3.5], colormap.N)
    axes.imshow(states, cmap=colormap, norm=norm, aspect="auto")
    axes.set_xticks(range(len(agents)))
    axes.set_xticklabels(
        [agent_label(agent["agentId"]) for agent in agents],
        color=INK,
        weight="bold",
    )
    axes.xaxis.tick_top()
    axes.set_yticks(range(len(task_ids)))
    axes.set_yticklabels(
        [short_task_label(task_id) for task_id in task_ids], fontsize=8.5, color=INK
    )
    for row in range(len(task_ids)):
        for column in range(len(agents)):
            axes.text(
                column,
                row,
                labels[row, column],
                ha="center",
                va="center",
                fontsize=8,
                color="white" if states[row, column] != 3 else MUTED,
                weight="bold",
            )
    axes.set_xticks(np.arange(-0.5, len(agents), 1), minor=True)
    axes.set_yticks(np.arange(-0.5, len(task_ids), 1), minor=True)
    axes.grid(which="minor", color=GRID, linewidth=2)
    axes.tick_params(which="minor", bottom=False, left=False)
    axes.tick_params(axis="x", length=0, pad=8)
    axes.tick_params(axis="y", length=0, pad=8)
    for spine in axes.spines.values():
        spine.set_visible(False)
    axes.legend(
        handles=[
            Patch(color=PASS, label="passed"),
            Patch(color=FAIL, label="failed"),
            Patch(color=INVALID, label="infrastructure-invalid"),
            Patch(color=MISSING, label="not planned"),
        ],
        ncol=4,
        loc="lower left",
        bbox_to_anchor=(0, -0.075),
        fontsize=8,
    )
    add_editorial_footer(
        figure,
        tree,
        "READING · Compare agents across a row; scan columns for shared failures, agent-specific failures, and infrastructure gaps.",
        provenance,
    )
    figure.savefig(target)
    plt.close(figure)
