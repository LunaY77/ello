/**
 * 轻量语法高亮:有序 sticky 正则 tokenizer,颜色全部来自 tokens.css 的
 * syntax-token-* 变量,主题切换零成本。只服务阅读,不追求编译器级精度。
 */
export type TokenKind =
  | 'keyword'
  | 'string'
  | 'comment'
  | 'number'
  | 'function'
  | 'type'
  | 'property'
  | 'builtin'
  | 'operator'
  | 'punctuation'
  | 'plain';

export interface HighlightToken {
  readonly text: string;
  readonly kind: TokenKind;
}

interface Rule {
  readonly pattern: RegExp;
  readonly kind: TokenKind;
  readonly capture?: (match: RegExpExecArray) => TokenKind | undefined;
}

function rule(pattern: string, kind: TokenKind, flags = ''): Rule {
  return { pattern: new RegExp(pattern, `y${flags}`), kind };
}

const CLIKE_KEYWORDS = new Set([
  'const', 'let', 'var', 'function', 'return', 'if', 'else', 'for', 'while',
  'do', 'switch', 'case', 'default', 'break', 'continue', 'new', 'delete',
  'typeof', 'instanceof', 'in', 'of', 'class', 'extends', 'super', 'this',
  'null', 'undefined', 'true', 'false', 'import', 'from', 'export', 'async',
  'await', 'try', 'catch', 'finally', 'throw', 'yield', 'static', 'get',
  'set', 'void', 'enum', 'interface', 'type', 'implements', 'namespace',
  'declare', 'abstract', 'readonly', 'private', 'public', 'protected', 'as',
  'keyof', 'infer', 'is', 'satisfies', 'fn', 'mut', 'pub', 'struct', 'impl',
  'trait', 'match', 'loop', 'self', 'Self', 'crate', 'use', 'mod', 'where',
  'ref', 'move', 'dyn', 'unsafe', 'extern', 'func', 'go', 'defer', 'select',
  'chan', 'map', 'package', 'nil', 'fallthrough', 'range',
]);

const PYTHON_KEYWORDS = new Set([
  'def', 'class', 'return', 'if', 'elif', 'else', 'for', 'while', 'import',
  'from', 'as', 'with', 'lambda', 'try', 'except', 'finally', 'raise',
  'global', 'nonlocal', 'pass', 'break', 'continue', 'yield', 'async',
  'await', 'in', 'is', 'not', 'and', 'or', 'None', 'True', 'False', 'self',
  'assert', 'del', 'print',
]);

const BASH_KEYWORDS = new Set([
  'if', 'then', 'else', 'elif', 'fi', 'for', 'while', 'do', 'done', 'case',
  'esac', 'function', 'in', 'echo', 'cd', 'export', 'local', 'return',
  'exit', 'source', 'set', 'unset', 'shift', 'readonly', 'eval', 'exec',
  'sudo', 'rm', 'cp', 'mv', 'mkdir', 'cat', 'grep', 'sed', 'awk', 'curl',
  'git', 'pnpm', 'npm', 'node', 'python', 'pip',
]);

const BUILTINS = new Set([
  'console', 'log', 'Math', 'JSON', 'Promise', 'Array', 'Object', 'String',
  'Number', 'Boolean', 'Error', 'TypeError', 'Map', 'Set', 'Symbol', 'Date',
  'RegExp', 'BigInt', 'Some', 'None', 'Ok', 'Err', 'Vec', 'Option', 'Result',
  'Box', 'len', 'str', 'int', 'float', 'dict', 'list', 'tuple', 'fmt',
]);

function identifierRule(keywords: ReadonlySet<string>): Rule {
  return {
    pattern: /\b[A-Za-z_$][\w$]*\b/y,
    kind: 'plain',
    capture: (match) => {
      const word = match[0];
      if (keywords.has(word)) return 'keyword';
      if (BUILTINS.has(word)) return 'builtin';
      if (/^[A-Z]/.test(word)) return 'type';
      return undefined;
    },
  };
}

const clikeRules: readonly Rule[] = [
  rule('//[^\\n]*', 'comment'),
  rule('/\\*[\\s\\S]*?\\*/', 'comment'),
  rule('`(?:\\\\.|[^`\\\\])*`?', 'string'),
  rule('"(?:\\\\.|[^"\\\\\\n])*"?', 'string'),
  rule("'(?:\\\\.|[^'\\\\\\n])*'?", 'string'),
  rule('#[A-Za-z][^\\n]*', 'comment'),
  rule('\\b0x[0-9a-fA-F]+\\b', 'number'),
  rule('\\b\\d[\\d_]*(\\.\\d+)?([eE][+-]?\\d+)?\\b', 'number'),
  rule('\\.[A-Za-z_$][\\w$]*', 'property'),
  identifierRule(CLIKE_KEYWORDS),
  rule('[+\\-*/%=!<>&|^~?:]+', 'operator'),
  rule('[{}()\\[\\];,.]', 'punctuation'),
  rule('\\s+', 'plain'),
];

const pythonRules: readonly Rule[] = [
  rule('#[^\\n]*', 'comment'),
  rule('"""[\\s\\S]*?("""|$)', 'string'),
  rule("'''[\\s\\S]*?('''|$)", 'string'),
  rule('"(?:\\\\.|[^"\\\\\\n])*"?', 'string'),
  rule("'(?:\\\\.|[^'\\\\\\n])*'?", 'string'),
  rule('@[A-Za-z_$][\\w$.]*', 'builtin'),
  rule('\\b\\d[\\d_]*(\\.\\d+)?\\b', 'number'),
  identifierRule(PYTHON_KEYWORDS),
  rule('[+\\-*/%=!<>&|^~?:]+', 'operator'),
  rule('[{}()\\[\\];,.]', 'punctuation'),
  rule('\\s+', 'plain'),
];

const bashRules: readonly Rule[] = [
  rule('#[^\\n]*', 'comment'),
  rule('"(?:\\\\.|\\$\\([^)]*\\)|[^"\\\\])*"?', 'string'),
  rule("'[^']*'?", 'string'),
  rule('\\$\\{?#?[A-Za-z_@*?$!0-9]+\\}?', 'property'),
  rule('--?[A-Za-z][\\w-]*', 'type'),
  rule('\\b\\d+\\b', 'number'),
  identifierRule(BASH_KEYWORDS),
  rule('[|&;<>]+', 'operator'),
  rule('[{}()\\[\\],]', 'punctuation'),
  rule('\\s+', 'plain'),
];

const jsonRules: readonly Rule[] = [
  rule('"(?:\\\\.|[^"\\\\])*"(?=\\s*:)', 'property'),
  rule('"(?:\\\\.|[^"\\\\])*"?', 'string'),
  rule('-?\\b\\d+(\\.\\d+)?([eE][+-]?\\d+)?\\b', 'number'),
  rule('\\b(true|false|null)\\b', 'keyword'),
  rule('[{}()\\[\\];,.:]', 'punctuation'),
  rule('\\s+', 'plain'),
];

const yamlRules: readonly Rule[] = [
  rule('#[^\\n]*', 'comment'),
  rule('^[ \\t]*-?[ \\t]*[A-Za-z_.$][\\w.$-]*(?=\\s*:)', 'property', 'm'),
  rule('"(?:\\\\.|[^"\\\\])*"?', 'string'),
  rule("'[^']*'?", 'string'),
  rule('\\b\\d+(\\.\\d+)?\\b', 'number'),
  rule('\\b(true|false|null|yes|no|on|off)\\b', 'keyword'),
  rule('[{}()\\[\\];,.:&|>-]', 'punctuation'),
  rule('\\s+', 'plain'),
];

const LANG_ALIASES: Record<string, string> = {
  ts: 'clike', tsx: 'clike', typescript: 'clike', js: 'clike', jsx: 'clike',
  javascript: 'clike', mjs: 'clike', cjs: 'clike', java: 'clike', kt: 'clike',
  c: 'clike', h: 'clike', cpp: 'clike', cc: 'clike', rs: 'clike', rust: 'clike',
  go: 'clike', css: 'clike', scss: 'clike', swift: 'clike', cs: 'clike',
  py: 'python', python: 'python',
  sh: 'bash', bash: 'bash', zsh: 'bash', shell: 'bash', console: 'bash',
  json: 'json', jsonc: 'json',
  yaml: 'yaml', yml: 'yaml', toml: 'yaml',
};

const RULES: Record<string, readonly Rule[]> = {
  clike: clikeRules,
  python: pythonRules,
  bash: bashRules,
  json: jsonRules,
  yaml: yamlRules,
};

export function resolveLanguage(lang: string | undefined): string | undefined {
  if (lang === undefined) return undefined;
  return LANG_ALIASES[lang.toLowerCase()];
}

/** 把源码切成带类型的 token 序列;未识别语言原样返回。 */
export function highlightCode(code: string, lang: string | undefined): HighlightToken[] {
  const family = resolveLanguage(lang);
  const rules = family === undefined ? undefined : RULES[family];
  if (rules === undefined) return [{ text: code, kind: 'plain' }];
  const tokens: HighlightToken[] = [];
  let position = 0;
  while (position < code.length) {
    let matched = false;
    for (const ruleDef of rules) {
      ruleDef.pattern.lastIndex = position;
      const match = ruleDef.pattern.exec(code);
      if (match === null || match[0].length === 0) continue;
      const kind = ruleDef.capture?.(match) ?? ruleDef.kind;
      pushToken(tokens, match[0], kind);
      position += match[0].length;
      matched = true;
      break;
    }
    if (!matched) {
      pushToken(tokens, code[position] ?? '', 'plain');
      position += 1;
    }
  }
  return tokens;
}

function pushToken(tokens: HighlightToken[], text: string, kind: TokenKind): void {
  const last = tokens[tokens.length - 1];
  if (last !== undefined && last.kind === kind) {
    tokens[tokens.length - 1] = { text: last.text + text, kind };
    return;
  }
  tokens.push({ text, kind });
}
