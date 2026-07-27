"""Binomial proportion intervals with an explicit minimum-sample policy.

Named `wilson` rather than `statistics` so it cannot shadow the standard
library module for anything else running in this interpreter.

A benchmark run routinely has very few valid replicates. Reporting an interval
or a trend from one or two samples invents precision the experiment does not
have, so the callers use MIN_INTERVAL_SAMPLES to decide whether an interval may
be drawn at all.
"""

from __future__ import annotations

from dataclasses import dataclass
from statistics import NormalDist

# Below this many valid runs a chart shows the point estimate and the sample
# count, and no error bar.
MIN_INTERVAL_SAMPLES = 3


@dataclass(frozen=True)
class Interval:
    low: float
    high: float


def wilson_interval(passed: int, total: int, confidence: float = 0.95) -> Interval:
    """Wilson score interval for a binomial proportion.

    Preferred over the normal approximation because pass rates here sit near 0
    or 1, where the normal interval leaves the [0, 1] range.
    """
    if total <= 0:
        raise ValueError("Wilson interval requires at least one observation.")
    if not 0 <= passed <= total:
        raise ValueError(f"Invalid pass count: {passed} of {total}.")
    z = NormalDist().inv_cdf(1 - (1 - confidence) / 2)
    proportion = passed / total
    denominator = 1 + z**2 / total
    center = (proportion + z**2 / (2 * total)) / denominator
    margin = (
        z
        / denominator
        * ((proportion * (1 - proportion) / total + z**2 / (4 * total**2)) ** 0.5)
    )
    return Interval(max(0.0, center - margin), min(1.0, center + margin))


def interval_or_none(passed: int, total: int) -> Interval | None:
    """None when the sample is too small for an interval to mean anything."""
    if total < MIN_INTERVAL_SAMPLES:
        return None
    return wilson_interval(passed, total)
