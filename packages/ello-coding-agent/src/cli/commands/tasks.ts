import type { Command } from 'commander';

import type { CliCommandContext, CliCommandModule } from '../types.js';

export const taskCommands: CliCommandModule = {
  register(program, ctx) {
    registerTaskCommands(program, ctx);
    registerSkillCommands(program, ctx);
  },
};

function registerTaskCommands(program: Command, ctx: CliCommandContext): void {
  const taskCmd = program.command('task').description('manage persisted tasks');
  taskCmd
    .command('list')
    .description('list tasks')
    .action(async (_opts: unknown, cmd: Command) => {
      const config = await ctx.resolveConfig(cmd.optsWithGlobals());
      const { createTaskService, formatTaskList } =
        await import('../../tasks/index.js');
      const tasks = await createTaskService().list();
      ctx.io.stdout.write(
        `${config.json ? JSON.stringify(tasks, null, 2) : formatTaskList(tasks)}\n`,
      );
    });
  taskCmd
    .command('get')
    .argument('<id>', 'task id')
    .description('show one task')
    .action(async (id: string, _opts: unknown, cmd: Command) => {
      const config = await ctx.resolveConfig(cmd.optsWithGlobals());
      const { createTaskService, formatTask } =
        await import('../../tasks/index.js');
      const task = await createTaskService().get(id);
      if (task === null) {
        throw new Error(`Unknown task: ${id}`);
      }
      ctx.io.stdout.write(
        `${config.json ? JSON.stringify(task, null, 2) : formatTask(task)}\n`,
      );
    });
  taskCmd
    .command('create')
    .requiredOption('--subject <subject>', 'task subject')
    .option('--description <description>', 'task description')
    .option('--owner <owner>', 'task owner')
    .description('create a task')
    .action(
      async (
        opts: { subject: string; description?: string; owner?: string },
        cmd: Command,
      ) => {
        const config = await ctx.resolveConfig(cmd.optsWithGlobals());
        const { createTaskService, formatTask } =
          await import('../../tasks/index.js');
        const task = await createTaskService().create({
          subject: opts.subject,
          ...(opts.description !== undefined
            ? { description: opts.description }
            : {}),
          ...(opts.owner !== undefined ? { owner: opts.owner } : {}),
        });
        ctx.io.stdout.write(
          `${config.json ? JSON.stringify(task, null, 2) : formatTask(task)}\n`,
        );
      },
    );
  taskCmd
    .command('update')
    .argument('<id>', 'task id')
    .option('--subject <subject>', 'task subject')
    .option('--description <description>', 'task description')
    .option(
      '--status <status>',
      'pending | in_progress | completed | cancelled',
    )
    .option('--owner <owner>', 'task owner')
    .description('update a task')
    .action(
      async (
        id: string,
        opts: {
          subject?: string;
          description?: string;
          status?: 'pending' | 'in_progress' | 'completed' | 'cancelled';
          owner?: string;
        },
        cmd: Command,
      ) => {
        const config = await ctx.resolveConfig(cmd.optsWithGlobals());
        const { createTaskService, formatTask } =
          await import('../../tasks/index.js');
        const task = await createTaskService().update(id, {
          ...(opts.subject !== undefined ? { subject: opts.subject } : {}),
          ...(opts.description !== undefined
            ? { description: opts.description }
            : {}),
          ...(opts.status !== undefined ? { status: opts.status } : {}),
          ...(opts.owner !== undefined ? { owner: opts.owner } : {}),
        });
        ctx.io.stdout.write(
          `${config.json ? JSON.stringify(task, null, 2) : formatTask(task)}\n`,
        );
      },
    );
  taskCmd
    .command('delete')
    .argument('<id>', 'task id')
    .description('delete a task')
    .action(async (id: string, _opts: unknown, cmd: Command) => {
      const config = await ctx.resolveConfig(cmd.optsWithGlobals());
      const { createTaskService } = await import('../../tasks/index.js');
      const deleted = await createTaskService().delete(id);
      ctx.io.stdout.write(
        `${config.json ? JSON.stringify({ id, deleted }) : `deleted\t${id}\t${deleted}`}\n`,
      );
    });
  taskCmd
    .command('claim')
    .argument('<id>', 'task id')
    .requiredOption('--owner <owner>', 'task owner')
    .description('claim a task')
    .action(async (id: string, opts: { owner: string }, cmd: Command) => {
      const config = await ctx.resolveConfig(cmd.optsWithGlobals());
      const { createTaskService, formatClaimResult } =
        await import('../../tasks/index.js');
      const result = await createTaskService().claim(id, opts.owner);
      ctx.io.stdout.write(
        `${config.json ? JSON.stringify(result, null, 2) : formatClaimResult(result)}\n`,
      );
    });
  taskCmd
    .command('reset')
    .description('reset current task list')
    .action(async (_opts: unknown, cmd: Command) => {
      const config = await ctx.resolveConfig(cmd.optsWithGlobals());
      const { createTaskService } = await import('../../tasks/index.js');
      await createTaskService().reset();
      ctx.io.stdout.write(
        `${config.json ? JSON.stringify({ reset: true }) : 'reset\ttrue'}\n`,
      );
    });
}

function registerSkillCommands(program: Command, ctx: CliCommandContext): void {
  const skillsCmd = program.command('skills').description('inspect skills');
  skillsCmd
    .command('list')
    .description('list skills')
    .action(async (_opts: unknown, cmd: Command) => {
      const config = await ctx.resolveConfig(cmd.optsWithGlobals());
      const { loadCodingSkills, formatSkillList } =
        await import('../../skills/index.js');
      const skills = await loadCodingSkills(config);
      ctx.io.stdout.write(
        `${config.json ? JSON.stringify(skills, null, 2) : formatSkillList(skills)}\n`,
      );
    });
  skillsCmd
    .command('get')
    .argument('<name>', 'skill name')
    .description('show one skill')
    .action(async (name: string, _opts: unknown, cmd: Command) => {
      const config = await ctx.resolveConfig(cmd.optsWithGlobals());
      const { loadCodingSkills, formatSkill } =
        await import('../../skills/index.js');
      const skill = (await loadCodingSkills(config)).find(
        (item) => item.name === name,
      );
      if (skill === undefined) {
        throw new Error(`Unknown skill: ${name}`);
      }
      ctx.io.stdout.write(
        `${config.json ? JSON.stringify(skill, null, 2) : formatSkill(skill)}\n`,
      );
    });
  skillsCmd
    .command('search')
    .argument('<query...>', 'search query')
    .description('search skills')
    .action(async (queryParts: string[], _opts: unknown, cmd: Command) => {
      const config = await ctx.resolveConfig(cmd.optsWithGlobals());
      const { loadCodingSkills, formatSkillList } =
        await import('../../skills/index.js');
      const query = queryParts.join(' ').toLowerCase();
      const skills = (await loadCodingSkills(config)).filter((skill) =>
        [skill.name, skill.description, skill.whenToUse ?? '']
          .join('\n')
          .toLowerCase()
          .includes(query),
      );
      ctx.io.stdout.write(
        `${config.json ? JSON.stringify(skills, null, 2) : formatSkillList(skills)}\n`,
      );
    });
}
