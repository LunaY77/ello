"""Shared rendering configuration for benchmark analysis charts."""

from __future__ import annotations

from pathlib import Path

import matplotlib as mpl
from matplotlib.font_manager import FontProperties, fontManager
from matplotlib.lines import Line2D

DPI = 180
BACKGROUND = "#f4f1ea"
PANEL = "#fbfaf7"
INK = "#0a0a0a"
MUTED = "#4d4b47"
GRID = "#dedbd2"

PASS = "#14866d"
FAIL = "#d9544d"
INVALID = "#d99428"
MISSING = "#d9dee7"

AGENT_COLORS = {
    "ello": "#008f87",
    "claude-code": "#d56538",
}
FALLBACK_COLORS = ("#6b5fb5", "#3978a8", "#b27a2e", "#4f8b57")

AGENT_LABELS = {
    "ello": "Ello",
    "claude-code": "Claude Code",
}

# Keep a CJK-capable fallback for user-defined labels, although built-in chart
# copy stays in English so headless environments render consistently.
CJK_FONT_CANDIDATES = (
    Path("/usr/share/fonts/opentype/noto/NotoSansCJK-Regular.ttc"),
    Path("/usr/share/fonts/truetype/noto/NotoSansCJK-Regular.ttc"),
    Path("/usr/share/fonts/opentype/noto/NotoSerifCJK-Regular.ttc"),
    Path("/System/Library/Fonts/PingFang.ttc"),
)


def agent_color(agent_id: str, index: int) -> str:
    if agent_id in AGENT_COLORS:
        return AGENT_COLORS[agent_id]
    return FALLBACK_COLORS[index % len(FALLBACK_COLORS)]


def configure_style() -> None:
    family = "DejaVu Sans"
    for candidate in CJK_FONT_CANDIDATES:
        if candidate.exists():
            fontManager.addfont(str(candidate))
            family = FontProperties(fname=str(candidate)).get_name()
            break
    mpl.rcParams.update(
        {
            "font.family": family,
            "font.size": 11,
            "axes.facecolor": BACKGROUND,
            "figure.facecolor": BACKGROUND,
            "savefig.facecolor": BACKGROUND,
            "savefig.dpi": DPI,
            "figure.dpi": DPI,
            "text.color": INK,
            "axes.labelcolor": MUTED,
            "axes.edgecolor": GRID,
            "xtick.color": MUTED,
            "ytick.color": MUTED,
            "axes.linewidth": 0.6,
            "axes.titleweight": "bold",
            "axes.titlepad": 12,
            "axes.unicode_minus": False,
            "grid.color": GRID,
            "grid.linewidth": 0.6,
            "grid.alpha": 0.9,
            "legend.frameon": False,
            "savefig.bbox": "tight",
            "savefig.pad_inches": 0.08,
        }
    )


def agent_label(agent_id: str) -> str:
    return AGENT_LABELS.get(agent_id, agent_id)


def add_editorial_header(
    figure,
    kicker: str,
    title: str,
    subtitle: str,
    *,
    left: float = 0.08,
    right: float = 0.96,
    title_size: float = 25,
) -> None:
    """Add the report-like hierarchy used by the reference evidence charts."""
    figure.text(
        left,
        0.94,
        kicker.upper(),
        color=MUTED,
        fontsize=9.5,
        weight="bold",
    )
    figure.text(left, 0.865, title, color=INK, fontsize=title_size, weight="bold")
    figure.text(left, 0.805, subtitle, color=MUTED, fontsize=11)
    figure.add_artist(
        Line2D(
            [left, right],
            [0.765, 0.765],
            transform=figure.transFigure,
            color=GRID,
            linewidth=0.8,
        )
    )


def sample_note(tree) -> str:
    report = tree.report
    suite = report["suite"]
    return (
        f"SAMPLE · {report['scoredJobs']}/{report['plannedJobs']} planned jobs scored; "
        f"{report['invalidJobs']} final jobs infrastructure-invalid; "
        f"task set {suite['selectedTaskCount']}/{suite['upstreamTaskCount']}."
    )


def add_editorial_footer(
    figure,
    tree,
    method_note: str,
    provenance: str,
    *,
    left: float = 0.08,
) -> None:
    figure.text(left, 0.070, method_note, color=MUTED, fontsize=8.2)
    figure.text(left, 0.035, sample_note(tree), color=MUTED, fontsize=7.8)
    stamp(figure, provenance)


def style_axes(axes, *, x_grid: bool = False, y_grid: bool = True) -> None:
    axes.spines[["top", "right"]].set_visible(False)
    axes.spines[["left", "bottom"]].set_color(GRID)
    axes.tick_params(length=0, pad=7)
    axes.grid(axis="x", visible=x_grid, alpha=0.55)
    axes.grid(axis="y", visible=y_grid, alpha=0.85)
    axes.set_axisbelow(True)


def stamp(figure, provenance: str) -> None:
    """Every chart carries its run identity so a figure is always traceable."""
    figure.text(
        0.99,
        0.008,
        provenance,
        fontsize=4.6,
        color=MUTED,
        ha="right",
        alpha=0.75,
    )


def short_task_label(task_id: str) -> str:
    return task_id.removeprefix("swepro-")
