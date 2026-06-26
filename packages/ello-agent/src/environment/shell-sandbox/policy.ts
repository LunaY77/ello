/** 命令策略动作。 */
export const CommandAction = {
  allow: 'allow',
  deny: 'deny',
  requireApproval: 'require_approval',
} as const;

/** 命令策略动作字符串类型。 */
export type CommandAction = (typeof CommandAction)[keyof typeof CommandAction];

/** 单条策略规则构造参数。 */
export interface ShellPolicyRuleOptions {
  pattern: string | RegExp;
  action: CommandAction;
  reason?: string;
}

/**
 * 单条策略规则。
 *
 * Args:
 *   pattern: 正则表达式模式, 匹配命令字符串。
 *   action: 匹配时的动作。
 *   reason: 规则说明。
 */
export class ShellPolicyRule {
  readonly pattern: RegExp;
  readonly action: CommandAction;
  readonly reason: string;

  constructor(options: ShellPolicyRuleOptions) {
    this.pattern =
      typeof options.pattern === 'string'
        ? new RegExp(options.pattern)
        : options.pattern;
    this.action = options.action;
    this.reason = options.reason ?? '';
  }

  /** 检查命令是否匹配此规则。 */
  matches(command: string): boolean {
    this.pattern.lastIndex = 0;
    return this.pattern.test(command);
  }
}

/** ShellPolicy 构造参数。 */
export interface ShellPolicyOptions {
  rules?: ShellPolicyRule[];
  defaultAction?: CommandAction;
}

/**
 * Shell 策略: 有序规则列表, 首个匹配生效。
 *
 * Args:
 *   rules: 策略规则列表, 按顺序匹配。
 *   defaultAction: 无规则匹配时的默认动作。
 */
export class ShellPolicy {
  readonly rules: ShellPolicyRule[];
  readonly defaultAction: CommandAction;

  constructor(options: ShellPolicyOptions = {}) {
    this.rules = options.rules ?? [];
    this.defaultAction = options.defaultAction ?? CommandAction.allow;
  }

  /**
   * 评估命令应执行的动作。
   *
   * Returns:
   *   [动作, 原因] 元组。
   */
  evaluate(command: string): [CommandAction, string] {
    for (const rule of this.rules) {
      if (rule.matches(command)) {
        return [rule.action, rule.reason];
      }
    }
    return [this.defaultAction, ''];
  }
}

/** 创建默认安全策略。 */
export function createDefaultPolicy(): ShellPolicy {
  return new ShellPolicy({
    rules: [
      new ShellPolicyRule({
        pattern: String.raw`\brm\s+-rf\s+/\s*$`,
        action: CommandAction.deny,
        reason: 'Dangerous: recursive delete of root',
      }),
      new ShellPolicyRule({
        pattern: String.raw`\b(shutdown|reboot|halt|poweroff)\b`,
        action: CommandAction.deny,
        reason: 'System power commands not allowed',
      }),
      new ShellPolicyRule({
        pattern: String.raw`\b(curl|wget)\b.*\|\s*(bash|sh)\b`,
        action: CommandAction.deny,
        reason: 'Piping downloads to shell not allowed',
      }),
    ],
    defaultAction: CommandAction.allow,
  });
}
