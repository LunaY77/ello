"""Resource and token summaries designed for direct agent comparison."""

from __future__ import annotations

from pathlib import Path

import matplotlib.pyplot as plt
import numpy as np
from config import (
    GRID,
    INK,
    MISSING,
    MUTED,
    PANEL,
    add_editorial_footer,
    add_editorial_header,
    agent_color,
    agent_label,
)
from matplotlib.patches import FancyBboxPatch, Patch
from matplotlib.ticker import PercentFormatter


def render_resource_tradeoff(tree, provenance: str, target: Path) -> None:
    agents = tree.report["agents"]
    measured = [
        agent
        for agent in agents
        if agent["passRate"] is not None
        and agent["resources"]["elapsedMs"]["median"] is not None
    ]
    figure, axes = plt.subplots(figsize=(12.8, 7.2))
    figure.subplots_adjust(left=0.12, right=0.92, bottom=0.18, top=0.70)
    add_editorial_header(
        figure,
        "Resource comparison · time and outcome",
        "Faster or more accurate: outcome and runtime on one canvas",
        "X is median agent runtime, Y is valid pass rate, and bubble area represents median tool calls.",
    )
    if len(measured) >= 2:
        _render_tradeoff_scatter(axes, agents, measured)
        method = "READING · Left is faster, up is a higher pass rate, and a larger bubble means more tool calls."
    else:
        _render_resource_cards(axes, agents, measured)
        method = "LIMIT · At least two agents with valid resource evidence are required for a cross-agent trade-off."
    add_editorial_footer(figure, tree, method, provenance)
    figure.savefig(target)
    plt.close(figure)


def _render_tradeoff_scatter(axes, agents, measured) -> None:
    elapsed_values = [
        agent["resources"]["elapsedMs"]["median"] / 1000 for agent in measured
    ]
    rate_values = [agent["passRate"] for agent in measured]
    axes.axvline(np.median(elapsed_values), color=GRID, linewidth=1, linestyle="--")
    axes.axhline(np.median(rate_values), color=GRID, linewidth=1, linestyle="--")
    for index, agent in enumerate(agents):
        rate = agent["passRate"]
        elapsed = agent["resources"]["elapsedMs"]["median"]
        tools = agent["resources"]["toolCalls"]["median"]
        rounds = agent["resources"]["rounds"]["median"]
        if rate is None or elapsed is None or tools is None:
            continue
        axes.scatter(
            elapsed / 1000,
            rate,
            s=max(180, tools * 18),
            color=agent_color(agent["agentId"], index),
            edgecolor="white",
            linewidth=1.8,
            alpha=0.92,
            zorder=3,
        )
        axes.annotate(
            f"{agent_label(agent['agentId'])}\n{elapsed / 1000:,.0f}s · {rounds:,.1f} rounds · {tools:,.1f} tools",
            (elapsed / 1000, rate),
            textcoords="offset points",
            xytext=(10, 10),
            color=INK,
            fontsize=9,
            weight="bold",
        )
    axes.text(0.01, 0.98, "← faster", transform=axes.transAxes, color=MUTED, va="top")
    axes.text(0.99, 0.98, "slower →", transform=axes.transAxes, color=MUTED, ha="right", va="top")
    axes.set_xlabel("median agent runtime (seconds)")
    axes.set_ylabel("valid verifier pass rate")
    axes.set_ylim(-0.03, 1.07)
    axes.yaxis.set_major_formatter(PercentFormatter(1))
    axes.grid(True, alpha=0.55)
    axes.set_axisbelow(True)
    axes.tick_params(length=0, pad=8)
    axes.spines[["top", "right"]].set_visible(False)
    axes.spines[["left", "bottom"]].set_color(GRID)


def _render_resource_cards(axes, agents, measured) -> None:
    axes.set_axis_off()
    if not measured:
        axes.text(
            0.5,
            0.5,
            "No agent produced valid resource evidence.",
            transform=axes.transAxes,
            ha="center",
            va="center",
            color=MUTED,
        )
        return
    agent = measured[0]
    resources = agent["resources"]
    cards = (
        ("Pass rate", f"{agent['passRate']:.1%}", f"{agent['passedRuns']}/{agent['validRuns']} passed"),
        ("Runtime", _duration(resources["elapsedMs"]["median"]), "median valid run"),
        ("Rounds", _integer(resources["rounds"]["median"]), "median valid run"),
        ("Tool calls", _integer(resources["toolCalls"]["median"]), "median valid run"),
        ("Output tokens", _integer(resources["outputTokens"]["median"]), "median valid run"),
    )
    axes.text(
        0.02,
        0.86,
        agent_label(agent["agentId"]),
        transform=axes.transAxes,
        color=agent_color(agent["agentId"], 0),
        fontsize=15,
        weight="bold",
    )
    for index, (label, value, detail) in enumerate(cards):
        left = 0.02 + index * 0.195
        axes.add_patch(
            FancyBboxPatch(
                (left, 0.34),
                0.18,
                0.34,
                boxstyle="round,pad=0.012,rounding_size=0.015",
                transform=axes.transAxes,
                facecolor=PANEL,
                edgecolor=GRID,
                linewidth=1,
            )
        )
        axes.text(left + 0.015, 0.61, label, transform=axes.transAxes, color=MUTED, fontsize=8)
        axes.text(left + 0.015, 0.48, value, transform=axes.transAxes, color=INK, fontsize=15, weight="bold")
        axes.text(left + 0.015, 0.39, detail, transform=axes.transAxes, color=MUTED, fontsize=7)
    unavailable = [agent for agent in agents if agent not in measured]
    if unavailable:
        axes.text(
            0.02,
            0.18,
            " · ".join(
                f"{agent_label(agent['agentId'])}: no valid resource sample"
                for agent in unavailable
            ),
            transform=axes.transAxes,
            color=MUTED,
            fontsize=8.5,
            bbox={"boxstyle": "round,pad=0.55", "facecolor": MISSING, "edgecolor": "none"},
        )


def render_token_breakdown(tree, provenance: str, target: Path) -> None:
    agents = tree.report["agents"]
    figure, axes = plt.subplots(figsize=(12.8, max(6.8, 4.9 + 0.8 * len(agents))))
    figure.subplots_adjust(left=0.18, right=0.93, bottom=0.18, top=0.69)
    add_editorial_header(
        figure,
        "Resource comparison · token composition",
        "Median token profile: new input, cache reads, and model output",
        "Bars are normalized by observable token volume; absolute median values remain printed at right.",
    )
    components = (
        ("Uncached input", "#d56538"),
        ("Cache read", "#008f87"),
        ("Model output", "#6b5fb5"),
        ("Cache write", "#3978a8"),
    )
    positions = np.arange(len(agents))
    for row, agent in enumerate(agents):
        resources = agent["resources"]
        input_tokens = resources["inputTokens"]["median"]
        cache_read = resources["cacheReadTokens"]["median"]
        output = resources["outputTokens"]["median"]
        cache_write = resources["cacheWriteTokens"]["median"]
        if input_tokens is None or cache_read is None or output is None:
            axes.barh(row, 1, height=0.42, color=MISSING)
            axes.text(0.02, row, "Incomplete token evidence", va="center", color=MUTED)
            continue
        cache_write_value = 0 if cache_write is None else cache_write
        cached_tokens = cache_read + cache_write_value
        if cached_tokens > input_tokens:
            raise ValueError(f"Cache components exceed input tokens for {agent['agentId']}.")
        values = np.array(
            [input_tokens - cached_tokens, cache_read, output, cache_write_value],
            dtype=float,
        )
        total = float(np.sum(values))
        shares = values / total if total else np.zeros_like(values)
        cursor = 0.0
        for (label, color), share in zip(components, shares):
            if share <= 0:
                continue
            axes.barh(row, share, left=cursor, height=0.42, color=color)
            if share >= 0.08:
                axes.text(
                    cursor + share / 2,
                    row,
                    f"{share:.1%}",
                    ha="center",
                    va="center",
                    color="white" if label != "Cache read" else INK,
                    fontsize=8.5,
                    weight="bold",
                )
            cursor += share
        missing_note = " · cache write unreported" if cache_write is None else ""
        axes.text(
            1.015,
            row,
            f"input {input_tokens:,.0f} · output {output:,.0f}{missing_note}",
            va="center",
            color=MUTED,
            fontsize=8.2,
        )

    axes.set_yticks(
        positions,
        labels=[agent_label(agent["agentId"]) for agent in agents],
    )
    for label in axes.get_yticklabels():
        label.set_weight("bold")
        label.set_color(INK)
    axes.invert_yaxis()
    axes.set_xlim(0, 1.22)
    axes.set_xticks(np.linspace(0, 1, 5))
    axes.set_xlabel("share of observable token volume")
    axes.xaxis.set_major_formatter(PercentFormatter(1))
    axes.xaxis.grid(True, alpha=0.55)
    axes.set_axisbelow(True)
    axes.tick_params(length=0, pad=8)
    axes.spines[["top", "right", "left"]].set_visible(False)
    axes.spines["bottom"].set_color(GRID)
    axes.legend(
        handles=[Patch(color=color, label=label) for label, color in components],
        ncol=4,
        loc="lower left",
        bbox_to_anchor=(0, 1.015),
        borderaxespad=0,
        fontsize=8.5,
        frameon=False,
    )
    add_editorial_footer(
        figure,
        tree,
        "ACCOUNTING · Input tokens are not added to cache reads again; missing fields remain explicit rather than becoming zero.",
        provenance,
    )
    figure.savefig(target)
    plt.close(figure)


def _duration(value) -> str:
    return "n/a" if value is None else f"{value / 1000:,.0f} s"


def _integer(value) -> str:
    return "n/a" if value is None else f"{round(value):,}"
