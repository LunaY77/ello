import { randomUUID } from 'node:crypto';

export function createSteerId(): string {
  return `steer_${randomUUID().replaceAll('-', '')}`;
}
