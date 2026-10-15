#!/usr/bin/env node
/**
 * 本文件提供当前 coding system prompt 的本地只读诊断入口。
 *
 * 命令复用生产配置、模板、instruction 与 Memory loader，不复制 Prompt 装配规则。
 */
import process from 'node:process';
import { parseArgs } from 'node:util';

import { createAgentCommands } from '../app.js';
import {
  createAgentRegistry,
  AgentTaskService,
  AgentTaskStore,
  renderCodingSystemPrompt,
  type CodingSystemPromptRuntime,
} from '../features/agent/index.js';
import {
  loadCodingAgentConfig,
  PromptModeSchema,
} from '../features/config/index.js';
import {
  createMemoryStore,
  MemoryIndexLoader,
  memoryRoots,
} from '../features/memory/index.js';
import { createModelRegistry } from '../features/model/index.js';
import {
  createActivateSkillCommand,
  SkillActivationService,
  SkillCatalog,
} from '../features/skill/index.js';
import { createTaskBoardStore } from '../features/task/index.js';
import { openDatabase } from '../infra/database/index.js';
import { SessionModeSchema } from '../protocol/v1/index.js';

const commandArguments = process.argv.slice(2);
const parsed = parseArgs({
  args:
    commandArguments[0] === '--' ? commandArguments.slice(1) : commandArguments,
  options: {
    agent: { type: 'string' },
    cwd: { type: 'string' },
    help: { type: 'boolean', short: 'h', default: false },
    mode: { type: 'string' },
    profile: { type: 'string' },
  },
  strict: true,
});

if (parsed.values.help) {
  process.stdout
    .write(`Usage: pnpm --filter @ello/agent prompt:show -- [options]

Options:
  --agent <name>     Primary Agent definition (default: resolved config)
  --cwd <path>       Project used to load config and instructions (default: cwd)
  --profile <name>   rapid or thorough (default: resolved config)
  --mode <name>      ask-before-changes, accept-edits, plan, or bypass
  -h, --help         Show this help
`);
  process.exit(0);
}

const cwd = parsed.values.cwd ?? process.cwd();
const mode = SessionModeSchema.parse(
  parsed.values.mode ?? 'ask-before-changes',
);
const config = await loadCodingAgentConfig({
  cwd,
  initial_mode: mode,
  ...(mode === 'bypass' ? { bypass_enabled: true } : {}),
});
const profile = PromptModeSchema.parse(
  parsed.values.profile ?? config.context.prompt_mode,
);
const agentRegistry = await createAgentRegistry(config);
const agentName = parsed.values.agent ?? config.default_agent;
const agentDefinition = agentRegistry.get(agentName);
if (
  (agentDefinition.mode !== 'primary' && agentDefinition.mode !== 'all') ||
  agentDefinition.hidden === true
) {
  throw new Error(`Agent is not selectable as primary: ${agentName}`);
}
const model = createModelRegistry(config).resolveSelector(
  agentDefinition.model,
);
const memory = await createMemoryRuntime(config);
const runtime: CodingSystemPromptRuntime = {
  model: model.name,
  profile,
  ...(memory === undefined ? {} : { memory }),
};
const prompt = await renderCodingSystemPrompt(
  config,
  runtime,
  'Render the current coding system prompt for inspection.',
);
const inspectedCommands = await createCommandRuntime();
const toolDefinition = {
  name: inspectedCommands.commandRun.modelTool.name,
  description: inspectedCommands.commandRun.modelTool.description,
  inputSchema: inspectedCommands.commandRun.modelTool.input.toJSONSchema(),
};

process.stderr.write(
  `[ello prompt] agent=${agentName} model=${model.name} profile=${profile} mode=${mode} catalog_revision=${inspectedCommands.commandRun.catalogRevision} cwd=${config.cwd}\n`,
);
process.stderr.write(
  '[ello prompt] System Prompt is the resolved coding section. Skill index, agent-specific instructions, Goal, and task notifications remain request-dependent system sections.\n',
);
process.stdout.write(`# System Prompt

${prompt.trimEnd()}

# Tool Definitions

\`\`\`json
${JSON.stringify([toolDefinition], null, 2)}
\`\`\`
`);

async function createCommandRuntime() {
  const database = openDatabase({ databasePath: ':memory:' });
  const agentTasks = new AgentTaskService(new AgentTaskStore(database.db), () =>
    Promise.reject(
      new Error('Prompt inspection cannot execute subagent tasks.'),
    ),
  );
  try {
    const skillCatalog = new SkillCatalog(config);
    const skills = await skillCatalog.initialize();
    const activation = new SkillActivationService(skillCatalog);
    const createCommands = createAgentCommands(
      createTaskBoardStore(database.db),
      agentTasks,
    );
    return await createCommands({
      request: {
        threadId: 'prompt-inspection',
        turnId: 'prompt-inspection',
        selection: { mode, agent: agentName },
        history: [],
        input: 'Inspect the current model input.',
        goal: null,
        permission: {
          rules: () => [],
          externalPaths: () => [],
        },
        executionLocation: {
          environmentRef: 'local-host',
          workingDirectory: config.cwd,
        },
      },
      definition: {
        config,
        definition: agentDefinition,
        agentRegistry,
      },
      context: {
        skills,
        activationCommand: createActivateSkillCommand({ service: activation }),
        readRoots: () =>
          skills.flatMap((skill) => [skill.baseDir, skill.realPath]),
        createSystemSections: () => [],
      },
    });
  } finally {
    await agentTasks.close();
    database.close();
  }
}

async function createMemoryRuntime(
  config: Awaited<ReturnType<typeof loadCodingAgentConfig>>,
): Promise<CodingSystemPromptRuntime['memory'] | undefined> {
  if (!config.context.memory.enabled) return undefined;
  const roots = memoryRoots(config);
  const repository = createMemoryStore(roots);
  await repository.initialize();
  return { loader: new MemoryIndexLoader(repository), roots };
}
