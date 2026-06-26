import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import type { ModelMessage } from 'ai';
import { describe, expect, it, vi } from 'vitest';

import {
  AgentContext,
  BaseTool,
  LocalEnvironment,
  Toolset,
  buildSubagentAgent,
  createDelegateTool,
  executeSubagent,
  loadSubagentFromFile,
  loadSubagentsFromDir,
  parseSubagentMarkdown,
  type SubagentConfig,
  type SubagentRunResult,
  type SubagentRunner,
  type ToolArgs,
  type ToolRunContext,
} from '../index.js';

const VALID_MARKDOWN = `---
name: explorer
description: Explore the codebase
instruction: Use for exploration tasks
tools:
  - read_file
  - list_dir
model: inherit
---

You are an exploration specialist.

## Instructions

Explore things.
`;

const MINIMAL_MARKDOWN = `---
name: minimal
description: A minimal subagent
---

Just a prompt.
`;

class DummyTool extends BaseTool {
  static override toolName = 'dummy';
  static override description = 'A dummy tool for testing';

  async call(_ctx: ToolRunContext, _args: ToolArgs): Promise<string> {
    return 'dummy result';
  }
}

class DelegationTaggedTool extends BaseTool {
  static override toolName = 'delegate_like';
  static override description = 'A tool with delegation tag';
  static override tags = new Set(['delegation']);

  async call(): Promise<string> {
    return 'should not be inherited';
  }
}

function makeConfig(
  name = 'test-agent',
  tools: string[] | null = null,
): SubagentConfig {
  return {
    name,
    description: `Test subagent ${name}`,
    instruction: `Use ${name} for testing`,
    systemPrompt: `You are ${name}.`,
    tools,
    optionalTools: null,
    model: null,
    modelSettings: null,
  };
}

function ctx(): { deps: AgentContext } {
  return {
    deps: new AgentContext({ env: new LocalEnvironment() }),
  };
}

function runner(output: string, messages: ModelMessage[] = []): SubagentRunner {
  return {
    name: 'worker',
    config: makeConfig('worker'),
    toolset: new Toolset({ tools: [] }),
    run: vi.fn(
      async (): Promise<SubagentRunResult> => ({
        output,
        allMessages: () => messages,
      }),
    ),
  };
}

describe('parseSubagentMarkdown', () => {
  it('parses full config', () => {
    const config = parseSubagentMarkdown(VALID_MARKDOWN);

    expect(config.name).toBe('explorer');
    expect(config.description).toBe('Explore the codebase');
    expect(config.instruction).toBe('Use for exploration tasks');
    expect(config.tools).toEqual(['read_file', 'list_dir']);
    expect(config.model).toBe('inherit');
    expect(config.systemPrompt).toContain('exploration specialist');
  });

  it('parses minimal config', () => {
    const config = parseSubagentMarkdown(MINIMAL_MARKDOWN);

    expect(config.name).toBe('minimal');
    expect(config.instruction).toBeNull();
    expect(config.tools).toBeNull();
    expect(config.model).toBeNull();
    expect(config.systemPrompt).toBe('Just a prompt.');
  });

  it('parses comma separated tools', () => {
    const config = parseSubagentMarkdown(`---
name: test
description: test
tools: read_file, write_file
---

Prompt.
`);

    expect(config.tools).toEqual(['read_file', 'write_file']);
  });

  it('throws on missing required fields or frontmatter', () => {
    expect(() => parseSubagentMarkdown('no frontmatter here')).toThrow(
      'frontmatter',
    );
    expect(() =>
      parseSubagentMarkdown(`---
description: no name
---

Prompt.
`),
    ).toThrow('name');
    expect(() =>
      parseSubagentMarkdown(`---
name: test
---

Prompt.
`),
    ).toThrow('description');
  });

  it('throws on invalid YAML-like frontmatter', () => {
    expect(() =>
      parseSubagentMarkdown(`---
name [broken]
---

Prompt.
`),
    ).toThrow('YAML');
  });
});

describe('load subagents', () => {
  it('loads from file and directory', async ({ task }) => {
    const dir = join('/tmp', `ello-ts-subagents-${task.id}`);
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, 'a.md'), VALID_MARKDOWN, 'utf8');
    await writeFile(join(dir, 'b.md'), MINIMAL_MARKDOWN, 'utf8');
    await writeFile(join(dir, 'not-md.txt'), 'ignored', 'utf8');

    await expect(
      loadSubagentFromFile(join(dir, 'a.md')),
    ).resolves.toMatchObject({
      name: 'explorer',
    });
    const configs = await loadSubagentsFromDir(dir);
    expect(Object.keys(configs).sort()).toEqual(['explorer', 'minimal']);
  });

  it('skips invalid files', async ({ task }) => {
    const dir = join('/tmp', `ello-ts-subagents-invalid-${task.id}`);
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, 'valid.md'), VALID_MARKDOWN, 'utf8');
    await writeFile(join(dir, 'invalid.md'), 'no frontmatter', 'utf8');

    const configs = await loadSubagentsFromDir(dir);

    expect(Object.keys(configs)).toEqual(['explorer']);
  });
});

describe('buildSubagentAgent', () => {
  it('builds child toolset excluding delegation tagged tools', () => {
    const parent = new Toolset({ tools: [DummyTool, DelegationTaggedTool] });
    const agent = buildSubagentAgent(makeConfig('worker'), parent);

    expect(agent.name).toBe('worker');
    expect(agent.toolset.toolNames).toContain('dummy');
    expect(agent.toolset.toolNames).not.toContain('delegate_like');
  });

  it('respects explicit tool subset', () => {
    const parent = new Toolset({ tools: [DummyTool, DelegationTaggedTool] });
    const agent = buildSubagentAgent(makeConfig('worker', ['dummy']), parent);

    expect(agent.toolset.toolNames).toEqual(['dummy']);
  });
});

describe('createDelegateTool', () => {
  it('rejects empty configs', () => {
    expect(() =>
      createDelegateTool([], new Toolset({ tools: [DummyTool] })),
    ).toThrow('At least one');
  });

  it('returns BaseTool subclass with delegation tag', () => {
    const toolClass = createDelegateTool(
      [makeConfig()],
      new Toolset({ tools: [DummyTool] }),
    );

    expect(toolClass.prototype).toBeInstanceOf(BaseTool);
    expect(toolClass.toolName).toBe('delegate');
    expect(toolClass.tags?.has('delegation')).toBe(true);
  });

  it('supports custom name', () => {
    const toolClass = createDelegateTool(
      [makeConfig()],
      new Toolset({ tools: [DummyTool] }),
      { name: 'dispatch' },
    );

    expect(toolClass.toolName).toBe('dispatch');
  });

  it('returns dynamic instruction listing subagents', async () => {
    const toolClass = createDelegateTool(
      [makeConfig('worker')],
      new Toolset({ tools: [DummyTool] }),
    );
    const instruction = await new toolClass().getInstruction(ctx());

    expect(instruction?.group).toBe('delegation');
    expect(instruction?.content).toContain('worker');
  });

  it('returns error for unknown subagent', async () => {
    const toolClass = createDelegateTool(
      [makeConfig('worker')],
      new Toolset({ tools: [DummyTool] }),
    );
    const result = await new toolClass().call(ctx(), {
      subagentName: 'missing',
      prompt: 'do something',
    });

    expect(result).toContain("Error: Unknown subagent 'missing'");
    expect(result).toContain('worker');
  });
});

describe('executeSubagent', () => {
  it('emits events and stores history', async () => {
    const agentContext = ctx().deps;
    const entry = {
      config: makeConfig('worker'),
      agent: runner('done', [{ role: 'assistant', content: 'done' }]),
    };

    const result = await executeSubagent(
      entry,
      { deps: agentContext },
      'test',
      null,
    );

    expect(result).toContain('<response>done</response>');
    expect(result).toContain('<id>');
    expect(agentContext.events).toHaveLength(2);
    expect(agentContext.subagentHistory.size).toBe(1);
  });

  it('resumes with agent id and previous history', async () => {
    const agentContext = ctx().deps;
    const previous = [{ role: 'user', content: 'prev' }] as ModelMessage[];
    const next = [{ role: 'assistant', content: 'resumed' }] as ModelMessage[];
    agentContext.subagentHistory.set('worker-abcd', previous);
    const testRunner = runner('resumed', next);
    const entry = { config: makeConfig('worker'), agent: testRunner };

    const result = await executeSubagent(
      entry,
      { deps: agentContext },
      'continue',
      'worker-abcd',
    );

    expect(result).toContain('<id>worker-abcd</id>');
    expect(testRunner.run).toHaveBeenCalledWith('continue', {
      deps: expect.any(AgentContext),
      messageHistory: previous,
    });
    expect(agentContext.subagentHistory.get('worker-abcd')).toEqual(next);
  });

  it('returns error string and emits failed completion on error', async () => {
    const agentContext = ctx().deps;
    const failingRunner: SubagentRunner = {
      name: 'worker',
      config: makeConfig('worker'),
      toolset: new Toolset({ tools: [] }),
      run: vi.fn(async () => {
        throw new Error('model exploded');
      }),
    };

    const result = await executeSubagent(
      { config: makeConfig('worker'), agent: failingRunner },
      { deps: agentContext },
      'fail',
      null,
    );

    expect(result).toContain('model exploded');
    expect(agentContext.events).toHaveLength(2);
    expect(agentContext.events[1]).toMatchObject({
      success: false,
      error: 'model exploded',
    });
  });
});
