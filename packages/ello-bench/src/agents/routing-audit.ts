import path from 'node:path';

import {
  containerShellFlag,
  type ContainerShellMode,
} from '../container-shell.js';
import {
  ToolAuditSchema,
  type NormalizedToolCall,
  type ToolAudit,
  type ToolViolation,
} from '../contracts.js';

export function auditExternalTools(options: {
  readonly tools: readonly NormalizedToolCall[];
  readonly parserCoverage: 'complete' | 'incomplete';
  readonly workspace: string;
  readonly containerName: string;
  readonly containerWorkspace: '/app';
  readonly shellMode: ContainerShellMode;
}): ToolAudit {
  const violations: ToolViolation[] = [];
  let shellCalls = 0;
  let routedShellCalls = 0;
  let fileCalls = 0;
  if (options.parserCoverage === 'incomplete') {
    violations.push({
      toolCallId: 'parser',
      kind: 'parser_incomplete',
      detail: 'The adapter could not prove complete tool event coverage.',
    });
  }
  for (const tool of options.tools) {
    if (isNetworkTool(tool.name)) {
      violations.push({
        toolCallId: tool.id,
        kind: 'network_tool',
        detail: `Network-capable tool is forbidden: ${tool.name}.`,
      });
    }
    if (tool.category === 'shell') {
      shellCalls += 1;
      const command = tool.command;
      if (command === null) {
        violations.push({
          toolCallId: tool.id,
          kind: 'parser_incomplete',
          detail: `Shell tool has no command: ${tool.name}.`,
        });
        continue;
      }
      const routing = inspectShellRouting(
        command,
        options.containerName,
        options.containerWorkspace,
        options.shellMode,
      );
      if (routing === 'passed') {
        routedShellCalls += 1;
      } else {
        violations.push({
          toolCallId: tool.id,
          kind: routing,
          detail: `Shell command is outside the assigned task container: ${command}.`,
        });
      }
    }
    if (
      tool.category === 'read' ||
      tool.category === 'search' ||
      tool.category === 'edit'
    ) {
      fileCalls += 1;
      for (const filePath of tool.paths) {
        if (!isInsideWorkspace(options.workspace, filePath)) {
          violations.push({
            toolCallId: tool.id,
            kind: 'path_escape',
            detail: `File tool path escapes the task workspace: ${filePath}.`,
          });
        }
      }
    }
    if (tool.category === 'other' && tool.mutating) {
      violations.push({
        toolCallId: tool.id,
        kind: 'unknown_mutating_tool',
        detail: `Unknown mutating tool is not comparable: ${tool.name}.`,
      });
    }
  }
  return ToolAuditSchema.parse({
    schema: 'ello.benchmark.tool-audit.v1',
    status:
      options.parserCoverage === 'complete' && violations.length === 0
        ? 'passed'
        : 'failed',
    parserCoverage: options.parserCoverage,
    observedToolCalls: options.tools.length,
    shellCalls,
    routedShellCalls,
    fileCalls,
    violations,
  });
}

export function auditElloTools(
  tools: readonly NormalizedToolCall[],
): ToolAudit {
  return ToolAuditSchema.parse({
    schema: 'ello.benchmark.tool-audit.v1',
    status: 'passed',
    parserCoverage: 'complete',
    observedToolCalls: tools.length,
    shellCalls: tools.filter((tool) => tool.category === 'shell').length,
    routedShellCalls: tools.filter((tool) => tool.category === 'shell').length,
    fileCalls: tools.filter((tool) =>
      ['read', 'search', 'edit'].includes(tool.category),
    ).length,
    violations: [],
  });
}

function inspectShellRouting(
  command: string,
  containerName: string,
  containerWorkspace: '/app',
  shellMode: ContainerShellMode,
): 'passed' | 'host_shell' | 'shell_workdir' {
  const unwrapped = unwrapShell(command.trim());
  if (!/^docker\s+exec(?:\s|$)/u.test(unwrapped)) return 'host_shell';
  const expected = `docker exec -w ${containerWorkspace} ${containerName} bash ${containerShellFlag(shellMode)} `;
  return unwrapped.startsWith(expected) ? 'passed' : 'shell_workdir';
}

function unwrapShell(command: string): string {
  const match =
    /^(?:\/usr\/bin\/env\s+)?(?:\/bin\/)?(?:bash|zsh)\s+-lc\s+([\s\S]+)$/u.exec(
      command,
    );
  if (match === null) return command;
  const nested = match[1];
  if (nested === undefined) return command;
  if (
    (nested.startsWith("'") && nested.endsWith("'")) ||
    (nested.startsWith('"') && nested.endsWith('"'))
  ) {
    return nested.slice(1, -1);
  }
  return nested;
}

function isInsideWorkspace(workspace: string, filePath: string): boolean {
  const resolved = path.isAbsolute(filePath)
    ? path.resolve(filePath)
    : path.resolve(workspace, filePath);
  const relative = path.relative(path.resolve(workspace), resolved);
  return (
    relative === '' ||
    (!relative.startsWith(`..${path.sep}`) &&
      relative !== '..' &&
      !path.isAbsolute(relative))
  );
}

function isNetworkTool(name: string): boolean {
  return /(?:web[_-]?(?:search|fetch)|browser|http|url|mcp|chrome)/iu.test(
    name,
  );
}
