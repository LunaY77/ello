#!/usr/bin/env node
// 盘点一个或多个 benchmark run root：哪些 job 已完成、哪些还需要重跑、哪些已经
// 用尽 infrastructure 重试次数。
//
//   node run-status.mjs <run-root> [<run-root>...] [选项]
//
//   --json              输出机器可读的完整结果
//   --brief             每个 run root 只打一行摘要（用于列全部 run root）
//   --max-retries N     重试上限口径，需与 config 的 max_infrastructure_retries 一致
//                       未指定时取环境变量 MAX_INFRASTRUCTURE_RETRIES，再退回 1
import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';

const argv = process.argv.slice(2);
const options = parseArguments(argv);
const { asJson, brief, maxRetries, runRoots } = options;

if (runRoots.length === 0) {
  console.error(
    'Usage: node run-status.mjs <run-root> [<run-root>...] [--json] [--brief] [--max-retries N]',
  );
  process.exit(2);
}

const reports = [];
let failed = false;
for (const runRoot of runRoots) {
  const report = await inspectRunRoot(runRoot);
  if (report === undefined) {
    failed = true;
    continue;
  }
  reports.push(report);
}

if (asJson) {
  console.log(
    JSON.stringify(reports.length === 1 ? reports[0] : reports, null, 2),
  );
} else if (brief) {
  for (const report of reports) printBrief(report);
} else {
  for (const report of reports) printDetailed(report);
}
process.exit(failed ? 1 : 0);

async function inspectRunRoot(runRoot) {
  const manifestPath = path.join(path.resolve(runRoot), 'suite-manifest.json');
  let manifest;
  try {
    manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
  } catch (error) {
    console.error(`Cannot read ${manifestPath}: ${error.message}`);
    return undefined;
  }
  const notStarted = [];
  const completed = [];
  const inProgress = [];
  const rerunnable = [];
  const exhausted = [];
  const unreadable = [];
  const now = Date.now();
  for (const [jobId, attemptPaths] of Object.entries(manifest.attempts ?? {})) {
    if (attemptPaths.length === 0) {
      notStarted.push({ jobId });
      continue;
    }
    const attemptPath = attemptPaths.at(-1);
    let run;
    try {
      run = JSON.parse(await readFile(attemptPath, 'utf8'));
    } catch (error) {
      // 证据缺失（attempt 目录被删/写坏）既不是完成也不是可重跑，单独一档，
      // 否则会被误计入 retry_exhausted，看上去像是重试用尽。
      unreadable.push({ jobId, attemptPath, reason: error.message });
      continue;
    }
    const entry = {
      task: run.job.taskId,
      agent: run.job.agentId,
      replicate: run.job.replicate,
      attempt: run.attempt,
      status: run.status,
      phase: run.phase,
    };
    if (run.status === 'completed') {
      completed.push(entry);
      continue;
    }
    // 只有终态 attempt 才能判定重试是否用尽：ello-bench 的 selectAttempt 是在
    // 「决定要不要开下一个 attempt」时才比较 attempt 与上限的。一个非终态的
    // attempt 要么正在跑，要么是被中断的残留，都不等于 retry_exhausted。
    if (run.status !== 'invalid_infrastructure') {
      inProgress.push({
        ...entry,
        idleMinutes: Math.round(
          (now - (await lastActivityMs(attemptPath))) / 60_000,
        ),
        lastChance: run.attempt > maxRetries,
      });
      continue;
    }
    if (run.attempt > maxRetries) exhausted.push(entry);
    else rerunnable.push(entry);
  }
  return {
    summary: {
      runRoot: manifest.runRoot ?? path.resolve(runRoot),
      suite: manifest.suite?.id,
      maxInfrastructureRetries: maxRetries,
      jobs: Object.keys(manifest.attempts ?? {}).length,
      completed: completed.length,
      notStarted: notStarted.length,
      inProgress: inProgress.length,
      rerunnable: rerunnable.length,
      retryExhausted: exhausted.length,
      unreadable: unreadable.length,
    },
    completed,
    inProgress,
    rerunnable,
    exhausted,
    unreadable,
  };
}

// run.json 只在状态迁移时重写，phase-timings.json 每个 phase 结束都写，
// 取两者较新的一个作为「最后活动时间」，用来区分在跑和被中断的残留。
async function lastActivityMs(attemptPath) {
  let newest = 0;
  for (const candidate of [
    attemptPath,
    attemptPath.replace('run.json', 'raw/phase-timings.json'),
  ]) {
    try {
      const metadata = await stat(candidate);
      newest = Math.max(newest, metadata.mtimeMs);
    } catch {
      // 缺文件就跳过：run.json 一定存在，phase-timings 可能还没写
    }
  }
  return newest;
}

function printBrief({ summary }) {
  console.log(
    [
      path.basename(summary.runRoot).padEnd(28),
      (summary.suite ?? '?').padEnd(26),
      `jobs ${String(summary.jobs).padStart(3)}`,
      `done ${String(summary.completed).padStart(3)}`,
      `active ${String(summary.inProgress).padStart(3)}`,
      `todo ${String(summary.notStarted + summary.rerunnable).padStart(3)}`,
      `exhausted ${String(summary.retryExhausted).padStart(3)}`,
      `unreadable ${String(summary.unreadable).padStart(3)}`,
    ].join('  '),
  );
}

function printDetailed({
  summary,
  inProgress,
  rerunnable,
  exhausted,
  unreadable,
}) {
  console.log(`run root        ${summary.runRoot}`);
  console.log(`suite           ${summary.suite}`);
  console.log(`max retries     ${summary.maxInfrastructureRetries}`);
  console.log(`jobs            ${summary.jobs}`);
  console.log(`completed       ${summary.completed}`);
  console.log(`in progress     ${summary.inProgress}`);
  console.log(`not started     ${summary.notStarted}`);
  console.log(`needs rerun     ${summary.rerunnable}`);
  console.log(`retry exhausted ${summary.retryExhausted}`);
  console.log(`unreadable      ${summary.unreadable}`);
  for (const entry of inProgress) {
    console.log(
      `  active     ${entry.task} / ${entry.agent} attempt ${entry.attempt} (${entry.status} @ ${entry.phase}) 最后活动 ${entry.idleMinutes} 分钟前${entry.lastChance ? ' [最后一次机会]' : ''}`,
    );
  }
  for (const entry of rerunnable) {
    console.log(
      `  rerun      ${entry.task} / ${entry.agent} / r${entry.replicate} attempt ${entry.attempt} (${entry.status} @ ${entry.phase})`,
    );
  }
  for (const entry of exhausted) {
    console.log(
      `  exhausted  ${entry.task} / ${entry.agent} attempt ${entry.attempt} (${entry.status})`,
    );
  }
  for (const entry of unreadable) {
    console.log(`  unreadable ${entry.jobId} -> ${entry.attemptPath}`);
  }
}

function readMaxRetries(raw) {
  const parsed = Number(raw ?? process.env.MAX_INFRASTRUCTURE_RETRIES ?? '1');
  if (!Number.isSafeInteger(parsed) || parsed < 0) {
    console.error(`Invalid retry ceiling: ${raw}`);
    process.exit(2);
  }
  return parsed;
}

// 手写解析而不是遍历过滤：--max-retries 的值绝不能被当成 run root 路径。
function parseArguments(args) {
  const runRoots = [];
  let asJson = false;
  let brief = false;
  let rawMaxRetries;
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === '--json') asJson = true;
    else if (argument === '--brief') brief = true;
    else if (argument === '--max-retries') {
      index += 1;
      rawMaxRetries = args[index];
      if (rawMaxRetries === undefined) {
        console.error('--max-retries requires a value.');
        process.exit(2);
      }
    } else if (argument.startsWith('--')) {
      console.error(`Unknown option: ${argument}`);
      process.exit(2);
    } else runRoots.push(argument);
  }
  return { asJson, brief, maxRetries: readMaxRetries(rawMaxRetries), runRoots };
}
