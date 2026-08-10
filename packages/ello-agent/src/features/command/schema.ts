/** Command Frame 的严格 wire schema。 */
import { z } from 'zod';

import type { CommandRunInput } from './types.js';

const JsonValueSchema: z.ZodType<unknown> = z.lazy(() =>
  z.union([
    z.string(),
    z.number().finite(),
    z.boolean(),
    z.null(),
    z.array(JsonValueSchema),
    z.record(z.string(), JsonValueSchema),
  ]),
);

const COMMAND_NAME_DESCRIPTION =
  'Exact Command name from the command list in this tool description.';

export const CommandFrameSchema = createCommandFrameSchema(
  z.string().trim().min(1).describe(COMMAND_NAME_DESCRIPTION),
);

export const CommandRunInputSchema = createCommandRunSchema(CommandFrameSchema);

/** 创建按当前 Command Catalog 收紧 command enum 的输入 schema。 */
export function createCommandRunInputSchema(
  commandNames: readonly string[],
): z.ZodType<CommandRunInput> {
  const firstName = commandNames[0];
  if (firstName === undefined) {
    throw new Error('Command Catalog cannot be empty.');
  }
  const commandEnum = z
    .enum([firstName, ...commandNames.slice(1)])
    .describe(COMMAND_NAME_DESCRIPTION);
  return createCommandRunSchema(createCommandFrameSchema(commandEnum));
}

function createCommandFrameSchema(command: z.ZodType<string>) {
  return z
    .object({
      step: z
        .number()
        .int()
        .positive()
        .describe(
          'Dependency group. Commands with the same step are independent and are all attempted; a higher step executes after every lower step according to the failure policy. Steps must be non-decreasing across the batch.',
        ),
      command,
      args: z
        .array(z.string())
        .max(128)
        .optional()
        .describe(
          'Separated arguments without shell quoting, for Commands whose Usage line declares positionals or options. Bare <name> values are positional; each --name <value> option needs a separate flag entry and value entry.',
        ),
      body: z
        .string()
        .max(256 * 1024)
        .optional()
        .describe(
          'The single large text argument, for Commands whose Usage line ends with "with body".',
        ),
      input: z
        .record(z.string(), JsonValueSchema)
        .optional()
        .describe(
          'Object arguments, for Commands whose Usage line reads "with input". Never combined with args or body.',
        ),
      onFailure: z
        .enum(['stop', 'continue', 'diagnose'])
        .optional()
        .describe(
          'stop (default) blocks later steps once this Command fails; continue records the failure and keeps later steps runnable; diagnose runs this Command after an earlier failure and is honoured only while the Command is read-only, concurrency-safe, non-destructive, and not deferred. Denial and interruption are never overridden.',
        ),
    })
    .strict()
    .describe(
      'One Command Frame. Allowed keys are step, command, args, body, input, and onFailure; every Command-specific option belongs in args, body, or input as its Usage line declares.',
    );
}

function createCommandRunSchema(
  frameSchema: ReturnType<typeof createCommandFrameSchema>,
): z.ZodType<CommandRunInput> {
  return z
    .object({
      commands: z
        .array(frameSchema)
        .min(1)
        .max(32)
        .describe('Command Frames executed as one Command Run.'),
    })
    .strict()
    .superRefine((input, context) => {
      let previous = 0;
      input.commands.forEach((frame, index) => {
        if (frame.step < previous) {
          context.addIssue({
            code: 'custom',
            path: ['commands', index, 'step'],
            message: `step must be non-decreasing; received ${frame.step} after ${previous}`,
          });
        }
        previous = frame.step;
      });
      const bytes = Buffer.byteLength(JSON.stringify(input));
      if (bytes > 1024 * 1024) {
        context.addIssue({
          code: 'custom',
          path: ['commands'],
          message: 'serialized command_run input exceeds 1 MiB',
        });
      }
    }) as z.ZodType<CommandRunInput>;
}
