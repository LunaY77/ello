export interface BootProfile {
  mark(label: string): void;
  measure<T>(label: string, fn: () => Promise<T>): Promise<T>;
  flush(): void;
}

export function createBootProfile(scope: string): BootProfile {
  if (process.env.ELLO_BOOT_PROFILE !== '1') {
    return disabledProfile;
  }
  const started = performance.now();
  let last = started;
  const rows: string[] = [];
  return {
    mark(label) {
      const now = performance.now();
      rows.push(formatRow(scope, label, now - started, now - last));
      last = now;
    },
    async measure(label, fn) {
      const before = performance.now();
      const result = await fn();
      const now = performance.now();
      rows.push(formatRow(scope, label, now - started, now - before));
      last = now;
      return result;
    },
    flush() {
      if (rows.length > 0) {
        process.stderr.write(`${rows.join('\n')}\n`);
      }
    },
  };
}

const disabledProfile: BootProfile = {
  mark() {},
  measure(_label, fn) {
    return fn();
  },
  flush() {},
};

function formatRow(
  scope: string,
  label: string,
  totalMs: number,
  deltaMs: number,
): string {
  return `[ello:${scope}] ${label}\ttotal=${Math.round(totalMs)}ms\tdelta=${Math.round(deltaMs)}ms`;
}
