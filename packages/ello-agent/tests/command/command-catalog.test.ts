/** 验证 Command Catalog 到模型工具定义的动态映射。 */
import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import {
  cliInput,
  commandInput,
  createCommandRegistrySnapshot,
  createCommandRunRuntime as createRuntimeFromRegistry,
  defineCommand,
  defineCommandModule,
  structuredInput,
  type CommandDefinition,
} from '../../src/features/command/index.js';
import { createCommandRunInputSchema } from '../../src/features/command/schema.js';

function createCommandRunRuntime(options: {
  readonly commands: readonly CommandDefinition[];
  readonly search: {
    readonly resultLimit: number;
    readonly maxResultBytes: number;
  };
}) {
  return createRuntimeFromRegistry(
    createCommandRegistrySnapshot({
      modules: [
        defineCommandModule({ id: 'catalog-test', commands: options.commands }),
      ],
      search: options.search,
    }),
  );
}

function commandDefinition(name: string): CommandDefinition {
  if (['grep', 'glob', 'request_user_input'].includes(name)) {
    const input = z.object({ value: z.string().optional() }).strict();
    return defineCommand({
      name,
      summary: `${name} capability description`,
      aliases: [],
      risk: 'readonly',
      exposure: 'discoverable',
      invocation: structuredInput(commandInput(input)),
      execution: { kind: 'immediate', run: async () => undefined },
    });
  }
  if (name === 'read') {
    const input = z
      .object({
        filePath: z.string().describe('File path'),
        offset: z.number().int().optional().describe('Starting line'),
        limit: z.number().int().optional().describe('Maximum lines'),
      })
      .strict();
    return defineCommand({
      name,
      summary: `${name} capability description`,
      examples: [
        {
          description: 'Read a bounded file range',
          frame: { args: ['README.md', '--limit', '80'] },
        },
      ],
      aliases: [],
      risk: 'readonly',
      invocation: cliInput(commandInput(input), {
        positionals: [{ field: 'filePath', metavar: 'path' }],
        options: ['offset', 'limit'],
      }),
      execution: { kind: 'immediate', run: async () => undefined },
    });
  }
  const input = z.object({}).strict();
  return defineCommand({
    name,
    summary: `${name} capability description`,
    aliases: [],
    risk: 'readonly',
    invocation: cliInput(commandInput(input)),
    execution: { kind: 'immediate', run: async () => undefined },
  });
}

function runtimeFor(names: readonly string[]) {
  return createCommandRunRuntime({
    commands: names.map(commandDefinition),
    search: { resultLimit: 6, maxResultBytes: 24_000 },
  });
}

function commandNames(description: string): string[] {
  const line = description
    .split('\n')
    .find((value) => value.startsWith('Available commands: '));
  if (line === undefined) throw new Error('Missing available commands line.');
  return line
    .slice('Available commands: '.length, -1)
    .split(', ')
    .filter(Boolean);
}

describe('Command Catalog model surfacing', () => {
  it('adds schema descriptions and restricts command to the active catalog', () => {
    const schema = createCommandRunInputSchema(['read']);
    const jsonSchema = z.toJSONSchema(schema);

    expect(jsonSchema).toMatchObject({
      properties: {
        commands: {
          description: expect.any(String),
          items: {
            properties: {
              step: { description: expect.any(String) },
              command: {
                description: expect.any(String),
                enum: ['read'],
              },
              args: { description: expect.any(String) },
              body: { description: expect.any(String) },
              input: { description: expect.any(String) },
              onFailure: { description: expect.any(String) },
            },
          },
        },
      },
    });
    expect(
      schema.safeParse({
        commands: [{ step: 1, command: 'bash', body: 'pwd' }],
      }).success,
    ).toBe(false);
    expect(JSON.stringify(jsonSchema)).not.toContain('readOnly');
  });

  it('surfaces a complete primary catalog in the model tool description', () => {
    const runtime = runtimeFor([
      'read',
      'write',
      'apply_patch',
      'bash',
      'grep',
      'glob',
      'search',
      'request_user_input',
    ]);
    const description = runtime.modelTool.description;

    expect(commandNames(description)).toEqual([
      'apply_patch',
      'bash',
      'command_invoke',
      'command_search',
      'read',
      'search',
      'write',
    ]);
    expect(description).toContain('Command details:');
    expect(description).toContain('- read: read capability description');
    expect(description).toContain(
      'Usage: read <path> [--offset <integer>] [--limit <integer>]',
    );
    expect(description).toContain('- search: search capability description');
  });

  it('renders one runnable Frame example per argument channel', () => {
    const runtime = runtimeFor(['read', 'write', 'bash', 'search']);
    const description = runtime.modelTool.description;
    const batchLine = description
      .split('\n')
      .find((line) => line.startsWith('  Batch: '));
    const objectLine = description
      .split('\n')
      .find((line) => line.startsWith('  Object arguments: '));
    if (batchLine === undefined || objectLine === undefined) {
      throw new Error(`Missing Frame examples in:\n${description}`);
    }

    expect(batchLine).toBe(
      '  Batch: {"commands":[{"step":1,"command":"read","args":["README.md","--limit","80"]}]}',
    );
    expect(objectLine).toBe(
      '  Object arguments: {"step":1,"command":"command_invoke","input":{"name":"<command_search result>","arguments":{}}}',
    );
    expect(
      runtime.modelTool.input.safeParse(
        JSON.parse(batchLine.slice('  Batch: '.length)),
      ).success,
    ).toBe(true);
    expect(
      runtime.modelTool.input.safeParse({
        commands: [JSON.parse(objectLine.slice('  Object arguments: '.length))],
      }).success,
    ).toBe(true);
    expect(description).not.toContain('Example (');
  });

  it('keeps the built-in discovery catalog non-empty without feature Commands', () => {
    const runtime = runtimeFor([]);

    expect(commandNames(runtime.modelTool.description)).toEqual([
      'command_invoke',
      'command_search',
    ]);
    expect(() => z.toJSONSchema(runtime.modelTool.input)).not.toThrow();
  });

  it('only surfaces commands enabled for restricted and internal agents', () => {
    const explore = runtimeFor(['read', 'grep', 'glob', 'search', 'bash']);
    const internal = runtimeFor(['internal_complete']);

    expect(commandNames(explore.modelTool.description)).toEqual([
      'bash',
      'command_invoke',
      'command_search',
      'read',
      'search',
    ]);
    expect(explore.modelTool.description).not.toContain('- write:');
    expect(explore.modelTool.description).not.toContain('- apply_patch:');
    expect(commandNames(internal.modelTool.description)).toEqual([
      'command_invoke',
      'command_search',
      'internal_complete',
    ]);
    expect(internal.modelTool.description).not.toContain('- read:');
  });

  it('derives the command enum, prompt, and revision from each definition set', () => {
    const before = runtimeFor(['read']);
    const after = runtimeFor(['read', 'write']);
    const beforeSchema = z.toJSONSchema(before.modelTool.input);
    const afterSchema = z.toJSONSchema(after.modelTool.input);

    expect(beforeSchema).toMatchObject({
      properties: {
        commands: {
          items: {
            properties: {
              command: {
                enum: ['command_invoke', 'command_search', 'read'],
              },
            },
          },
        },
      },
    });
    expect(afterSchema).toMatchObject({
      properties: {
        commands: {
          items: {
            properties: {
              command: {
                enum: ['command_invoke', 'command_search', 'read', 'write'],
              },
            },
          },
        },
      },
    });
    expect(before.modelTool.description).not.toContain('- write:');
    expect(after.modelTool.description).toContain(
      '- write: write capability description',
    );
    expect(after.catalogRevision).not.toBe(before.catalogRevision);
  });

  it('rejects missing CLI field descriptions at registry construction', () => {
    const input = z.object({ path: z.string() }).strict();
    const command = defineCommand({
      name: 'undocumented',
      summary: 'An invalid undocumented CLI Command.',
      aliases: [],
      risk: 'readonly',
      invocation: cliInput(commandInput(input), {
        positionals: [{ field: 'path' }],
      }),
      execution: { kind: 'immediate', run: async () => undefined },
    });

    expect(() =>
      createCommandRunRuntime({
        commands: [command],
        search: { resultLimit: 6, maxResultBytes: 24_000 },
      }),
    ).toThrow(
      "CLI Command 'undocumented' has fields without descriptions: path.",
    );
  });

  it('rejects examples that fail the real invocation parser', () => {
    const input = z
      .object({ command: z.string().describe('Shell program') })
      .strict();
    const command = defineCommand({
      name: 'invalid_example',
      summary: 'A Command with an invalid example.',
      examples: [
        {
          description: 'Incorrectly put the program in args',
          frame: { args: ['date'] },
        },
      ],
      aliases: [],
      risk: 'external',
      invocation: cliInput(commandInput(input), { body: 'command' }),
      execution: { kind: 'immediate', run: async () => undefined },
    });

    expect(() =>
      createCommandRunRuntime({
        commands: [command],
        search: { resultLimit: 6, maxResultBytes: 24_000 },
      }),
    ).toThrow(
      "Command 'invalid_example' example 1 is invalid: unexpected positional argument 'date' for 'invalid_example'; usage: invalid_example with body; options shown as --name in Usage must be separate flag/value entries in args",
    );
  });

  it('includes examples in catalog revision changes', () => {
    const input = z.object({}).strict();
    const withoutExample = defineCommand({
      name: 'revision_example',
      summary: 'Revision example Command.',
      aliases: [],
      risk: 'readonly',
      invocation: cliInput(commandInput(input)),
      execution: { kind: 'immediate', run: async () => undefined },
    });
    const withExample = defineCommand({
      name: 'revision_example',
      summary: 'Revision example Command.',
      examples: [{ description: 'Run without arguments', frame: {} }],
      aliases: [],
      risk: 'readonly',
      invocation: cliInput(commandInput(input)),
      execution: { kind: 'immediate', run: async () => undefined },
    });

    const before = createCommandRunRuntime({
      commands: [withoutExample],
      search: { resultLimit: 6, maxResultBytes: 24_000 },
    });
    const after = createCommandRunRuntime({
      commands: [withExample],
      search: { resultLimit: 6, maxResultBytes: 24_000 },
    });

    expect(after.catalogRevision).not.toBe(before.catalogRevision);
  });

  it('rejects aliases that collide with another command search term', () => {
    const first = defineCommand({
      name: 'first_command',
      summary: 'First discoverable Command.',
      aliases: ['shared'],
      risk: 'readonly',
      exposure: 'discoverable',
      invocation: structuredInput(commandInput(z.object({}).strict())),
      execution: { kind: 'immediate', run: async () => undefined },
    });
    const second = defineCommand({
      name: 'second_command',
      summary: 'Second discoverable Command.',
      aliases: ['SHARED'],
      risk: 'readonly',
      exposure: 'discoverable',
      invocation: structuredInput(commandInput(z.object({}).strict())),
      execution: { kind: 'immediate', run: async () => undefined },
    });

    expect(() =>
      createCommandRunRuntime({
        commands: [first, second],
        search: { resultLimit: 6, maxResultBytes: 24_000 },
      }),
    ).toThrow(
      "Command search term 'SHARED' collides between 'first_command' and 'second_command'.",
    );
  });

  it('sorts modules deterministically and rejects duplicate module ids', () => {
    const alpha = defineCommandModule({
      id: 'alpha',
      commands: [commandDefinition('read')],
    });
    const beta = defineCommandModule({
      id: 'beta',
      commands: [commandDefinition('write')],
    });
    const first = createRuntimeFromRegistry(
      createCommandRegistrySnapshot({
        modules: [beta, alpha],
        search: { resultLimit: 6, maxResultBytes: 24_000 },
      }),
    );
    const second = createRuntimeFromRegistry(
      createCommandRegistrySnapshot({
        modules: [alpha, beta],
        search: { resultLimit: 6, maxResultBytes: 24_000 },
      }),
    );

    expect(first.catalogRevision).toBe(second.catalogRevision);
    expect(first.modelTool.description).toBe(second.modelTool.description);
    expect(() =>
      createCommandRegistrySnapshot({
        modules: [alpha, defineCommandModule({ id: 'alpha', commands: [] })],
        search: { resultLimit: 6, maxResultBytes: 24_000 },
      }),
    ).toThrow("Duplicate Command module 'alpha'.");
  });
});
