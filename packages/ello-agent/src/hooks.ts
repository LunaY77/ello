/** 运行上下文包装类型, 对齐 PydanticAI RunContext 的 deps 访问形态。 */
export interface RunContextLike<TDeps = unknown> {
  deps: TDeps;
}

/** 工具前置 hook: (ctx, toolArgs, metadata) -> toolArgs。 */
export type PreHookFunc<TDeps = unknown> = (
  ctx: RunContextLike<TDeps>,
  toolArgs: Record<string, unknown>,
  metadata: Record<string, unknown>,
) => Promise<Record<string, unknown>>;

/** 工具后置 hook: (ctx, result, metadata) -> result。 */
export type PostHookFunc<TDeps = unknown> = (
  ctx: RunContextLike<TDeps>,
  result: unknown,
  metadata: Record<string, unknown>,
) => Promise<unknown>;

/** 全局前置 hook: (ctx, toolName, toolArgs, metadata) -> toolArgs。 */
export type GlobalPreHookFunc<TDeps = unknown> = (
  ctx: RunContextLike<TDeps>,
  toolName: string,
  toolArgs: Record<string, unknown>,
  metadata: Record<string, unknown>,
) => Promise<Record<string, unknown>>;

/** 全局后置 hook: (ctx, toolName, result, metadata) -> result。 */
export type GlobalPostHookFunc<TDeps = unknown> = (
  ctx: RunContextLike<TDeps>,
  toolName: string,
  result: unknown,
  metadata: Record<string, unknown>,
) => Promise<unknown>;

/**
 * 全局 hook 容器, 对所有工具生效。
 */
export class GlobalHooks<TDeps = unknown> {
  readonly pre: GlobalPreHookFunc<TDeps> | null;
  readonly post: GlobalPostHookFunc<TDeps> | null;

  constructor(options: { pre?: GlobalPreHookFunc<TDeps> | null; post?: GlobalPostHookFunc<TDeps> | null } = {}) {
    this.pre = options.pre ?? null;
    this.post = options.post ?? null;
  }
}

/**
 * 工具级 hook 配置。
 *
 * Args:
 *   preHooks: 按工具名注册的前置 hook。
 *   postHooks: 按工具名注册的后置 hook。
 *   globalHooks: 全局 hook。
 */
export class ToolHooks<TDeps = unknown> {
  readonly preHooks: Record<string, PreHookFunc<TDeps>>;
  readonly postHooks: Record<string, PostHookFunc<TDeps>>;
  readonly globalHooks: GlobalHooks<TDeps>;

  constructor(options: {
    preHooks?: Record<string, PreHookFunc<TDeps>>;
    postHooks?: Record<string, PostHookFunc<TDeps>>;
    globalHooks?: GlobalHooks<TDeps>;
  } = {}) {
    this.preHooks = options.preHooks ?? {};
    this.postHooks = options.postHooks ?? {};
    this.globalHooks = options.globalHooks ?? new GlobalHooks<TDeps>();
  }

  /**
   * 执行前置 hooks。
   *
   * Args:
   *   ctx: 运行上下文。
   *   toolName: 工具名称。
   *   toolArgs: 工具参数。
   *
   * Returns:
   *   可能被修改的工具参数。
   */
  async runPre(
    ctx: RunContextLike<TDeps>,
    toolName: string,
    toolArgs: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    const metadata: Record<string, unknown> = { toolName };
    let args = toolArgs;

    if (this.globalHooks.pre !== null) {
      args = await this.globalHooks.pre(ctx, toolName, args, metadata);
    }
    if (this.preHooks[toolName] !== undefined) {
      args = await this.preHooks[toolName](ctx, args, metadata);
    }
    return args;
  }

  /**
   * 执行后置 hooks。
   *
   * Args:
   *   ctx: 运行上下文。
   *   toolName: 工具名称。
   *   result: 工具执行结果。
   *
   * Returns:
   *   可能被修改的结果。
   */
  async runPost(ctx: RunContextLike<TDeps>, toolName: string, result: unknown): Promise<unknown> {
    const metadata: Record<string, unknown> = { toolName };
    let current = result;

    if (this.postHooks[toolName] !== undefined) {
      current = await this.postHooks[toolName](ctx, current, metadata);
    }
    if (this.globalHooks.post !== null) {
      current = await this.globalHooks.post(ctx, toolName, current, metadata);
    }
    return current;
  }
}
