/**
 * 本文件验证系统提示词按角色和能力组合后的稳定契约。
 */
import { createHash } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import { renderPromptTemplate } from '../../src/features/agent/index.js';

describe('prompt composition', () => {
  it('rapid 保留当前 Direct 行为与 Ello 工具协议', () => {
    const prompt = renderPromptTemplate('rapid', {
      model: 'test-model',
      subagents_enabled: false,
    });

    for (const marker of [
      '## 1. General',
      'The user collaborates with you synchronously and values low latency.',
      "Treat the user's request, issue description, failing test, stack trace, documentation, and proposed fix as **evidence**",
      '## 3. Rapid Working Mode',
      'Optimize for **minimum sufficient investigation and validation**.',
      '## 4. Engineering Judgment',
      '## 5. Editing and Workspace Safety',
      '## 6. Validation',
      'Rapid mode means **cheap targeted validation**, not no validation.',
      '## Command Run',
      '`command_run` is the only model-visible Tool.',
      'Emit at most one `command_run` per model response.',
      'Frames may use only `step`, `command`, `args`, `body`, `input`, and `onFailure`',
      'Put positional arguments and options in `args` as separate strings',
      'Treat the current Command Catalog as authoritative.',
      '## Skills',
      'Use `write` plus `bash` for reusable scripts.',
    ]) {
      expect(prompt).toContain(marker);
    }
    expect(prompt).not.toContain('run_program');
    expect(prompt).not.toContain('expectedContent');
    expect(prompt).not.toContain('# Balanced');
    expect(prompt).not.toContain('.tura/script');
    expect(prompt).not.toContain('task_status');
    expect(prompt).not.toContain('command_type');
    expect(prompt).not.toContain(
      'Before overwriting an existing file with `write`',
    );
    expect(prompt).not.toContain('{%');
    expect(prompt).not.toContain('{{');
  });

  it('subagent 基线只包含与只读角色相容的共享规则', () => {
    const prompt = renderPromptTemplate('subagent', { model: 'test-model' });

    expect(prompt).toContain('# Subagent Worker Role');
    expect(prompt).toContain('# Command Run');
    expect(prompt).toContain('# Investigation');
    expect(prompt).not.toContain('# Delegation');
    expect(prompt).not.toContain('# Primary Agent Role');
    expect(prompt).toContain('apply_patch');
    expect(prompt).not.toContain('# Code Quality');
    expect(prompt).not.toContain('{%');
    expect(prompt).not.toContain('{{');
  });

  it('rapid 与 thorough 是两种独立且完整的 primary 策略', () => {
    const rapid = renderPromptTemplate('rapid');
    const thorough = renderPromptTemplate('thorough');

    expect(rapid).toContain('## 3. Rapid Working Mode');
    expect(rapid).toContain(
      'Optimize for **minimum sufficient investigation and validation**.',
    );
    expect(rapid).not.toContain('## 3. Thorough Investigation');
    expect(thorough).toContain('## 3. Thorough Investigation');
    expect(thorough).not.toContain('## 3. Rapid Working Mode');
    for (const marker of [
      'Optimize for **high confidence within materially relevant scope**.',
      'Verification depth must scale with change risk.',
      'rerun the affected verification;',
      'Before declaring completion, compare the actual resulting state',
    ]) {
      expect(thorough).toContain(marker);
    }
    expect(sha256(rapid)).not.toBe(sha256(thorough));
    for (const prompt of [rapid, thorough]) {
      expect(prompt).toContain('# Command Run');
      expect(prompt).toContain('`command_run` is the only model-visible Tool.');
      expect(prompt).toContain(
        'Treat the current Command Catalog as authoritative.',
      );
      expect(prompt).not.toContain(
        'Put a `command_invoke` invocation entirely in `input: { name, arguments }`',
      );
      expect(prompt).not.toContain(
        'Start every `apply_patch` body with `*** Begin Patch`',
      );
    }
  });

  it('subagent 开关同时改变委派段落和稳定提示词指纹输入', () => {
    const enabled = renderPromptTemplate('rapid', {
      model: 'test-model',
      subagents_enabled: true,
    });
    const disabled = renderPromptTemplate('rapid', {
      model: 'test-model',
      subagents_enabled: false,
    });

    expect(enabled).toContain('# Delegation');
    expect(disabled).not.toContain('# Delegation');
    expect(sha256(enabled)).not.toBe(sha256(disabled));
  });

  it.each([
    'compact',
    'goal-activated',
    'goal-continuation',
    'title',
    'summary',
  ])('保留单文件 profile %s 的渲染能力', (profile) => {
    const prompt = renderPromptTemplate(profile, {
      summary: 'summary',
      objective: 'objective',
    });

    expect(prompt.trim()).not.toBe('');
    expect(prompt).not.toContain('{%');
    expect(prompt).not.toContain('{{');
  });
});

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}
