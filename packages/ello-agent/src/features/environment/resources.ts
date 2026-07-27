/**
 * 环境 feature 管理 Agent 资源的注册、延迟构造、初始化和逆序释放。
 *
 * registry 与所属环境一一绑定，工厂只能在绑定后创建资源。
 */
import type {
  AgentEnvironment,
  AgentResource,
  AgentResourceFactory,
  AgentResourceRegistry,
} from '../agent/engine/contracts.js';

export class DefaultAgentResourceRegistry implements AgentResourceRegistry {
  private readonly resources = new Map<string, AgentResource>();
  private readonly factories = new Map<string, AgentResourceFactory>();
  private environment: AgentEnvironment | undefined;

  /**
   * 绑定资源所属环境。
   *
   * Args:
   * - `environment`: 工厂创建资源时接收的同一环境对象。
   *
   * Returns:
   * - 完成内部引用更新，不创建资源。
   */
  bind(environment: AgentEnvironment): void {
    this.environment = environment;
  }

  /**
   * 注册已构造资源。
   *
   * Args:
   * - `key`: 当前 registry 内唯一的资源标识。
   * - `resource`: 由 registry 负责后续 setup 和 close 的资源。
   *
   * Returns:
   * - 完成资源登记。
   */
  register(key: string, resource: AgentResource): void {
    if (this.resources.has(key) || this.factories.has(key)) {
      throw new Error(`Agent resource key is already registered: ${key}`);
    }
    this.resources.set(key, resource);
  }

  /**
   * 注册延迟资源工厂。
   *
   * Args:
   * - `key`: 当前 registry 内唯一的资源标识。
   * - `factory`: 首次读取时构造资源的函数。
   *
   * Returns:
   * - 完成工厂登记。
   */
  registerFactory(key: string, factory: AgentResourceFactory): void {
    if (this.resources.has(key) || this.factories.has(key)) {
      throw new Error(`Agent resource key is already registered: ${key}`);
    }
    this.factories.set(key, factory);
  }

  /**
   * 初始化全部已构造资源。
   *
   * Args:
   * - 无；资源来自当前 registry。
   *
   * Returns:
   * - Promise 在所有 setup 按注册顺序完成后 resolve。
   */
  async setupAll(): Promise<void> {
    for (const resource of this.resources.values()) {
      await resource.setup?.();
    }
  }

  /**
   * 读取已构造资源。
   *
   * Args:
   * - `key`: 要读取的资源标识。
   *
   * Returns:
   * - 返回资源；尚未构造或未注册时返回 `undefined`。
   */
  get(key: string): AgentResource | undefined {
    return this.resources.get(key);
  }

  /**
   * 读取或创建资源。
   *
   * Args:
   * - `key`: 要读取的资源标识。
   *
   * Returns:
   * - 返回已经 setup 的唯一资源实例。
   *
   * Throws:
   * - 当 key 未注册或 registry 尚未绑定环境时直接抛错。
   */
  async getOrCreate(key: string): Promise<AgentResource> {
    const existing = this.resources.get(key);
    if (existing !== undefined) return existing;
    const factory = this.factories.get(key);
    if (factory === undefined) {
      throw new Error(`No Agent resource registered for key: ${key}`);
    }
    const environment = this.environment;
    if (environment === undefined) {
      throw new Error(
        'Agent resource registry is not bound to an environment.',
      );
    }
    const resource = await factory(environment);
    await resource.setup?.();
    this.factories.delete(key);
    this.resources.set(key, resource);
    return resource;
  }

  /**
   * 列出全部资源标识。
   *
   * Args:
   * - 无；结果来自当前 registry。
   *
   * Returns:
   * - 返回已构造资源与工厂 key 的去重快照。
   */
  keys(): Array<string> {
    return [...new Set([...this.resources.keys(), ...this.factories.keys()])];
  }

  /**
   * 收集资源提供的 system context。
   *
   * Args:
   * - 无；只读取已经构造的资源。
   *
   * Returns:
   * - Promise resolve 为 `<resources>` 片段；没有内容时为 `null`。
   */
  async getContextInstructions(): Promise<string | null> {
    const sections: Array<string> = [];
    for (const [key, resource] of this.resources) {
      const instructions = await resource.getContextInstructions?.();
      if (typeof instructions === 'string' && instructions.length > 0) {
        sections.push(`<resource name="${key}">\n${instructions}\n</resource>`);
      }
    }
    return sections.length === 0
      ? null
      : `<resources>\n${sections.join('\n')}\n</resources>`;
  }

  /**
   * 逆序释放全部已构造资源并清空 registry。
   *
   * Args:
   * - 无；关闭顺序与资源注册顺序相反。
   *
   * Returns:
   * - Promise 在全部资源关闭后 resolve。
   */
  async closeAll(): Promise<void> {
    for (const resource of [...this.resources.values()].reverse()) {
      await resource.close?.();
    }
    this.resources.clear();
    this.factories.clear();
  }
}
