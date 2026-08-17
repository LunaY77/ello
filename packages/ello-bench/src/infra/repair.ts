import path from 'node:path';

import {
  RunManifestSchema,
  SuiteManifestSchema,
  type RunManifest,
} from '../domain/contract/index.js';

import { salvageAttemptVerdict } from './attempt-salvage.js';
import { readJsonFile, writeJsonAtomic } from './io.js';

export interface RepairedAttempt {
  readonly taskId: string;
  readonly agentId: string;
  readonly replicate: number;
  readonly attempt: number;
  readonly attemptId: string;
  readonly reward: 0 | 1;
  readonly outcome: string;
  readonly previousStatus: RunManifest['status'];
  readonly previousFailure: string | null;
  readonly runPath: string;
}

export interface RepairResult {
  readonly runRoot: string;
  readonly applied: boolean;
  readonly scanned: number;
  readonly repaired: readonly RepairedAttempt[];
  /** 不会再被执行的非终态 attempt，按 resume 的中断语义收尾。 */
  readonly closed: readonly {
    readonly taskId: string;
    readonly agentId: string;
    readonly attempt: number;
    readonly previousStatus: RunManifest['status'];
    /** 该 job 是否已经有判决；false 表示这个 job 仍需重跑。 */
    readonly jobHasVerdict: boolean;
  }[];
  readonly unsalvageable: readonly {
    readonly taskId: string;
    readonly agentId: string;
    readonly attempt: number;
    readonly status: RunManifest['status'];
    readonly reason: string;
  }[];
}

/**
 * 把「判决已经产出、只是没记账」的 attempt 补记成 completed，并收尾残留的非终态 attempt。
 *
 * 补记用的是 resume 路径上同一个 salvageAttemptVerdict：证据齐全才改，字段全部取自
 * 该 attempt 自己的 report.json / model.patch / agent process，不重建也不推断。判决无法
 * 挽救的非终态 attempt 一律按 resume 的 `resume-interrupted-run` 语义写成
 * invalid_infrastructure：它只声明「这次 attempt 被中断了」，不产生 reward，也不改变该 job
 * 是否需要重跑。手动 kill 掉 runner 之后，这一步让 run root 重新自洽，report 与 validate
 * 才能读它。默认只报告不落盘，applied 为 true 时才写回 run.json。
 */
export async function repairRunRoot(options: {
  readonly runRoot: string;
  readonly apply: boolean;
}): Promise<RepairResult> {
  const runRoot = path.resolve(options.runRoot);
  const suitePath = path.join(runRoot, 'suite-manifest.json');
  const suite = await readJsonFile(suitePath, SuiteManifestSchema);
  const repaired: RepairedAttempt[] = [];
  const unsalvageable: RepairResult['unsalvageable'][number][] = [];
  const closed: RepairResult['closed'][number][] = [];
  let scanned = 0;
  for (const attemptPaths of Object.values(suite.attempts)) {
    const salvagedHere: string[] = [];
    for (const runPath of attemptPaths) {
      const manifest = await readJsonFile(runPath, RunManifestSchema);
      if (manifest.status === 'completed') {
        salvagedHere.push(runPath);
        continue;
      }
      scanned += 1;
      const salvaged = await salvageAttemptVerdict(manifest);
      if (salvaged === undefined) {
        unsalvageable.push({
          taskId: manifest.job.taskId,
          agentId: manifest.job.agentId,
          attempt: manifest.attempt,
          status: manifest.status,
          reason: reasonForUnsalvageable(manifest),
        });
        continue;
      }
      if (options.apply) await writeJsonAtomic(runPath, salvaged.manifest);
      salvagedHere.push(runPath);
      repaired.push({
        taskId: manifest.job.taskId,
        agentId: manifest.job.agentId,
        replicate: manifest.job.replicate,
        attempt: manifest.attempt,
        attemptId: manifest.attemptId,
        reward: salvaged.harness.reward,
        outcome: salvaged.manifest.outcome ?? 'unknown',
        previousStatus: manifest.status,
        previousFailure: manifest.failure?.message ?? null,
        runPath,
      });
    }
    // 剩下的非终态 attempt 不会再被这次 runner 执行，却会让 report 和 validate 报
    // 「Attempt is not terminal」。按 resume 本来就会做的方式给它们收尾，run root 才自洽。
    const jobHasVerdict = salvagedHere.length > 0;
    for (const runPath of attemptPaths) {
      if (salvagedHere.includes(runPath)) continue;
      const manifest = await readJsonFile(runPath, RunManifestSchema);
      if (
        manifest.status === 'completed' ||
        manifest.status === 'invalid_infrastructure'
      ) {
        continue;
      }
      const failure = {
        kind: 'runner' as const,
        phase: 'resume-interrupted-run',
        message: jobHasVerdict
          ? `Runner stopped while attempt was in state ${manifest.status}; this job already has a recorded verdict.`
          : `Runner stopped while attempt was in state ${manifest.status}; this job has no verdict and still needs a rerun.`,
      };
      if (options.apply) {
        await writeJsonAtomic(
          runPath,
          RunManifestSchema.parse({
            ...manifest,
            status: 'invalid_infrastructure',
            phase: failure.phase,
            completedAt: new Date().toISOString(),
            failure,
          }),
        );
      }
      closed.push({
        taskId: manifest.job.taskId,
        agentId: manifest.job.agentId,
        attempt: manifest.attempt,
        previousStatus: manifest.status,
        jobHasVerdict,
      });
    }
  }
  if (options.apply && (repaired.length > 0 || closed.length > 0)) {
    await writeJsonAtomic(
      suitePath,
      SuiteManifestSchema.parse({
        ...suite,
        updatedAt: new Date().toISOString(),
      }),
    );
  }
  return {
    runRoot,
    applied: options.apply,
    scanned,
    repaired,
    closed,
    unsalvageable,
  };
}

function reasonForUnsalvageable(manifest: RunManifest): string {
  if (manifest.patch === undefined) return 'agent 未产出 patch';
  return 'report.json 缺失或与 patch 不匹配，需要只重跑 verifier';
}
