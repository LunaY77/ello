/**
 * 本文件验证系统提示词按角色和能力组合后的稳定契约。
 */
import { createHash } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import { renderPromptTemplate } from '../../src/features/agent/index.js';

describe('prompt composition', () => {
  it('主代理组合全部共享规则且不泄漏模板语法', () => {
    const prompt = renderPromptTemplate('coding', {
      model: 'test-model',
      subagents_enabled: true,
    });

    for (const marker of [
      '# Verification',
      '# Investigation',
      '# Scope and Action',
      'Implement changes rather than only proposing them.',
      '# Reporting',
      '# Tool Discipline',
      'Before overwriting an existing file with `write`',
      '# Skills',
      '# File Changes',
      '# Code Quality',
      '# Safety',
      '# Programmatic Orchestration',
      'PTC is not a separate tool or DSL.',
      'Use one program when later steps depend on earlier results',
      'Keep independent lookups as separate calls in the same model response',
      'Use `write` followed by `bash` for a multi-line, reusable, or debuggable script.',
    ]) {
      expect(prompt).toContain(marker);
    }
    expect(prompt).not.toContain('run_program');
    expect(prompt).toContain(
      'Do not invent an SDK, DSL, or hidden Agent tool API.',
    );
    expect(prompt).toContain('# Primary Agent Role');
    expect(prompt).not.toContain('{%');
    expect(prompt).not.toContain('{{');
  });

  it('subagent 基线只包含与只读角色相容的共享规则', () => {
    const prompt = renderPromptTemplate('subagent', { model: 'test-model' });

    expect(prompt).toContain('# Subagent Worker Role');
    expect(prompt).toContain('# Investigation');
    expect(prompt).not.toContain('# Delegation');
    expect(prompt).not.toContain('# Primary Agent Role');
    expect(prompt).not.toContain('apply_patch');
    expect(prompt).not.toContain('# Code Quality');
    expect(prompt).not.toContain('{%');
    expect(prompt).not.toContain('{{');
  });

  it('subagent 开关同时改变委派段落和稳定提示词指纹输入', () => {
    const enabled = renderPromptTemplate('coding', {
      model: 'test-model',
      subagents_enabled: true,
    });
    const disabled = renderPromptTemplate('coding', {
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
