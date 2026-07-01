import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { createAgentRegistry, type AgentRegistry } from '../agents/index.js';
import { loadCodingAgentConfig } from '../config/index.js';

async function makeRegistry(cwd?: string): Promise<AgentRegistry> {
  const config = await loadCodingAgentConfig({
    cwd: cwd ?? mkdtempSync(path.join(tmpdir(), 'ello-agents-')),
  });
  return createAgentRegistry(config);
}

describe('AgentRegistry', () => {
  it('includes builtin agents', async () => {
    const registry = await makeRegistry();
    expect(registry.get('build').mode).toBe('primary');
    expect(registry.get('plan').mode).toBe('primary');
    expect(registry.get('explore').mode).toBe('subagent');
    expect(registry.get('explore').source).toBe('bundled');
    expect(registry.get('general').mode).toBe('subagent');
    expect(registry.get('general').source).toBe('bundled');
    expect(registry.get('title').mode).toBe('internal');
    expect(registry.get('compact').mode).toBe('internal');
    expect(registry.get('summary').mode).toBe('internal');
  });

  it('throws on unknown agent', async () => {
    const registry = await makeRegistry();
    expect(() => registry.get('nonexistent')).toThrow('Unknown agent');
  });

  it('selectablePrimaries returns only primary/all non-hidden', async () => {
    const registry = await makeRegistry();
    const primaries = registry.selectablePrimaries();
    expect(primaries.some((d) => d.name === 'build')).toBe(true);
    expect(primaries.some((d) => d.name === 'plan')).toBe(true);
    expect(primaries.some((d) => d.name === 'compact')).toBe(false);
    expect(primaries.some((d) => d.name === 'explore')).toBe(false);
  });

  it('delegatable returns only subagent/all non-hidden', async () => {
    const registry = await makeRegistry();
    const delegatable = registry.delegatable();
    expect(delegatable.some((d) => d.name === 'explore')).toBe(true);
    expect(delegatable.some((d) => d.name === 'general')).toBe(true);
    expect(delegatable.some((d) => d.name === 'build')).toBe(false);
    expect(delegatable.some((d) => d.name === 'compact')).toBe(false);
  });

  it('loads markdown agents from project .ello/agents/', async () => {
    const cwd = mkdtempSync(path.join(tmpdir(), 'ello-agents-md-'));
    const agentsDir = path.join(cwd, '.ello', 'agents');
    mkdirSync(agentsDir, { recursive: true });
    writeFileSync(
      path.join(agentsDir, 'custom.md'),
      `---
description: Custom test agent
mode: subagent
role: small
tools:
  - read
  - grep
---

You are a custom test agent.
`,
    );
    const registry = await makeRegistry(cwd);
    const custom = registry.get('custom');
    expect(custom.mode).toBe('subagent');
    expect(custom.role).toBe('small');
    expect(custom.tools).toEqual(['read', 'grep']);
    expect(custom.prompt).toBe('You are a custom test agent.');
    expect(custom.source).toBe('project');
  });

  it('project markdown overrides builtin with same name', async () => {
    const cwd = mkdtempSync(path.join(tmpdir(), 'ello-agents-override-'));
    const agentsDir = path.join(cwd, '.ello', 'agents');
    mkdirSync(agentsDir, { recursive: true });
    writeFileSync(
      path.join(agentsDir, 'explore.md'),
      `---
description: Overridden explore
mode: subagent
role: primary
---

Custom explore prompt.
`,
    );
    const registry = await makeRegistry(cwd);
    const explore = registry.get('explore');
    expect(explore.source).toBe('project');
    expect(explore.role).toBe('primary');
    expect(explore.description).toBe('Overridden explore');
  });

  it('config agent entries merge into registry', async () => {
    const cwd = mkdtempSync(path.join(tmpdir(), 'ello-agents-config-'));
    const elloDir = path.join(cwd, '.ello');
    mkdirSync(elloDir, { recursive: true });
    writeFileSync(
      path.join(elloDir, 'config.yaml'),
      `agent:
  reviewer:
    mode: subagent
    role: small
    description: Code reviewer
    tools:
      - read
      - grep
`,
    );
    const registry = await makeRegistry(cwd);
    const reviewer = registry.get('reviewer');
    expect(reviewer.mode).toBe('subagent');
    expect(reviewer.source).toBe('config');
  });

  it('rejects unknown markdown frontmatter fields', async () => {
    const cwd = mkdtempSync(path.join(tmpdir(), 'ello-agents-invalid-'));
    const agentsDir = path.join(cwd, '.ello', 'agents');
    mkdirSync(agentsDir, { recursive: true });
    writeFileSync(
      path.join(agentsDir, 'bad.md'),
      `---
description: Bad agent
unexpected: value
---

Prompt.
`,
    );
    await expect(makeRegistry(cwd)).rejects.toThrow('Unrecognized key');
  });
});
