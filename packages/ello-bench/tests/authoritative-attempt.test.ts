import { describe, expect, it } from 'vitest';

import { selectAuthoritativeAttempt } from '../src/infra/report/fs-report.js';

const attempt = (attempt: number, status: string) => ({ attempt, status });

describe('authoritative attempt selection', () => {
  it('prefers a completed attempt over later invalid retries', () => {
    // 被收割的 a1 排在后来那些 invalid 重试之前：判决不能丢
    const attempts = [
      attempt(1, 'completed'),
      attempt(2, 'invalid_infrastructure'),
      attempt(3, 'invalid_infrastructure'),
    ];
    expect(selectAuthoritativeAttempt(attempts)).toEqual(
      attempt(1, 'completed'),
    );
  });

  it('lets a later full rerun supersede an earlier verdict', () => {
    const attempts = [attempt(1, 'completed'), attempt(3, 'completed')];
    expect(selectAuthoritativeAttempt(attempts)).toEqual(
      attempt(3, 'completed'),
    );
  });

  it('falls back to the last attempt when nothing completed', () => {
    const attempts = [
      attempt(1, 'invalid_infrastructure'),
      attempt(2, 'invalid_infrastructure'),
    ];
    expect(selectAuthoritativeAttempt(attempts)).toEqual(
      attempt(2, 'invalid_infrastructure'),
    );
  });

  it('returns undefined for an empty attempt list', () => {
    expect(selectAuthoritativeAttempt([])).toBeUndefined();
  });
});
