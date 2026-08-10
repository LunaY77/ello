/**
 * 固定工程任务集的 Ello-owned 声明。
 *
 * 任务正文、环境与 verifier 从固定 corpus revision 读取；这里只冻结成员和分层标签。
 */
import type { DeepSweTaskDeclaration } from '../contract/index.js';
import { sha256, stableJson } from '../hash.js';

export const DEEP_SWE_SOURCE_REVISION =
  'a40d7298b18999c2d9b0ded7d6928e3ee26b5524';
export const DEEP_SWE_SOURCE_REPOSITORY =
  'https://github.com/datacurve-ai/deep-swe.git';

function task(
  taskId: string,
  language: DeepSweTaskDeclaration['language'],
  difficultyBand: DeepSweTaskDeclaration['difficultyBand'],
): DeepSweTaskDeclaration {
  return {
    taskId,
    language,
    difficultyBand,
  };
}

export const DEEP_SWE_TASKS: ReadonlyArray<DeepSweTaskDeclaration> = [
  task('actionlint-action-pinning-lint', 'go', 'easy'),
  task('abs-stepped-slices', 'go', 'medium-easy'),
  task('yaegi-go-embed-directives', 'go', 'medium-hard'),
  task('dasel-html-document-format', 'go', 'hard'),
  task('cattrs-partial-structuring-recovery', 'python', 'easy'),
  task('numba-stencil-boundary-modes', 'python', 'medium-easy'),
  task('bandit-incremental-cache-control', 'python', 'medium-hard'),
  task('httpx-streaming-json-iteration', 'python', 'hard'),
  task('happy-dom-abort-pending-body-reads', 'typescript', 'easy'),
  task(
    'dynamodb-toolbox-conditional-attribute-requirements',
    'typescript',
    'medium-easy',
  ),
  task('awilix-async-container-initialization', 'typescript', 'medium-hard'),
  task('quill-shared-toolbar-focus', 'typescript', 'hard'),
  task('wasmi-trap-coredumps', 'rust', 'easy'),
  task('fd-deterministic-multi-key-sorting', 'rust', 'medium-easy'),
  task('boa-hierarchical-evaluation-cancellation', 'rust', 'medium-hard'),
  task('pest-character-class-coalescing', 'rust', 'hard'),
  task('yjs-map-conflict-detection', 'javascript', 'easy'),
  task('testem-per-launcher-reports', 'javascript', 'medium-easy'),
  task('csstree-shorthand-expansion-compression', 'javascript', 'medium-hard'),
  task('katex-multicolumn-array-spans', 'javascript', 'hard'),
];

export const DEEP_SWE_TASK_SET_HASH = sha256(stableJson(DEEP_SWE_TASKS));

if (DEEP_SWE_TASKS.length !== 20) {
  throw new Error(`Expected 20 tasks, received ${DEEP_SWE_TASKS.length}.`);
}
