import { z } from 'zod';

import { BaseTool, type ToolArgs, type ToolRunContext } from '../base.js';

/** 默认读取行数。 */
export const DEFAULT_LINE_LIMIT = 300;

/** 默认单行最大长度。 */
export const DEFAULT_MAX_LINE_LENGTH = 2000;

/** read_file 工具输入 schema。 */
export const ReadFileArgsSchema = z.object({
  path: z.string(),
  lineOffset: z.number().int().nonnegative().nullable().optional(),
  lineLimit: z.number().int().positive().default(DEFAULT_LINE_LIMIT),
  maxLineLength: z.number().int().positive().default(DEFAULT_MAX_LINE_LENGTH),
});

/**
 * 读取文件内容, 支持分页。
 */
export class ReadFileTool extends BaseTool {
  static override toolName = 'read_file';
  static override description =
    'Read a text file from the filesystem. Supports lineOffset and lineLimit for paginated reading of large files.';
  static override inputSchema = ReadFileArgsSchema;

  /**
   * FileOperator 不存在时不可用。
   */
  override isAvailable(ctx: ToolRunContext): boolean {
    try {
      return ctx.deps.env.fileOperator !== null;
    } catch {
      return false;
    }
  }

  /**
   * 读取文件内容。
   */
  async call(
    ctx: ToolRunContext,
    args: ToolArgs,
  ): Promise<string | Record<string, unknown>> {
    const parsed = ReadFileArgsSchema.parse(args);
    const fileOperator = ctx.deps.env.fileOperator;
    if (fileOperator === null) {
      return 'Error: file_operator not available.';
    }

    let content: string;
    try {
      content = await fileOperator.readText(parsed.path);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (message.includes('ENOENT') || message.includes('no such file')) {
        return `Error: File not found: ${parsed.path}`;
      }
      return `Error: ${message}`;
    }

    const maxFileSize = ctx.deps.toolConfig.viewMaxTextFileSize;
    const contentBytes = Buffer.byteLength(content, 'utf8');
    if (contentBytes > maxFileSize) {
      return (
        `Error: File is too large (${formatSize(contentBytes)}). ` +
        `Maximum supported size is ${formatSize(maxFileSize)}. ` +
        'Use shell tools (e.g. `head`, `tail`) to read portions of this file.'
      );
    }

    const allLines = splitLinesKeepEnds(content);
    const totalLines = allLines.length;
    const start =
      parsed.lineOffset !== null && parsed.lineOffset !== undefined
        ? parsed.lineOffset
        : 0;
    const selected = allLines.slice(start, start + parsed.lineLimit);
    let truncatedLines = false;
    const processed = selected.map((line) => {
      if (line.length > parsed.maxLineLength) {
        truncatedLines = true;
        return `${line.slice(0, parsed.maxLineLength)}... (line truncated)\n`;
      }
      return line;
    });

    const resultText = processed.join('');
    const hasMore = start + parsed.lineLimit < totalLines;
    const needsMetadata = start > 0 || hasMore || truncatedLines;

    if (!needsMetadata) {
      return resultText;
    }

    return {
      content: resultText,
      total_lines: totalLines,
      start_line: start + 1,
      end_line: start + processed.length,
      has_more: hasMore,
    };
  }
}

function splitLinesKeepEnds(content: string): string[] {
  if (content.length === 0) {
    return [];
  }
  const matches = content.match(/[^\n]*\n|[^\n]+$/g);
  return matches ?? [];
}

function formatSize(sizeBytes: number): string {
  if (sizeBytes < 1024) {
    return `${sizeBytes} bytes`;
  }
  if (sizeBytes < 1024 * 1024) {
    return `${(sizeBytes / 1024).toFixed(1)} KB`;
  }
  return `${(sizeBytes / (1024 * 1024)).toFixed(2)} MB`;
}
