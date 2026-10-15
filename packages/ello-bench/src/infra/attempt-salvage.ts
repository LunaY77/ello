import { readFile } from 'node:fs/promises';
import path from 'node:path';

import {
  AgentProcessArtifactSchema,
  HarnessReportSchema,
  RunManifestSchema,
  type HarnessReport,
  type RunManifest,
} from '../domain/contract/index.js';
import { classifyDeliveryOutcome } from '../domain/scoring/attempt-outcome.js';

/**
 * 一个 attempt 的判决可能已经产出、却还没被记账。
 *
 * run-attempt 的阶段顺序是 capture-patch -> verifier-running -> 写 report.json
 * -> audit/cleanup -> 最后才把 run.json 迁移到 completed。runner 在这中间任何
 * 一点被杀（OOM、重启、Ctrl-C），attempt 都会停在非终态，而 resume 只看 status
 * 就把它判成 invalid_infrastructure 并重开一个 attempt —— 已经跑完的 agent 和
 * 已经算出来的 reward 一起被丢掉。
 *
 * 这里做的事情只有记账：当 report.json 已经完整落盘时，用它自己的证据把 attempt
 * 收尾成 completed。不重建、不推断、不编造任何一个字段，所有值都来自该 attempt
 * 自己的产物；证据不全就返回 undefined，交回原来的 invalidate 流程。
 */
export interface SalvagedVerdict {
  readonly harness: HarnessReport;
  readonly manifest: RunManifest;
}

export async function salvageAttemptVerdict(
  manifest: RunManifest,
): Promise<SalvagedVerdict | undefined> {
  if (manifest.status === 'completed') return undefined;
  const harness = await readHarnessReport(manifest.attemptRoot);
  if (harness === undefined) return undefined;
  if (manifest.patch === undefined) return undefined;
  const agentProcess = await readAgentProcessResult(manifest);
  if (agentProcess === undefined) return undefined;
  if (harness.modelPatchSha256 !== manifest.patch.sha256) return undefined;
  // RunManifestSchema 对 completed 有完整性约束（task/agent/provenance/client/
  // agentEvidence/toolAudit/phaseTimingsPath ...）。这里必须用 safeParse：证据
  // 不齐时是「这个 attempt 不能收割」，绝不能抛出去把整个矩阵带崩。
  const salvaged = RunManifestSchema.safeParse({
    ...manifest,
    status: 'completed',
    phase: 'completed',
    completedAt: harness.completedAt,
    verifierProcess: harness.verifierProcess,
    harness,
    outcome: classifyDeliveryOutcome({
      process: agentProcess,
      reward: harness.reward,
      patch: manifest.patch,
    }),
    failure: undefined,
  });
  if (!salvaged.success) return undefined;
  return { harness, manifest: salvaged.data };
}

async function readHarnessReport(
  attemptRoot: string,
): Promise<HarnessReport | undefined> {
  const reportPath = path.join(attemptRoot, 'raw', 'harness', 'report.json');
  const parsed = HarnessReportSchema.safeParse(await readJson(reportPath));
  if (!parsed.success) return undefined;
  // reportPath 是绝对路径，跨机器搬运过的 run root 不应被当成同一份证据。
  if (path.resolve(parsed.data.reportPath) !== path.resolve(reportPath)) {
    return undefined;
  }
  return parsed.data;
}

async function readAgentProcessResult(manifest: RunManifest) {
  if (manifest.agentProcess === undefined) return undefined;
  const parsed = AgentProcessArtifactSchema.safeParse(
    await readJson(manifest.agentProcess.path),
  );
  return parsed.success ? parsed.data.process : undefined;
}

async function readJson(target: string): Promise<unknown> {
  try {
    return JSON.parse(await readFile(target, 'utf8'));
  } catch {
    return undefined;
  }
}
