/**
 * 本文件按会话记录文件读取状态。
 *
 * 读取工具根据文件修改时间、大小和读取范围判断内容是否重复。Ello 写入文件后会主动
 * 清除对应记录；其他程序修改文件时，则在下次读取前通过文件信息变化发现。缓存数量
 * 设有上限，避免长时间会话持续占用内存。
 */

export interface FileVersion {
  readonly mtimeMs: number;
  readonly size: number;
}

export interface FileReadRange {
  readonly offset: number;
  readonly limit: number;
}

export interface FileReadSnapshot {
  readonly lineStart: number;
  readonly lineEnd: number;
  readonly totalLines: number;
  readonly size: number;
}

interface FileStateEntry {
  readonly version: FileVersion;
  readonly ranges: Map<string, FileReadSnapshot>;
}

const MAX_FILES_PER_SESSION = 4_096;
const MAX_RANGES_PER_FILE = 64;
const MAX_SESSIONS = 256;

/** 单个会话共用的文件读取记录。 */
export class SessionFileState {
  private readonly files = new Map<string, FileStateEntry>();

  /** 查询同一版本和范围是否已经读取过。 */
  unchanged(
    absolutePath: string,
    version: FileVersion,
    range: FileReadRange,
  ): FileReadSnapshot | undefined {
    const entry = this.files.get(absolutePath);
    if (entry === undefined) return undefined;
    if (!sameVersion(entry.version, version)) {
      this.files.delete(absolutePath);
      return undefined;
    }
    this.touchFile(absolutePath, entry);
    const key = rangeKey(range);
    const snapshot = entry.ranges.get(key);
    if (snapshot !== undefined) {
      entry.ranges.delete(key);
      entry.ranges.set(key, snapshot);
    }
    return snapshot;
  }

  /** 记录一次完整读取的文件版本和范围。 */
  record(
    absolutePath: string,
    version: FileVersion,
    range: FileReadRange,
    snapshot: FileReadSnapshot,
  ): void {
    const current = this.files.get(absolutePath);
    const entry =
      current !== undefined && sameVersion(current.version, version)
        ? current
        : { version, ranges: new Map<string, FileReadSnapshot>() };
    const key = rangeKey(range);
    entry.ranges.delete(key);
    entry.ranges.set(key, snapshot);
    while (entry.ranges.size > MAX_RANGES_PER_FILE) {
      const oldest = entry.ranges.keys().next().value;
      if (oldest === undefined) break;
      entry.ranges.delete(oldest);
    }
    this.touchFile(absolutePath, entry);
    while (this.files.size > MAX_FILES_PER_SESSION) {
      const oldest = this.files.keys().next().value;
      if (oldest === undefined) break;
      this.files.delete(oldest);
    }
  }

  /** 清除被写入、删除或移动的文件记录。 */
  invalidate(absolutePaths: readonly string[]): void {
    for (const absolutePath of absolutePaths) {
      this.files.delete(absolutePath);
    }
  }

  private touchFile(absolutePath: string, entry: FileStateEntry): void {
    this.files.delete(absolutePath);
    this.files.set(absolutePath, entry);
  }
}

/** 在 App Server 生命周期内保存各会话的文件读取记录。 */
export class SessionFileStateRegistry {
  private readonly sessions = new Map<string, SessionFileState>();

  /** 获取指定会话的文件读取记录。 */
  forSession(sessionId: string): SessionFileState {
    const normalized = sessionId.trim();
    if (normalized === '') {
      throw new Error('File state sessionId must not be empty.');
    }
    const existing = this.sessions.get(normalized);
    if (existing !== undefined) {
      this.sessions.delete(normalized);
      this.sessions.set(normalized, existing);
      return existing;
    }
    const created = new SessionFileState();
    this.sessions.set(normalized, created);
    while (this.sessions.size > MAX_SESSIONS) {
      const oldest = this.sessions.keys().next().value;
      if (oldest === undefined) break;
      this.sessions.delete(oldest);
    }
    return created;
  }

  /** 删除指定会话的文件读取记录。 */
  delete(sessionId: string): void {
    this.sessions.delete(sessionId);
  }
}

function sameVersion(left: FileVersion, right: FileVersion): boolean {
  return left.mtimeMs === right.mtimeMs && left.size === right.size;
}

function rangeKey(range: FileReadRange): string {
  return `${range.offset}:${range.limit}`;
}
