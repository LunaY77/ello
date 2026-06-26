import js from '@eslint/js';
import checkFile from 'eslint-plugin-check-file';
import importX from 'eslint-plugin-import-x';
import reactHooks from 'eslint-plugin-react-hooks';
import reactRefresh from 'eslint-plugin-react-refresh';
import globals from 'globals';
import tseslint from 'typescript-eslint';

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

      /**
       * 导入路径限制规则
       * 强制单向依赖，防止循环依赖
       */
      'import-x/no-restricted-paths': [
        'error',
        {
          zones: [
            // features 之间不能互相导入
            {
              target: './src/features',
              from: './src/features',
              except: ['.'],
            },
            // features 不能导入 app
            {
              target: './src/features',
              from: './src/app',
            },
            // 共享模块不能导入 features 或 app
            {
              target: [
                './src/components',
                './src/hooks',
                './src/lib',
                './src/utils',
              ],
              from: ['./src/features', './src/app'],
            },
          ],
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
);
