import { readFile } from 'node:fs/promises';
import path from 'node:path';

export async function loadProjectInstructions(cwd: string): Promise<string> {
  const files = ['AGENTS.md', path.join('.ello', 'instructions.md')];
  const parts: string[] = [];
  for (const file of files) {
    try {
      const content = await readFile(path.join(cwd, file), 'utf8');
      if (content.trim()) {
        parts.push(`# ${file}\n\n${content.trim()}`);
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        throw error;
      }
    }
  }
  return parts.join('\n\n');
}

export function buildCodingSystemPrompt(instructions: string): string {
  const projectInstructions = instructions.trim()
    ? `\n## Project Instructions\n\n${instructions.trim()}\n`
    : '';
  return `# System

You are ello, a coding agent running in a local workspace.

Use tools to inspect current files before changing code. Keep edits scoped to the user's request, preserve unrelated work, and report concrete verification results.
${projectInstructions}`;
}
