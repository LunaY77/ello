/**
 * Records fields a third-party Agent emitted that this framework does not
 * consume.
 *
 * Upstream CLIs add response fields without notice. Treating their wire format
 * as a closed set means any such addition invalidates otherwise valid
 * experiments, so drift is carried in evidence as an observable signal instead
 * of aborting the parse. Missing fields the framework *does* consume remain
 * fatal.
 */
export class WireFormatDrift {
  private readonly observed = new Set<string>();

  record(label: string, unknownKeys: readonly string[]): void {
    for (const key of unknownKeys) this.observed.add(`${label}.${key}`);
  }

  /** Sorted so recomputed evidence compares byte-identical during validation. */
  list(): readonly string[] {
    return [...this.observed].sort();
  }
}
