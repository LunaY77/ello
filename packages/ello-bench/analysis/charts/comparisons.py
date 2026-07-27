"""Direct paired outcome view for agent-to-agent comparisons."""

from __future__ import annotations

from pathlib import Path

import matplotlib.pyplot as plt
import numpy as np
from config import (
    GRID,
    INK,
    MISSING,
    MUTED,
    add_editorial_footer,
    add_editorial_header,
    agent_color,
    agent_label,
)


def render_paired_outcomes(tree, provenance: str, target: Path) -> None:
    comparisons = tree.report["comparisons"]
    figure, axes = plt.subplots(
        figsize=(12.8, max(6.3, 4.8 + 0.9 * max(len(comparisons), 1)))
    )
    figure.subplots_adjust(left=0.20, right=0.94, bottom=0.17, top=0.70)
    add_editorial_header(
        figure,
        "Core comparison · paired outcomes",
        "Paired verifier outcomes on the same task",
        "Only pairs with valid rewards on both sides are compared; infrastructure-invalid pairs are excluded.",
        title_size=23,
    )

    if not comparisons:
        axes.text(
            0.5,
            0.5,
            "No agent pair was available for comparison.",
            transform=axes.transAxes,
            ha="center",
            va="center",
            color=MUTED,
        )
        axes.set_axis_off()
    else:
        positions = np.arange(len(comparisons))
        for row, comparison in enumerate(comparisons):
            matched = comparison["matchedRuns"]
            left_id = comparison["leftAgentId"]
            right_id = comparison["rightAgentId"]
            if matched == 0:
                axes.barh(row, 1, height=0.42, color=MISSING)
                axes.text(0.02, row, "No valid pair", va="center", color=MUTED)
                continue
            segments = (
                (comparison["wins"] / matched, agent_color(left_id, 0), "win"),
                (comparison["ties"] / matched, GRID, "tie"),
                (comparison["losses"] / matched, agent_color(right_id, 1), "loss"),
            )
            counts = (
                comparison["wins"],
                comparison["ties"],
                comparison["losses"],
            )
            cursor = 0.0
            for (share, color, label), count in zip(segments, counts):
                if share <= 0:
                    continue
                axes.barh(row, share, left=cursor, height=0.42, color=color)
                if share >= 0.10:
                    axes.text(
                        cursor + share / 2,
                        row,
                        f"{label} {count}",
                        ha="center",
                        va="center",
                        color=INK if label == "tie" else "white",
                        fontsize=9,
                        weight="bold",
                    )
                cursor += share
            axes.text(
                1.015,
                row,
                f"matched {matched} · excluded {comparison['excludedPairs']}",
                va="center",
                color=MUTED,
                fontsize=8.5,
            )

        axes.set_yticks(
            positions,
            labels=[
                f"{agent_label(item['leftAgentId'])} vs {agent_label(item['rightAgentId'])}"
                for item in comparisons
            ],
        )
        axes.invert_yaxis()
        axes.set_xlim(0, 1.18)
        axes.set_xticks(
            np.linspace(0, 1, 5),
            labels=["0%", "25%", "50%", "75%", "100%"],
        )
        axes.xaxis.grid(True, alpha=0.55)
        axes.set_axisbelow(True)
        axes.tick_params(length=0, pad=7)
        axes.spines[["top", "right", "left"]].set_visible(False)
        axes.spines["bottom"].set_color(GRID)

    add_editorial_footer(
        figure,
        tree,
        "ESTIMAND · Win, tie, and loss use same-task, same-replicate verifier rewards; invalid infrastructure never becomes an opponent win.",
        provenance,
    )
    figure.savefig(target)
    plt.close(figure)
