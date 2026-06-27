import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import {
  AgentContext,
  BaseTool,
  GlobalHooks,
  Instruction,
  LocalEnvironment,
  ToolHooks,
  Toolset,
  createAgent,
  tool,
  type ToolArgs,
  type ToolRunContext,
} from '../index.js';
import { collectRuntimeTools } from '../runtime/tool-execution.js';
import { collectDeferredRequests } from '../runtime/turn.js';

class EchoTool extends BaseTool {
  static override toolName = 'echo';
  static override description = 'Echo input back.';
  static override inputSchema = z.object({
    message: z.string().default('hello'),
  });

  async call(_ctx: ToolRunContext, args: ToolArgs): Promise<string> {
    return `echo: ${String(args.message)}`;
  }
}

class TaggedTool extends BaseTool {
  static override toolName = 'tagged';
  static override description = 'A tool with tags.';
  static override tags = new Set(['advanced']);

  async call(): Promise<string> {
    return 'tagged';
  }
}

class SupersededTool extends BaseTool {
  static override toolName = 'superseded';
  static override description = 'A tool superseded by advanced tag.';
  static override supersededByTags = new Set(['advanced']);

  async call(): Promise<string> {
    return 'superseded';
  }
}

class UnavailableTool extends BaseTool {
  static override toolName = 'unavailable';
  static override description = 'Never available.';

  override isAvailable(): boolean {
    return false;
  }

  async call(): Promise<string> {
    return 'should not be called';
  }
}

class InstructedTool extends BaseTool {
  static override toolName = 'instructed';
  static override description = 'Has instruction.';

  override async getInstruction(): Promise<string> {
    return 'Use this tool carefully.';
  }

  async call(): Promise<string> {
    return 'ok';
  }
}

class GroupedInstructionTool extends BaseTool {
  static override toolName = 'grouped';
  static override description = 'Has grouped instruction.';

  override async getInstruction(): Promise<Instruction> {
    return new Instruction('shared-group', 'Shared instruction content.');
  }

  async call(): Promise<string> {
    return 'ok';
  }
}

class GroupedInstructionTool2 extends BaseTool {
  static override toolName = 'grouped2';
  static override description = 'Second tool with same group.';

  override async getInstruction(): Promise<Instruction> {
    return new Instruction('shared-group', 'This should be deduplicated.');
  }

  async call(): Promise<string> {
    return 'ok';
  }
}

class ApprovalTool extends BaseTool {
  static override toolName = 'dangerous_action';
  static override description = 'A dangerous action requiring approval.';
  static override requiresApproval = true;

  async call(): Promise<string> {
    return 'executed';
  }
}

function makeCtx(): ToolRunContext {
  return {
    deps: new AgentContext({ env: new LocalEnvironment() }),
  };
}

describe('tool helper', () => {
  it('creates BaseTool subclass', () => {
    const GreetTool = tool(
      {
        name: 'greet',
        description: 'Say hello',
        inputSchema: z.object({ name: z.string() }),
      },
      async (_ctx, args) => `Hello, ${String(args.name)}!`,
    );

    const instance = new GreetTool();
    expect(instance).toBeInstanceOf(BaseTool);
    expect(instance.name).toBe('greet');
    expect(instance.description).toBe('Say hello');
  });

  it('keeps tags and options', () => {
    const ShellTool = tool(
      {
        name: 'shell',
        description: 'Execute command',
        tags: new Set(['exec']),
        requiresApproval: true,
        autoInherit: true,
      },
      async () => '',
    );

    expect(ShellTool.tags).toEqual(new Set(['exec']));
    expect(ShellTool.requiresApproval).toBe(true);
    expect(ShellTool.autoInherit).toBe(true);
  });

  it('rejects sync functions at definition time', () => {
    expect(() =>
      tool({ name: 'bad', description: 'fails' }, (() => 'x') as never),
    ).toThrow('async function');
  });

  it('can instantiate function tools', () => {
    const CalcTool = tool(
      { name: 'calc', description: 'Calculate' },
      async (_ctx, args) => String(args.expr ?? ''),
    );

    const instance = new CalcTool();

    expect(instance.name).toBe('calc');
    expect(instance.description).toBe('Calculate');
    expect(instance.supersededByTags).toEqual(new Set());
    expect(instance.autoInherit).toBe(false);
    expect(instance.requiresApproval).toBe(false);
  });
});

describe('Toolset', () => {
  it('registers tools and rejects duplicate names', () => {
    const ts = new Toolset({ tools: [EchoTool, TaggedTool] });

    expect(ts.toolNames).toEqual(['echo', 'tagged']);
    expect(() => new Toolset({ tools: [EchoTool, EchoTool] })).toThrow(
      'Duplicate tool name',
    );
  });

  it('returns available tools', async () => {
    const ts = new Toolset({ tools: [EchoTool, UnavailableTool] });

    await expect(ts.getTools(makeCtx())).resolves.toHaveProperty('echo');
    await expect(ts.getTools(makeCtx())).resolves.not.toHaveProperty(
      'unavailable',
    );
  });

  it('filters superseded tools', async () => {
    const withTag = new Toolset({ tools: [TaggedTool, SupersededTool] });
    const withoutTag = new Toolset({ tools: [EchoTool, SupersededTool] });

    await expect(withTag.getTools(makeCtx())).resolves.toHaveProperty('tagged');
    await expect(withTag.getTools(makeCtx())).resolves.not.toHaveProperty(
      'superseded',
    );
    await expect(withoutTag.getTools(makeCtx())).resolves.toHaveProperty(
      'superseded',
    );
  });

  it('collects and deduplicates instructions', async () => {
    const plain = new Toolset({ tools: [InstructedTool] });
    const grouped = new Toolset({
      tools: [GroupedInstructionTool, GroupedInstructionTool2],
    });

    const plainText = await plain.getInstructions(makeCtx());
    expect(plainText).toContain('Use this tool carefully.');
    expect(plainText).toContain('name="instructed"');

    const groupedText = await grouped.getInstructions(makeCtx());
    expect(groupedText).toContain('Shared instruction content.');
    expect(groupedText).not.toContain('This should be deduplicated.');
  });

  it('returns null when no instructions exist', async () => {
    const ts = new Toolset({ tools: [EchoTool] });

    await expect(ts.getInstructions(makeCtx())).resolves.toBeNull();
  });

  it('calls tools and reports missing tools', async () => {
    const ts = new Toolset({ tools: [EchoTool] });
    const tools = await ts.getTools(makeCtx());

    await expect(
      ts.callTool('echo', { message: 'world' }, makeCtx(), tools.echo),
    ).resolves.toBe('echo: world');
    await expect(
      ts.callTool('nonexistent', {}, makeCtx(), tools.echo),
    ).resolves.toContain('not found');
  });

  it('runs hooks around call', async () => {
    const ts = new Toolset({
      tools: [EchoTool],
      hooks: new ToolHooks({
        globalHooks: new GlobalHooks({
          pre: async (_ctx, _name, args) => ({ ...args, message: 'hooked' }),
          post: async (_ctx, name, result) => `${name}: ${String(result)}`,
        }),
      }),
    });
    const tools = await ts.getTools(makeCtx());

    await expect(
      ts.callTool('echo', { message: 'world' }, makeCtx(), tools.echo),
    ).resolves.toBe('echo: echo: hooked');
  });

  it('creates subsets and keeps auto inherit tools', () => {
    const AutoTool = tool(
      { name: 'auto', description: 'Auto', autoInherit: true },
      async () => 'auto',
    );
    const ts = new Toolset({ tools: [EchoTool, TaggedTool, AutoTool] });

    expect(ts.subset({ toolNames: ['echo'] }).toolNames).toEqual([
      'echo',
      'auto',
    ]);
    expect(ts.subset({ excludeTags: new Set(['advanced']) }).toolNames).toEqual(
      ['echo', 'auto'],
    );
  });

  it('tracks approval tools and createAgent core toolset', () => {
    const ts = new Toolset({ tools: [EchoTool, ApprovalTool] });
    const runtime = createAgent({ tools: [ApprovalTool] });

    expect(ts.hasApprovalTools).toBe(true);
    expect(runtime.coreToolset).not.toBeNull();
    expect(runtime.hasApprovalTools).toBe(true);
  });

  it('collectRuntimeTools bridges tools and records approval names', async () => {
    const approvalToolNames = new Set<string>();
    const approvalPredicates = new Map<string, (args: ToolArgs) => boolean>();
    const ts = new Toolset({ tools: [EchoTool, ApprovalTool] });
    const tools = await collectRuntimeTools({
      ctx: makeCtx().deps,
      toolsets: [ts],
      approvalToolNames,
      approvalPredicates,
    });

    expect(tools).toHaveProperty('echo');
    expect(tools).toHaveProperty('dangerous_action');
    expect(approvalToolNames).toEqual(new Set(['dangerous_action']));
    expect(approvalPredicates.size).toBe(0);
  });

  it('collectDeferredRequests supports argument-sensitive approval predicates', () => {
    const pending = collectDeferredRequests(
      [
        {
          toolCalls: [
            {
              toolCallId: 'call-safe',
              toolName: 'read_file',
              input: { path: 'src/index.ts' },
            },
            {
              toolCallId: 'call-risky',
              toolName: 'read_file',
              input: { path: '/tmp/secret.txt' },
            },
          ],
        },
      ],
      new Set(),
      new Map([
        [
          'read_file',
          (args) => typeof args.path === 'string' && args.path.startsWith('/tmp/'),
        ],
      ]),
    );

    expect(pending).toEqual({
      approvals: [
        {
          toolCallId: 'call-risky',
          toolName: 'read_file',
          input: { path: '/tmp/secret.txt' },
        },
      ],
      calls: [],
    });
  });
});
