"""Compact round matrix for final attempts."""

from __future__ import annotations

from collections import Counter
from pathlib import Path

import matplotlib.colors as colors
import matplotlib.pyplot as plt
import numpy as np
from config import (
    FAIL,
    GRID,
    INK,
    INVALID,
    MISSING,
    MUTED,
    add_editorial_footer,
    add_editorial_header,
    agent_color,
    agent_label,
    short_task_label,
)
from matplotlib.lines import Line2D
from matplotlib.patches import Patch, Rectangle


def render_round_timeline(tree, provenance: str, target: Path) -> None:
    task_order = {
        task["taskId"]: index
        for index, task in enumerate(tree.report["agents"][0]["tasks"])
    }
    agent_order = {
        agent["agentId"]: index for index, agent in enumerate(tree.report["agents"])
    }
    attempts = [
        attempt
        for attempt in tree.attempts
        if attempt.is_final
        and attempt.rounds
        and (attempt.failure is None or attempt.failure["kind"] != "provider")
    ]
    attempts.sort(
        key=lambda attempt: (
            agent_order[attempt.agent_id],
            task_order[attempt.task_id],
        )
    )
    if not attempts:
        raise ValueError("No final attempt recorded a non-provider model round.")

    max_rounds = max(len(attempt.rounds) for attempt in attempts)
    figure, axes = plt.subplots(
        figsize=(
            min(18.0, max(12.8, 0.22 * max_rounds + 4.5)),
            5.0 + 0.40 * len(attempts),
        )
    )
    figure.subplots_adjust(left=0.24, right=0.97, bottom=0.16, top=0.73)
    add_editorial_header(
        figure,
        "Process comparison · round timeline",
        "Where time accumulates and failed tool calls cluster",
        "Each row is a final attempt; darker cells took longer and larger dots contain more tool calls.",
        left=0.06,
        right=0.97,
    )
    durations = np.array(
        [
            round_record.duration_ms
            for attempt in attempts
            for round_record in attempt.rounds
            if round_record.duration_ms is not None
        ],
        dtype=float,
    )
    duration_low = float(np.percentile(durations, 10)) if durations.size else 0
    duration_high = float(np.percentile(durations, 95)) if durations.size else 1
    if duration_high <= duration_low:
        duration_high = duration_low + 1

    labels = []
    group_boundaries = []
    previous_agent = None
    for row, attempt in enumerate(attempts):
        if previous_agent is not None and previous_agent != attempt.agent_id:
            group_boundaries.append(row - 0.5)
        previous_agent = attempt.agent_id
        outcome = (
            "pass"
            if attempt.reward == 1
            else "fail"
            if attempt.reward == 0
            else "invalid"
        )
        labels.append(
            f"{agent_label(attempt.agent_id)} · {short_task_label(attempt.task_id)} [{outcome}]"
        )
        base_color = agent_color(attempt.agent_id, agent_order[attempt.agent_id])
        for column, round_record in enumerate(attempt.rounds):
            failed_tools = sum(
                tool["status"] == "failed" for tool in round_record.tool_calls
            )
            if round_record.status != "completed":
                face = INVALID
            elif round_record.duration_ms is None:
                face = MISSING
            else:
                normalized = np.clip(
                    (round_record.duration_ms - duration_low)
                    / (duration_high - duration_low),
                    0,
                    1,
                )
                face = colors.to_hex(
                    _blend("#ffffff", base_color, 0.42 + 0.53 * np.sqrt(normalized))
                )
            axes.add_patch(
                Rectangle(
                    (column - 0.45, row - 0.36),
                    0.9,
                    0.72,
                    facecolor=face,
                    edgecolor=FAIL if failed_tools else "white",
                    linewidth=1.5 if failed_tools else 0.7,
                )
            )
            tool_count = len(round_record.tool_calls)
            if tool_count:
                axes.scatter(
                    column,
                    row,
                    s=7 + min(tool_count, 5) * 5,
                    facecolor=INK,
                    edgecolor="white",
                    linewidth=0.4,
                    zorder=4,
                )
            if failed_tools:
                axes.text(
                    column,
                    row,
                    "×",
                    ha="center",
                    va="center",
                    color="white",
                    fontsize=7,
                    weight="bold",
                    zorder=5,
                )

    for boundary in group_boundaries:
        axes.axhline(boundary, color=INK, linewidth=1.1, alpha=0.45)
    axes.set_xlim(-0.6, max_rounds - 0.4)
    axes.set_ylim(-0.7, len(attempts) - 0.3)
    axes.invert_yaxis()
    axes.set_yticks(range(len(labels)))
    axes.set_yticklabels(labels, fontsize=8.2, color=INK)
    tick_step = 1 if max_rounds <= 24 else 2
    axes.set_xticks(range(0, max_rounds, tick_step))
    axes.set_xticklabels(range(1, max_rounds + 1, tick_step), fontsize=8)
    axes.xaxis.tick_top()
    axes.set_xticks(np.arange(-0.5, max_rounds, 1), minor=True)
    axes.grid(which="minor", axis="x", color=GRID, linewidth=0.55)
    axes.tick_params(axis="both", length=0)
    axes.tick_params(axis="x", pad=8)
    axes.tick_params(axis="y", pad=8)
    provider_invalid = Counter(
        attempt.agent_id
        for attempt in tree.attempts
        if attempt.is_final
        and attempt.failure is not None
        and attempt.failure["kind"] == "provider"
    )
    if provider_invalid:
        axes.text(
            0,
            -0.075,
            "Provider-invalid jobs omitted: "
            + ", ".join(
                f"{agent_id} {count}" for agent_id, count in provider_invalid.items()
            ),
            transform=axes.transAxes,
            color=MUTED,
            fontsize=8.5,
        )
    axes.legend(
        handles=[
            Patch(facecolor=agent_color("ello", 0), label="completed round"),
            Patch(facecolor=INVALID, label="incomplete / failed round"),
            Patch(facecolor=MISSING, label="duration unreported"),
            Line2D(
                [], [], marker="o", linestyle="none", color=INK, label="tool call count"
            ),
            Line2D(
                [], [], marker="x", linestyle="none", color=FAIL, label="failed tool"
            ),
        ],
        ncol=5,
        loc="lower left",
        bbox_to_anchor=(0, -0.14),
        fontsize=8,
    )
    for spine in axes.spines.values():
        spine.set_visible(False)
    add_editorial_footer(
        figure,
        tree,
        "SCALE · Color uses the P10–P95 range of observed round duration; provider-invalid jobs without model rounds are omitted.",
        provenance,
        left=0.06,
    )
    figure.savefig(target)
    plt.close(figure)


def _blend(background: str, foreground: str, ratio: float):
    background_rgb = np.array(colors.to_rgb(background))
    foreground_rgb = np.array(colors.to_rgb(foreground))
    return background_rgb * (1 - ratio) + foreground_rgb * ratio
