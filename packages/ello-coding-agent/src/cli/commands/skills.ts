import type { Command } from 'commander';

import {
  formatSkill,
  formatSkillList,
  loadCodingSkills,
  searchCodingSkills,
} from '../../skills/index.js';
import type { CliCommandContext, CliCommandModule } from '../types.js';

/**
 * 注册 Skill Catalog 的只读查询命令。
 *
 * 创建、校验、评测和打包属于 Skill Creator 自身能力，不在 Coding Agent 中复制
 * 实现。这里仅暴露运行时已经拥有的 Catalog 视图，保持产品层职责单一。
 */
export const skillCommands: CliCommandModule = {
  register(program, ctx) {
    const skills = program.command('skills').description('inspect skills');
    skills
      .command('list')
      .description('list skills')
      .action((_opts, cmd) => list(ctx, cmd));
    skills
      .command('get')
      .argument('<name>')
      .description('show one skill')
      .action((name, _opts, cmd) => get(ctx, cmd, name));
    skills
      .command('search')
      .argument('<query...>')
      .description('search skills')
      .action((query, _opts, cmd) => search(ctx, cmd, query));
    skills
      .command('reload')
      .description('validate and reload the catalog')
      .action((_opts, cmd) => list(ctx, cmd, true));
  },
};

/** 每个 CLI 进程都重新构建严格 Catalog，因此 reload 同时承担完整校验。 */
async function list(ctx: CliCommandContext, cmd: Command, reloaded = false) {
  const config = await ctx.resolveConfig(cmd.optsWithGlobals());
  const skills = await loadCodingSkills(config);
  const output = config.json
    ? JSON.stringify(skills, null, 2)
    : formatSkillList(skills);
  ctx.io.stdout.write(`${reloaded ? 'reloaded\n' : ''}${output}\n`);
}

async function get(ctx: CliCommandContext, cmd: Command, name: string) {
  const config = await ctx.resolveConfig(cmd.optsWithGlobals());
  const skill = (await loadCodingSkills(config)).find(
    (item) => item.name === name,
  );
  if (skill === undefined) throw new Error(`Unknown skill: ${name}`);
  ctx.io.stdout.write(
    `${config.json ? JSON.stringify(skill, null, 2) : formatSkill(skill)}\n`,
  );
}

async function search(
  ctx: CliCommandContext,
  cmd: Command,
  queryParts: string[],
) {
  const config = await ctx.resolveConfig(cmd.optsWithGlobals());
  const query = queryParts.join(' ');
  const skills = await searchCodingSkills(config, query);
  ctx.io.stdout.write(
    `${config.json ? JSON.stringify(skills, null, 2) : formatSkillList(skills)}\n`,
  );
}
