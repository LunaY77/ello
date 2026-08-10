/**
 * 最小 ANSI 屏幕模拟器：把 Ink 写入 TTY 的字节流还原成 rows×columns 网格，
 * 用来断言"用户实际看到的画面"，而不是断言输出字节里包含什么。
 *
 * 支持 Ink + ansi-escapes 实际使用的子集：CSI A/B/C/D/E/F/G/H/J/K、换行滚动、
 * 私有模式（?25l / ?2026h）忽略、SGR 忽略。
 */
const ESC = '\u001B';
const BEL = '\u0007';

export interface ScreenOptions {
  readonly columns: number;
  readonly rows: number;
}

export class AnsiScreen {
  readonly columns: number;
  readonly rows: number;
  /** 被滚出屏幕顶部的行，等价于 shell scrollback。 */
  readonly scrollback: string[] = [];
  private grid: string[][];
  private row = 0;
  private column = 0;

  constructor(options: ScreenOptions) {
    this.columns = options.columns;
    this.rows = options.rows;
    this.grid = Array.from({ length: options.rows }, () => this.blankRow());
  }

  write(chunk: string): void {
    let index = 0;
    while (index < chunk.length) {
      const char = chunk[index]!;
      if (char === ESC) {
        index = this.handleEscape(chunk, index);
        continue;
      }
      index += 1;
      if (char === '\n') {
        this.column = 0;
        this.lineFeed();
        continue;
      }
      if (char === '\r') {
        this.column = 0;
        continue;
      }
      if (char === BEL || char === '\b') continue;
      this.putChar(char);
    }
  }

  /** 当前屏幕（去掉行尾空白）。 */
  lines(): string[] {
    return this.grid.map((row) => row.join('').replace(/\s+$/u, ''));
  }

  render(): string {
    return this.lines().join('\n');
  }

  /** scrollback + 当前屏幕，用来断言历史是否还留在终端里。 */
  allLines(): string[] {
    return [...this.scrollback, ...this.lines()];
  }

  private blankRow(): string[] {
    return Array.from({ length: this.columns }, () => ' ');
  }

  private putChar(char: string): void {
    if (this.column >= this.columns) {
      this.column = 0;
      this.lineFeed();
    }
    this.grid[this.row]![this.column] = char;
    this.column += 1;
  }

  private lineFeed(): void {
    if (this.row < this.rows - 1) {
      this.row += 1;
      return;
    }
    this.scrollback.push(this.grid[0]!.join('').replace(/\s+$/u, ''));
    this.grid.shift();
    this.grid.push(this.blankRow());
  }

  private handleEscape(chunk: string, start: number): number {
    const next = chunk[start + 1];
    if (next !== '[') {
      if (next === ']') {
        const terminator = chunk.indexOf(BEL, start);
        return terminator === -1 ? chunk.length : terminator + 1;
      }
      return start + 2;
    }
    let index = start + 2;
    let params = '';
    while (index < chunk.length && /[\d;?<>=]/u.test(chunk[index]!)) {
      params += chunk[index]!;
      index += 1;
    }
    const final = chunk[index];
    index += 1;
    if (final === undefined) return chunk.length;
    if (params.startsWith('?')) return index; // 私有模式开关与屏幕布局无关
    const numbers = params
      .split(';')
      .map((value) => (value === '' ? undefined : Number(value)));
    // VT 语义：光标移动类序列的参数为 0 时按 1 处理（ansi-escapes 会发出 CSI 0 A）。
    const first = Math.max(1, numbers[0] ?? 1);
    switch (final) {
      case 'A':
        this.row = Math.max(0, this.row - first);
        break;
      case 'B':
        this.row = Math.min(this.rows - 1, this.row + first);
        break;
      case 'C':
        this.column = Math.min(this.columns - 1, this.column + first);
        break;
      case 'D':
        this.column = Math.max(0, this.column - first);
        break;
      case 'E':
        this.column = 0;
        for (let step = 0; step < first; step += 1) this.lineFeed();
        break;
      case 'F':
        this.column = 0;
        this.row = Math.max(0, this.row - first);
        break;
      case 'G':
        this.column = Math.max(0, Math.min(this.columns - 1, first - 1));
        break;
      case 'H':
      case 'f':
        this.row = Math.max(0, Math.min(this.rows - 1, (numbers[0] ?? 1) - 1));
        this.column = Math.max(
          0,
          Math.min(this.columns - 1, (numbers[1] ?? 1) - 1),
        );
        break;
      case 'J':
        this.eraseDisplay(numbers[0] ?? 0);
        break;
      case 'K':
        this.eraseLine(numbers[0] ?? 0);
        break;
      default:
        break; // SGR(m) 等不影响布局
    }
    return index;
  }

  private eraseDisplay(mode: number): void {
    if (mode === 3) {
      this.scrollback.length = 0;
      return;
    }
    if (mode === 2) {
      this.grid = Array.from({ length: this.rows }, () => this.blankRow());
      return;
    }
    if (mode === 0) {
      this.eraseLine(0);
      for (let row = this.row + 1; row < this.rows; row += 1) {
        this.grid[row] = this.blankRow();
      }
      return;
    }
    for (let row = 0; row < this.row; row += 1) {
      this.grid[row] = this.blankRow();
    }
    this.eraseLine(1);
  }

  private eraseLine(mode: number): void {
    const row = this.grid[this.row]!;
    const from = mode === 0 ? this.column : 0;
    const to = mode === 1 ? this.column + 1 : this.columns;
    for (let column = from; column < to; column += 1) row[column] = ' ';
  }
}
