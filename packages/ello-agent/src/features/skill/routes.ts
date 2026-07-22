/**
 * 本文件负责 skill feature 的typed route 适配。
 *
 * 状态由本模块声明的对象、闭包或 store 显式持有；跨 feature 依赖只能进入对方公开入口。
 * 外部输入在边界完成校验，非法状态和资源失败直接抛出，调用顺序由公开契约约束。
 */
import { invalidParams } from '../../protocol/errors.js';
import {
  bindFeatureRoute,
  type FeatureHandlerMap,
} from '../../server/rpc/route.js';
import type { RpcPeer, RpcRouteFragment } from '../../server/rpc/route.js';
import { loadCodingAgentConfig } from '../config/index.js';

import { SkillCatalog } from './internal/index.js';

type SkillMethod = 'skills/list' | 'skills/get' | 'skills/reload';

interface SkillContext {
  readonly peer: RpcPeer;
}

/** skills/reload 在返回新 catalog 前广播路径，客户端据此原子刷新展示状态。 */
const skillHandlers = {
  'skills/list': async (_context, params) => {
    const catalog = await skillCatalog(params.cwd);
    const skills = params.query?.trim()
      ? catalog.search(params.query)
      : catalog.list();
    return { data: skills.map(skillEntry) };
  },
  'skills/get': async (_context, params) => {
    const skill = (await skillCatalog(params.cwd)).get(params.name);
    if (skill === undefined) {
      throw invalidParams(`Unknown skill ${params.name}.`);
    }
    return { skill: skillEntry(skill) };
  },
  'skills/reload': async (context, params) => {
    const catalog = await skillCatalog(params.cwd);
    const skills = await catalog.reload();
    await context.peer.notify({
      method: 'skills/changed',
      params: {
        cwd: params.cwd,
        paths: skills.map((skill) => skill.skillPath),
      },
    });
    return { data: skills.map(skillEntry) };
  },
} satisfies FeatureHandlerMap<SkillContext, SkillMethod>;

/**
 * 构造 Skill route 适配 模块 中的 `createSkillRoutes` 结果，并在返回前建立所需的不变量。
 *
 * Args:
 * - 无：操作使用实例或闭包已经持有的稳定状态。
 *
 * Returns:
 * - 返回 `createSkillRoutes` 计算出的声明结果；返回值不包含未声明的兜底状态。
 *
 * Throws:
 * - 当 Skill route 适配 模块 的输入、状态或外部资源不满足契约时直接抛错，并保留底层失败原因。
 */
export function createSkillRoutes(): RpcRouteFragment<SkillMethod> {
  const bind = <M extends SkillMethod>(method: M) =>
    bindFeatureRoute(skillHandlers, (peer) => ({ peer }), method);
  return {
    'skills/list': bind('skills/list'),
    'skills/get': bind('skills/get'),
    'skills/reload': bind('skills/reload'),
  };
}

async function skillCatalog(cwd: string): Promise<SkillCatalog> {
  const config = await loadCodingAgentConfig({ cwd });
  const catalog = new SkillCatalog(config);
  await catalog.initialize();
  return catalog;
}

function skillEntry(skill: Awaited<ReturnType<SkillCatalog['list']>>[number]) {
  return {
    id: skill.name,
    name: skill.name,
    description: skill.description,
    enabled: true,
    metadata: {
      source: skill.source,
      path: skill.skillPath,
      contentHash: skill.contentHash,
    },
  };
}
