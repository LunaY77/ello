import js from '@eslint/js';
import checkFile from 'eslint-plugin-check-file';
import importX from 'eslint-plugin-import-x';
import reactHooks from 'eslint-plugin-react-hooks';
import reactRefresh from 'eslint-plugin-react-refresh';
import globals from 'globals';
import tseslint from 'typescript-eslint';

const agentFeatureNames = [
  'agent',
  'artifact',
  'config',
  'fs',
  'memory',
  'model',
  'repo',
  'skill',
  'task',
  'thread',
  'tool',
  'workspace',
];

const publicFeatureEntries = (feature) =>
  feature === 'agent'
    ? ['./index.ts', './engine/index.ts', './subagents/index.ts']
    : ['./index.ts'];

const featureBoundaryZones = agentFeatureNames.flatMap((consumer) =>
  agentFeatureNames
    .filter((provider) => provider !== consumer)
    .map((provider) => ({
      target: `packages/ello-agent/src/features/${consumer}`,
      from: `packages/ello-agent/src/features/${provider}`,
      except: publicFeatureEntries(provider),
      message: `Feature ${consumer} must import ${provider} through its public entry.`,
    })),
);

const appFeatureZones = agentFeatureNames.map((provider) => ({
  target: 'packages/ello-agent/src/app.ts',
  from: `packages/ello-agent/src/features/${provider}`,
  except: publicFeatureEntries(provider),
  message: `app.ts must compose ${provider} through its public entry.`,
}));

/**
 * ESLint 配置文件
 *
 * ESLint 是 JavaScript/TypeScript 代码检查工具
 * 用于发现代码问题、强制代码风格
 */
export default tseslint.config(
  /**
   * 全局忽略配置
   */
  {
    ignores: ['**/dist/**', '**/node_modules/**', '**/coverage/**'],
  },

  /**
   * TypeScript 文件配置
   */
  {
    files: ['**/*.{ts,tsx}'],
    extends: [js.configs.recommended, ...tseslint.configs.recommended],
    languageOptions: {
      ecmaVersion: 2020,
      globals: {
        ...globals.node,
        ...globals.es2020,
      },
    },
    plugins: {
      'react-hooks': reactHooks,
      'react-refresh': reactRefresh,
      'import-x': importX,
      'check-file': checkFile,
    },
    rules: {
      /**
       * 允许 _ 前缀的未使用变量（常见的有意忽略惯例）
       */
      '@typescript-eslint/no-unused-vars': [
        'error',
        {
          argsIgnorePattern: '^_',
          varsIgnorePattern: '^_',
          caughtErrorsIgnorePattern: '^_',
        },
      ],

      // 这些指标只捕捉异常膨胀；协议投影、parser 和状态机允许保持完整的顺序控制流。
      'max-lines': [
        'warn',
        { max: 1000, skipBlankLines: true, skipComments: true },
      ],
      'max-lines-per-function': ['warn', { max: 400, skipComments: true }],
      complexity: ['warn', 60],
      'max-depth': ['warn', 6],

      /**
       * React Hooks 规则
       */
      ...reactHooks.configs.recommended.rules,

      /**
       * React Refresh 规则
       * 确保组件可以正确热更新
       */
      'react-refresh/only-export-components': [
        'warn',
        { allowConstantExport: true },
      ],

      /**
       * 导入顺序规则
       * 强制导入语句按照特定顺序排列
       */
      'import-x/order': [
        'error',
        {
          groups: [
            'builtin', // Node.js 内置模块
            'external', // npm 包
            'internal', // 项目内部模块（@/* 别名）
            'parent', // 父目录模块
            'sibling', // 同级目录模块
            'index', // index 文件
          ],
          'newlines-between': 'always',
          alphabetize: {
            order: 'asc',
            caseInsensitive: true,
          },
        },
      ],

      'import-x/no-cycle': ['error', { ignoreExternal: true }],

      /**
       * 导入路径限制规则
       * 强制单向依赖，防止循环依赖
       */
      'import-x/no-restricted-paths': [
        'error',
        {
          zones: [
            ...featureBoundaryZones,
            ...appFeatureZones,
            {
              target: 'packages/ello-agent/src/features',
              from: 'packages/ello-agent/src/app.ts',
              message: 'Features must not import the App composition root.',
            },
            {
              target: 'packages/ello-agent/src/server',
              from: 'packages/ello-agent/src/features',
              message:
                'The generic Server facade must not import product features.',
            },
          ],
          basePath: process.cwd(),
        },
      ],

      /**
       * 文件命名规则
       * TS 文件使用 kebab-case，TSX 组件文件使用 PascalCase
       */
      'check-file/filename-naming-convention': [
        'error',
        {
          '**/*.ts': 'KEBAB_CASE',
          '**/*.tsx': 'PASCAL_CASE',
        },
        {
          ignoreMiddleExtensions: true,
        },
      ],

      /**
       * 文件夹命名规则
       * 强制使用 kebab-case 命名
       */
      'check-file/folder-naming-convention': 'off',
    },
  },

  {
    files: ['**/*.test.{ts,tsx}', '**/tests/**/*.{ts,tsx}'],
    rules: {
      // 测试文件按行为域集中组织，describe 回调和 fixture 不作为生产函数粒度信号。
      'max-lines': [
        'warn',
        { max: 1600, skipBlankLines: true, skipComments: true },
      ],
      'max-lines-per-function': ['warn', { max: 1600, skipComments: true }],
    },
  },

  {
    files: ['packages/ello-tui/src/**/*.{ts,tsx}'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          paths: [
            {
              name: '@ello/agent',
              message:
                'TUI may only import protocol types from @ello/agent/protocol.',
            },
            {
              name: '@ello/agent/server-entry',
              message:
                'Resolve server-entry for a child process; never import it.',
            },
          ],
          patterns: [
            {
              group: ['@ello/agent/internal/**', '@ello/agent/dist/**'],
              message: 'TUI cannot import private Server implementation paths.',
            },
          ],
        },
      ],
    },
  },

  {
    files: [
      'packages/ello-agent/src/agent/execution/**/*.{ts,tsx}',
      'packages/ello-agent/src/server/methods/**/*.{ts,tsx}',
      'packages/ello-agent/src/server/runtime/**/*.{ts,tsx}',
      'packages/ello-tui/src/cli/**/*.{ts,tsx}',
      'packages/ello-tui/src/client/event-reducer.ts',
      'packages/ello-tui/src/tui/App.tsx',
      'packages/ello-tui/src/tui/hooks/**/*.{ts,tsx}',
      'packages/ello-tui/src/tui/store/tui-event-store.ts',
      'packages/ello-tui/src/tui/component/LiveViewport.tsx',
      'packages/ello-tui/src/tui/component/TerminalHistoryOutput.tsx',
    ],
    rules: {
      'max-lines': [
        'error',
        { max: 1000, skipBlankLines: true, skipComments: true },
      ],
    },
  },
);
