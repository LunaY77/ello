#!/usr/bin/env node
import path from 'node:path';

import { renderAnalysis } from './analysis.js';
import { DEFAULT_CONFIG_PATH, loadBenchmarkConfig } from './config.js';
import { runDoctor } from './doctor.js';
import { runBenchmarkMatrix } from './matrix-runner.js';
import { createPlan, selectAll } from './matrix.js';
import { generateSuiteReport } from './report.js';
import { validateRunRoot } from './validation.js';

const argv = process.argv.slice(2);
const command = argv.shift() ?? 'help';

try {
  const options = parseOptions(argv, command);
  if (command === 'list') {
    const config = await loadBenchmarkConfig(options.configPath);
    rejectAllSelection(options);
    writeJson(
      config.tasks.map(({ taskId, language, difficultyBand }) => ({
        taskId,
        language,
        difficultyBand,
      })),
    );
  } else if (command === 'agents') {
    const config = await loadBenchmarkConfig(options.configPath);
    rejectAllSelection(options);
    writeJson(
      config.agents.map((agent) => ({
        id: agent.id,
        displayName: agent.displayName,
        kind: agent.kind,
        model:
          agent.kind === 'ello'
            ? {
                primaryModel: agent.primaryModel,
                auxiliaryModel: agent.auxiliaryModel,
                models: agent.models,
              }
            : agent.model,
        expectedVersion:
          agent.kind === 'ello' ? null : agent.binary.expectedVersion,
      })),
    );
  } else if (command === 'plan') {
    const config = await loadBenchmarkConfig(options.configPath);
    rejectRunPaths(options);
    writeJson(createPlan(config, requiredSelection(config, options)));
  } else if (command === 'doctor') {
    const config = await loadBenchmarkConfig(options.configPath);
    rejectRunPaths(options);
    rejectTaskSelection(options);
    const agentIds = requiredAgentSelection(config, options);
    const result = await runDoctor(config, new Set(agentIds));
    writeJson(result);
    if (!result.ready) process.exitCode = 1;
  } else if (command === 'validate') {
    rejectTaskSelection(options);
    rejectAgentSelection(options);
    if (options.runRoot === undefined) {
      const config = await loadBenchmarkConfig(options.configPath);
      const plan = createPlan(config, selectAll(config));
      writeJson({
        valid: true,
        suite: config.suite,
        taskCount: config.tasks.length,
        jobCount: plan.jobs.length,
        configHash: plan.configHash,
        planHash: plan.planHash,
      });
    } else {
      rejectConfig(options);
      writeJson(await validateRunRoot(options.runRoot));
    }
  } else if (command === 'run') {
    const config = await loadBenchmarkConfig(options.configPath);
    const runRoot = required(options.runRoot, '--run-root');
    const selection = requiredSelection(config, options);
    const corpusRoot =
      options.corpusRoot ??
      path.resolve(
        path.dirname(options.configPath),
        '..',
        'raw',
        '_cache',
        config.suite.id,
      );
    const matrix = await runBenchmarkMatrix({
      config,
      runRoot,
      corpusRoot,
      taskIds: new Set(selection.taskIds),
      agentIds: new Set(selection.agentIds),
    });
    if (options.report) {
      const report = await generateSuiteReport(runRoot);
      if (report.reportConfig.renderCharts) await renderAnalysis(runRoot);
      writeJson({
        matrix,
        report,
        validation: await validateRunRoot(runRoot),
      });
    } else {
      writeJson({ matrix });
      // Aggregation and validation run as separate commands so a defect in
      // either cannot rewrite the outcome of a completed experiment.
      process.stderr.write(
        `Run complete. Artifacts at ${runRoot}.\n` +
          `Next: ello-bench report --run-root ${runRoot}\n` +
          `      ello-bench validate --run-root ${runRoot}\n`,
      );
    }
    // Only infrastructure failure fails the run itself.
    if (matrix.retryExhausted > 0) process.exitCode = 1;
  } else if (command === 'report') {
    rejectConfig(options);
    rejectTaskSelection(options);
    rejectAgentSelection(options);
    const runRoot = required(options.runRoot, '--run-root');
    const report = await generateSuiteReport(runRoot);
    writeJson(report);
    if (report.reportConfig.renderCharts) await renderAnalysis(runRoot);
  } else if (command === 'help') {
    process.stdout.write(usage());
  } else {
    throw new Error(`Unknown command: ${command}`);
  }
} catch (error) {
  process.stderr.write(
    `${error instanceof Error ? error.message : String(error)}\n`,
  );
  process.exitCode = 1;
}

interface CliOptions {
  readonly configPath: string;
  readonly runRoot?: string;
  readonly corpusRoot?: string;
  readonly allTasks: boolean;
  readonly allAgents: boolean;
  readonly report: boolean;
  readonly configProvided: boolean;
  readonly taskIds: readonly string[];
  readonly agentIds: readonly string[];
}

function parseOptions(args: readonly string[], command: string): CliOptions {
  let configPath = DEFAULT_CONFIG_PATH;
  let runRoot: string | undefined;
  let corpusRoot: string | undefined;
  let allTasks = false;
  let allAgents = false;
  let report = false;
  let configProvided = false;
  const taskIds: string[] = [];
  const agentIds: string[] = [];
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === '--report') {
      report = true;
      continue;
    }
    if (argument === '--all') {
      allTasks = true;
      continue;
    }
    if (argument === '--all-agents') {
      allAgents = true;
      continue;
    }
    if (argument === '--config') {
      configPath = required(args[index + 1], '--config');
      configProvided = true;
      index += 1;
      continue;
    }
    if (argument === '--run-root') {
      runRoot = required(args[index + 1], '--run-root');
      index += 1;
      continue;
    }
    if (argument === '--corpus-root') {
      corpusRoot = required(args[index + 1], '--corpus-root');
      index += 1;
      continue;
    }
    if (argument === '--task') {
      taskIds.push(required(args[index + 1], '--task'));
      index += 1;
      continue;
    }
    if (argument === '--agent') {
      agentIds.push(required(args[index + 1], '--agent'));
      index += 1;
      continue;
    }
    throw new Error(`Unknown option: ${String(argument)}`);
  }
  if (report && command !== 'run') {
    throw new Error('--report is only valid for the run command.');
  }
  if (new Set(taskIds).size !== taskIds.length) {
    throw new Error('Duplicate --task value.');
  }
  if (new Set(agentIds).size !== agentIds.length) {
    throw new Error('Duplicate --agent value.');
  }
  return {
    configPath: path.resolve(configPath),
    ...(runRoot === undefined ? {} : { runRoot: path.resolve(runRoot) }),
    ...(corpusRoot === undefined
      ? {}
      : { corpusRoot: path.resolve(corpusRoot) }),
    allTasks,
    allAgents,
    report,
    configProvided,
    taskIds,
    agentIds,
  };
}

function rejectAllSelection(options: CliOptions): void {
  rejectTaskSelection(options);
  rejectAgentSelection(options);
  rejectRunPaths(options);
}

function rejectRunPaths(options: CliOptions): void {
  if (options.runRoot !== undefined || options.corpusRoot !== undefined) {
    throw new Error('This command does not accept run paths.');
  }
}

function rejectConfig(options: CliOptions): void {
  if (options.configProvided) {
    throw new Error(
      'Completed run reports use the report config archived in suite-manifest.json.',
    );
  }
}

function rejectTaskSelection(options: CliOptions): void {
  if (options.allTasks || options.taskIds.length > 0) {
    throw new Error('This command does not accept task selection.');
  }
  if (options.corpusRoot !== undefined) {
    throw new Error('This command does not accept --corpus-root.');
  }
}

function rejectAgentSelection(options: CliOptions): void {
  if (options.allAgents || options.agentIds.length > 0) {
    throw new Error('This command does not accept Agent selection.');
  }
}

function requiredSelection(
  config: Awaited<ReturnType<typeof loadBenchmarkConfig>>,
  options: CliOptions,
): {
  readonly taskIds: readonly string[];
  readonly agentIds: readonly string[];
} {
  if (options.allTasks === options.taskIds.length > 0) {
    throw new Error('Command requires exactly one of --all or --task.');
  }
  return {
    taskIds: options.allTasks
      ? config.tasks.map((task) => task.taskId)
      : options.taskIds,
    agentIds: requiredAgentSelection(config, options),
  };
}

function requiredAgentSelection(
  config: Awaited<ReturnType<typeof loadBenchmarkConfig>>,
  options: CliOptions,
): readonly string[] {
  if (options.allAgents === options.agentIds.length > 0) {
    throw new Error('Command requires exactly one of --all-agents or --agent.');
  }
  return options.allAgents
    ? config.agents.map((agent) => agent.id)
    : options.agentIds;
}

function required(value: string | undefined, option: string): string {
  if (value === undefined || value.startsWith('--')) {
    throw new Error(`${option} requires a value.`);
  }
  return value;
}

function writeJson(value: unknown): void {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

function usage(): string {
  return `Usage:
  ello-bench list [--config PATH]
  ello-bench agents [--config PATH]
  ello-bench plan (--task ID | --all) (--agent ID | --all-agents) [--config PATH]
  ello-bench doctor (--agent ID | --all-agents) [--config PATH]
  ello-bench run (--task ID | --all) (--agent ID | --all-agents) --run-root PATH [--corpus-root PATH] [--report] [--config PATH]
  ello-bench report --run-root PATH
  ello-bench validate [--run-root PATH] [--config PATH]
`;
}
