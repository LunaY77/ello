import { access } from 'node:fs/promises';
import path from 'node:path';

import {
  AgentComparisonReportSchema,
  AgentReportSchema,
  SuiteReportSchema,
  TaskAgentReportSchema,
} from '../../domain/contract/index.js';
import { stableJson } from '../../domain/hash.js';
import { readJsonFile } from '../io.js';
import { calculateSuiteReport } from '../report/fs-report.js';

export async function validatePublishedReport(
  runRoot: string,
): Promise<boolean> {
  const reportPath = path.join(runRoot, 'results', 'suite-report.json');
  if (!(await exists(reportPath))) return false;
  const report = await readJsonFile(reportPath, SuiteReportSchema);
  const expected = await calculateSuiteReport(runRoot, report.generatedAt);
  if (stableJson(report) !== stableJson(expected)) {
    throw new Error(`Suite report does not match run evidence: ${reportPath}`);
  }
  for (const agent of expected.agents) {
    const agentPath = path.join(
      runRoot,
      'results',
      'agents',
      `${agent.agentId}.json`,
    );
    const publishedAgent = await readJsonFile(agentPath, AgentReportSchema);
    if (stableJson(publishedAgent) !== stableJson(agent)) {
      throw new Error(`Agent report does not match run evidence: ${agentPath}`);
    }
    for (const task of agent.tasks) {
      const taskPath = path.join(
        runRoot,
        'results',
        'tasks',
        task.taskId,
        `${agent.agentId}.json`,
      );
      const publishedTask = await readJsonFile(taskPath, TaskAgentReportSchema);
      if (stableJson(publishedTask) !== stableJson(task)) {
        throw new Error(`Task report does not match run evidence: ${taskPath}`);
      }
    }
  }
  for (const comparison of expected.comparisons) {
    const comparisonPath = path.join(
      runRoot,
      'results',
      'comparisons',
      `${comparison.leftAgentId}-vs-${comparison.rightAgentId}.json`,
    );
    const publishedComparison = await readJsonFile(
      comparisonPath,
      AgentComparisonReportSchema,
    );
    if (stableJson(publishedComparison) !== stableJson(comparison)) {
      throw new Error(
        `Comparison report does not match run evidence: ${comparisonPath}`,
      );
    }
  }
  return true;
}

async function exists(target: string): Promise<boolean> {
  try {
    await access(target);
    return true;
  } catch (error) {
    if (
      error instanceof Error &&
      'code' in error &&
      (error as NodeJS.ErrnoException).code === 'ENOENT'
    ) {
      return false;
    }
    throw error;
  }
}
