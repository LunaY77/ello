"""Builds the human-readable Markdown report.

Kept free of any plotting dependency so the written report can be produced and
tested without the chart toolchain installed.
"""

from __future__ import annotations

from collections import defaultdict

from artifacts import collect_tool_failures
from wilson import MIN_INTERVAL_SAMPLES, interval_or_none

CHART_FILENAMES = (
    "pass-rate-by-agent.png",
    "paired-outcomes.png",
    "pass-rate-by-task.png",
    "resource-tradeoff.png",
    "round-timeline.png",
    "token-breakdown.png",
    "tool-failure-pareto.png",
)


def build_markdown(tree, provenance: str) -> str:
    report = tree.report
    suite = report["suite"]
    lines = [
        "# Benchmark report",
        "",
        f"- benchmark: `{suite['benchmarkId']}` ({suite['displayName']})",
        f"- task selection: {suite['selectedTaskCount']} selected / "
        f"{suite['upstreamTaskCount']} upstream ({suite['selectionKind']})",
        f"- runRoot: `{tree.run_root}`",
        f"- configHash: `{report['configHash']}`",
        f"- planHash: `{report['planHash']}`",
        f"- reportGeneratedAt: `{report['generatedAt']}`",
        f"- plannedJobs: {report['plannedJobs']}, "
        f"scoredJobs: {report['scoredJobs']}, "
        f"invalidJobs: {report['invalidJobs']}",
        f"- publishable: **{str(report['publishable']).lower()}**",
    ]
    lines += _health_section(tree)
    lines += ["", "## Agents", ""]
    lines += [
        "| agent | valid | passed | pass rate | 95% CI | invalid | task macro |",
        "| --- | ---: | ---: | ---: | --- | ---: | ---: |",
    ]
    for agent in report["agents"]:
        interval = (
            None
            if agent["passRate"] is None
            else interval_or_none(agent["passedRuns"], agent["validRuns"])
        )
        lines.append(
            f"| {agent['agentId']} | {agent['validRuns']} | {agent['passedRuns']} "
            f"| {_percent(agent['passRate'])} "
            f"| {'--' if agent['passRate'] is None else _interval_text(interval, agent['validRuns'])} "
            f"| {agent['invalidRuns']} | {_percent(agent['taskMacroAverage'])} |"
        )
    lines += _resource_section(report)
    lines += _comparison_section(report)
    lines += _tool_failure_section(tree)
    lines += _drift_section(tree)
    lines += _invalid_section(tree)
    lines += [
        "",
        "## Charts",
        "",
    ]
    descriptions = {
        "pass-rate-by-agent.png": "valid pass rate and invalid coverage by agent",
        "paired-outcomes.png": "paired wins, ties, losses, and excluded pairs",
        "pass-rate-by-task.png": "final task × agent outcome matrix",
        "resource-tradeoff.png": "resource profile or cross-agent trade-off",
        "round-timeline.png": "compact final-attempt round matrix",
        "token-breakdown.png": "non-overlapping median token components",
        "tool-failure-pareto.png": "ranked tool failures in final scored attempts",
    }
    lines += [
        f"- `charts/{name}` — {descriptions[name]}" for name in CHART_FILENAMES
    ]
    lines += ["", "---", "", f"<sub>{provenance}</sub>", ""]
    return "\n".join(lines)


def _health_section(tree) -> list[str]:
    report = tree.report
    final_invalid = [
        attempt
        for attempt in tree.attempts
        if attempt.is_final and attempt.status == "invalid_infrastructure"
    ]
    retry_invalid = [
        attempt
        for attempt in tree.attempts
        if not attempt.is_final and attempt.status == "invalid_infrastructure"
    ]
    lines = [
        "",
        "## Run health",
        "",
        f"- **{report['scoredJobs']}/{report['plannedJobs']}** planned jobs produced a verifier score.",
        f"- **{len(final_invalid)}** final jobs are infrastructure-invalid; "
        f"**{len(retry_invalid)}** earlier invalid attempts were retried.",
    ]
    unavailable = [
        agent for agent in report["agents"] if agent["validRuns"] == 0
    ]
    for agent in unavailable:
        lines.append(
            f"- **{agent['agentId']} has no valid sample.** Its pass rate and "
            "cross-agent comparison are unavailable, not 0%."
        )
    grouped = defaultdict(lambda: {"attempts": 0, "jobs": set()})
    for attempt in tree.attempts:
        if attempt.status != "invalid_infrastructure":
            continue
        if attempt.failure is None:
            raise ValueError(f"Invalid attempt has no failure: {attempt.attempt_id}")
        key = (
            attempt.agent_id,
            attempt.failure["kind"],
            attempt.failure["phase"],
            attempt.failure["message"],
        )
        grouped[key]["attempts"] += 1
        grouped[key]["jobs"].add(attempt.task_id)
    if grouped:
        lines += [
            "",
            "### Blocking diagnostics",
            "",
            "| agent | kind / phase | attempts | jobs | diagnostic |",
            "| --- | --- | ---: | ---: | --- |",
        ]
        for key, counts in sorted(
            grouped.items(), key=lambda item: item[1]["attempts"], reverse=True
        ):
            agent_id, kind, phase, message = key
            lines.append(
                f"| {agent_id} | {kind} / {phase} | {counts['attempts']} "
                f"| {len(counts['jobs'])} | {_escape_cell(message)} |"
            )
    return lines + [""]


def _resource_section(report) -> list[str]:
    """Per-agent cost and effort medians.

    Cache hit rate is the ratio that separates two agents whose per-round
    context is otherwise identical, so it is reported next to the raw totals
    rather than left to be derived from them.
    """
    lines = ["", "## Resources (median)", ""]
    sampled = [
        agent
        for agent in report["agents"]
        if agent.get("resources", {}).get("elapsedMs", {}).get("count", 0) > 0
    ]
    if not sampled:
        return lines + [
            "No agent reported resource evidence; charts covering cost and "
            "rounds have no data.",
            "",
        ]
    lines += [
        "| agent | elapsed | rounds | tool calls | input | cache read "
        "| cache write | cache hit | uncached | output |",
        "| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |",
    ]
    for agent in sampled:
        resources = agent["resources"]
        elapsed = _median(resources, "elapsedMs")
        input_tokens = _median(resources, "inputTokens")
        cache_read = _median(resources, "cacheReadTokens")
        cache_write = _median(resources, "cacheWriteTokens")
        cached = (
            None
            if input_tokens is None or cache_read is None
            else cache_read + (0 if cache_write is None else cache_write)
        )
        uncached = None if cached is None else input_tokens - cached
        if uncached is not None and uncached < 0:
            raise ValueError(
                f"Cache components exceed input tokens for {agent['agentId']}."
            )
        hit_rate = (
            None
            if input_tokens is None or cache_read is None or input_tokens == 0
            else cached / input_tokens
        )
        lines.append(
            f"| {agent['agentId']} "
            f"| {_seconds(elapsed)} "
            f"| {_count(_median(resources, 'rounds'))} "
            f"| {_count(_median(resources, 'toolCalls'))} "
            f"| {_count(input_tokens)} "
            f"| {_count(cache_read)} "
            f"| {_count(cache_write)} "
            f"| {_percent(hit_rate)} "
            f"| {_count(uncached)} "
            f"| {_count(_median(resources, 'outputTokens'))} |"
        )
    missing = [
        agent["agentId"] for agent in report["agents"] if agent not in sampled
    ]
    if missing:
        lines.append("")
        lines.append(
            f"Missing resource evidence: {', '.join(missing)}. "
            "Charts mark these agents as unavailable."
        )
    return lines + [""]


def _median(resources, key: str):
    return resources.get(key, {}).get("median")


def _seconds(value) -> str:
    return "n/a" if value is None else f"{value / 1000:,.0f} s"


def _count(value) -> str:
    return "n/a" if value is None else f"{round(value):,}"


def _comparison_section(report) -> list[str]:
    lines = ["", "## Comparisons", ""]
    if not report["comparisons"]:
        return lines + ["No agent pair was compared in this run.", ""]
    lines += [
        "| pair | matched | excluded | wins | ties | losses | paired delta |",
        "| --- | ---: | ---: | ---: | ---: | ---: | ---: |",
    ]
    for comparison in report["comparisons"]:
        lines.append(
            f"| {comparison['leftAgentId']} vs {comparison['rightAgentId']} "
            f"| {comparison['matchedRuns']} | {comparison['excludedPairs']} "
            f"| {comparison['wins']} | {comparison['ties']} | {comparison['losses']} "
            f"| {_percent(comparison['pairedPassRateDelta'])} |"
        )
        if comparison["matchedRuns"] == 0:
            lines.append(
                f"| ^ | *comparison unavailable; {comparison['excludedPairs']} pairs excluded* "
                "| | | | | |"
            )
    return lines + [""]


def _tool_failure_section(tree) -> list[str]:
    failures = collect_tool_failures(tree)
    lines = ["", "## Tool failures", ""]
    ranked = [
        (agent_id, tool, count)
        for agent_id, counter in sorted(failures.items())
        for tool, count in counter.most_common()
    ]
    if not ranked:
        return lines + ["No failed tool call was recorded.", ""]
    lines += ["| agent | tool | failed calls |", "| --- | --- | ---: |"]
    lines += [f"| {agent} | {tool} | {count} |" for agent, tool, count in ranked]
    return lines + [""]


def _drift_section(tree) -> list[str]:
    drifted = [
        (attempt.attempt_id, attempt.agent_id, attempt.unknown_fields)
        for attempt in tree.attempts
        if attempt.unknown_fields
    ]
    lines = ["", "## Upstream format drift", ""]
    if not drifted:
        return lines + ["No unknown Agent field was observed.", ""]
    lines += [
        "Fields the Agent emitted that this framework does not consume. These do"
        " not invalidate a run; they mark a wire format that has moved.",
        "",
        "| attempt | agent | unknown fields |",
        "| --- | --- | --- |",
    ]
    lines += [
        f"| `{attempt_id[:12]}` | {agent_id} | {', '.join(f'`{f}`' for f in fields)} |"
        for attempt_id, agent_id, fields in drifted
    ]
    return lines + [""]


def _invalid_section(tree) -> list[str]:
    lines = ["", "## Final invalid jobs", ""]
    invalid = [
        attempt
        for attempt in tree.attempts
        if attempt.is_final and attempt.status == "invalid_infrastructure"
    ]
    if not invalid:
        return lines + ["No attempt was rejected as infrastructure-invalid.", ""]
    grouped = defaultdict(list)
    for attempt in invalid:
        failure = attempt.failure
        if failure is None:
            raise ValueError(f"Invalid attempt has no failure: {attempt.attempt_id}")
        key = (
            attempt.agent_id,
            failure["kind"],
            failure["phase"],
            failure["message"],
        )
        grouped[key].append(attempt)
    lines += [
        "| agent | kind / phase | final jobs | affected tasks | diagnostic |",
        "| --- | --- | ---: | --- | --- |",
    ]
    for key, attempts in sorted(
        grouped.items(), key=lambda item: len(item[1]), reverse=True
    ):
        agent_id, kind, phase, message = key
        tasks = (
            ", ".join(attempt.task_id for attempt in attempts)
            if len(attempts) <= 5
            else f"{len(attempts)} tasks; see `suite-report.json` invalidLedger"
        )
        lines.append(
            f"| {agent_id} | {kind} / {phase} | {len(attempts)} | {tasks} "
            f"| {_escape_cell(message)} |"
        )
    historical = sum(
        not attempt.is_final and attempt.status == "invalid_infrastructure"
        for attempt in tree.attempts
    )
    return lines + [
        "",
        f"Earlier retry history contains {historical} additional invalid attempts; "
        "the aggregated causes are listed under Run health.",
        "",
    ]


def _escape_cell(value: str) -> str:
    return value.replace("|", "\\|").replace("\n", " ")


def _percent(value) -> str:
    return "--" if value is None else f"{value:.1%}"


def _interval_text(interval, valid_runs: int) -> str:
    if interval is None:
        return f"n<{MIN_INTERVAL_SAMPLES} (n={valid_runs})"
    return f"{interval.low:.1%} – {interval.high:.1%}"
