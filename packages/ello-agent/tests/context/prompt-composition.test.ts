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
      '# General',
      'The user would prefer that you make mistakes rather than over-explore.',
      'You are good at backwardthinking.',
      '## Engineering judgment',
      '## Build Together As You Go',
      'STRICT ONE_SHOT MODE',
      '## Validation Behavior',
      'NEVER review code you have written.',
      '# Command Run',
      '`command_run` is the only model-visible Tool.',
      'Emit at most one `command_run` Tool Call in a model response.',
      'A Command Frame accepts only `step`, `command`, `args`, `body`, `input`, and `onFailure`.',
      'every `--name <value>` option must appear as separate',
      'Treat the Command Catalog supplied with the current model request as the complete capability list.',
      '# Skills',
      'PTC is not a separate Tool or Command.',
      'Use `write` followed by `bash` for a longer reusable script.',
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

    expect(rapid).toContain('STRICT ONE_SHOT MODE');
    expect(thorough).not.toContain('STRICT ONE_SHOT MODE');
    for (const marker of [
      'run the relevant targeted verification',
      'fix the cause and rerun the affected verification',
      'completion audit',
    ]) {
      expect(thorough).toContain(marker);
    }
    expect(sha256(rapid)).not.toBe(sha256(thorough));
    for (const prompt of [rapid, thorough]) {
      expect(prompt).toContain('# Command Run');
      expect(prompt).toContain('`command_run` is the only model-visible Tool.');
      expect(prompt).toContain(
        'Treat the Command Catalog supplied with the current model request as the complete capability list.',
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
