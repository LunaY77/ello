/**
 * 固定工程任务集的 Ello-owned 声明。
 *
 * 任务正文、环境与 verifier 从固定 corpus revision 读取；这里冻结完整 113 个任务的
 * membership 与分层标签。分层标签按文档化 rank-band 规则从官方 trials 快照一次性
 * 计算并冻结：语言内按官方通过率降序排名（并列按 task ID 顺序），四等分后依次标注
 * easy / medium-easy / medium-hard / hard，不随线上 trial 数据后续刷新而改变。
 * 快照来源：https://deepswe.datacurve.ai/artifacts/v1.1/trials.json（2026-08-15 获取）。
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
  // go
  task('actionlint-action-pinning-lint', 'go', 'easy'),
  task('wazero-multi-module-snapshots', 'go', 'easy'),
  task('goreleaser-retry-publish-auditing', 'go', 'easy'),
  task('helm-unified-manifest-stream', 'go', 'easy'),
  task('ytt-jsonpath-query-api', 'go', 'easy'),
  task('go-genai-streamed-function-args', 'go', 'easy'),
  task('kcp-go-multiplexed-kcp-streams', 'go', 'easy'),
  task('task-task-graph-export', 'go', 'easy'),
  task('abs-module-cache-flags', 'go', 'medium-easy'),
  task('arcane-drift-detection-baselines', 'go', 'medium-easy'),
  task('geo-shapeindex-serialization', 'go', 'medium-easy'),
  task('abs-stepped-slices', 'go', 'medium-easy'),
  task('anko-default-function-arguments', 'go', 'medium-easy'),
  task('go-git-worktree-merge-conflicts', 'go', 'medium-easy'),
  task('yaegi-go-embed-directives', 'go', 'medium-easy'),
  task('etree-xml-diff-patch', 'go', 'medium-easy'),
  task('opa-template-string-reconstruction', 'go', 'medium-easy'),
  task('tengo-callable-instance-isolation', 'go', 'medium-hard'),
  task('scriggo-method-declarations', 'go', 'medium-hard'),
  task('tengo-destructuring-bindings', 'go', 'medium-hard'),
  task('opa-rego-rule-profiling', 'go', 'medium-hard'),
  task('scc-bounded-memory-spilling', 'go', 'medium-hard'),
  task('pebble-durability-wait-apis', 'go', 'medium-hard'),
  task('prometheus-typed-label-sorting', 'go', 'medium-hard'),
  task('dasel-html-document-format', 'go', 'medium-hard'),
  task('go-critic-doc-link-checker', 'go', 'hard'),
  task('anko-typed-variable-bindings', 'go', 'hard'),
  task('kgateway-consistent-hash-policy', 'go', 'hard'),
  task('onedump-dump-encryption-pipeline', 'go', 'hard'),
  task('participle-grammar-conflict-analysis', 'go', 'hard'),
  task('expr-try-catch-errors', 'go', 'hard'),
  task('helm-array-merge-strategies', 'go', 'hard'),
  task('termenv-preserve-ansi-resets', 'go', 'hard'),
  task('updo-policy-alerting', 'go', 'hard'),
  // python
  task('narwhals-rolling-window-suite', 'python', 'easy'),
  task('returns-validated-error-accumulation', 'python', 'easy'),
  task('psd-tools-blend-range-api', 'python', 'easy'),
  task('aiomonitor-task-snapshots-diff', 'python', 'easy'),
  task('koota-entity-snapshot-rollback', 'python', 'easy'),
  task('adaptix-name-mapping-aliases', 'python', 'easy'),
  task('numba-stencil-boundary-modes', 'python', 'easy'),
  task('textual-richlog-follow-state', 'python', 'easy'),
  task('tomlkit-toml-table-converters', 'python', 'medium-easy'),
  task('cattrs-partial-structuring-recovery', 'python', 'medium-easy'),
  task('mobly-grouped-test-barriers', 'python', 'medium-easy'),
  task('httpx-multipart-response-parsing', 'python', 'medium-easy'),
  task('ipython-session-bundle-replay', 'python', 'medium-easy'),
  task('mnamer-daemon-watch-lifecycle', 'python', 'medium-easy'),
  task('kombu-single-active-consumer-priority', 'python', 'medium-easy'),
  task('skrub-duration-encoding', 'python', 'medium-easy'),
  task('sqlite-utils-safe-import-checkpoints', 'python', 'medium-easy'),
  task('fastapi-implicit-head-options', 'python', 'medium-hard'),
  task('mashumaro-flattened-dataclass-fields', 'python', 'medium-hard'),
  task('bandit-interprocedural-taint-checks', 'python', 'medium-hard'),
  task('igel-persist-feature-schema', 'python', 'medium-hard'),
  task('bandit-incremental-cache-control', 'python', 'medium-hard'),
  task('fastapi-deprecation-response-headers', 'python', 'medium-hard'),
  task('dateutil-rfc5545-timezone-interop', 'python', 'medium-hard'),
  task('httpx-streaming-json-iteration', 'python', 'medium-hard'),
  task('textual-kitty-key-phases', 'python', 'hard'),
  task('pwntools-tube-multiplexing', 'python', 'hard'),
  task('langchain-request-coalescing', 'python', 'hard'),
  task('python-statemachine-state-data-scoping', 'python', 'hard'),
  task('vulture-persistent-analysis-cache', 'python', 'hard'),
  task('kombu-virtual-queue-dead-lettering', 'python', 'hard'),
  task('sqlfmt-create-table-ddl-formatting', 'python', 'hard'),
  task('bandit-structured-nosec-directives', 'python', 'hard'),
  task('gql-incremental-graphql-delivery', 'python', 'hard'),
  // typescript
  task('true-myth-iterable-collection-combinators', 'typescript', 'easy'),
  task('happy-dom-abort-pending-body-reads', 'typescript', 'easy'),
  task('drizzle-orm-window-function-builders', 'typescript', 'easy'),
  task('ofetch-per-origin-circuit-breaker', 'typescript', 'easy'),
  task('httpx-deterministic-cookie-store', 'typescript', 'easy'),
  task('sql-formatter-bigquery-pipe-formatting', 'typescript', 'easy'),
  task(
    'dynamodb-toolbox-conditional-attribute-requirements',
    'typescript',
    'easy',
  ),
  task('vitest-duration-sharding', 'typescript', 'easy'),
  task('query-persist-restored-query-state', 'typescript', 'medium-easy'),
  task('dynamodb-toolbox-lazy-recursive-schemas', 'typescript', 'medium-easy'),
  task('ts-pattern-match-each', 'typescript', 'medium-easy'),
  task('obsidian-linter-scoped-ignore-markers', 'typescript', 'medium-easy'),
  task('valibot-recursive-schema-composition', 'typescript', 'medium-easy'),
  task('kysely-window-grouping-helpers', 'typescript', 'medium-easy'),
  task(
    'claude-code-by-agents-recursive-delegation',
    'typescript',
    'medium-easy',
  ),
  task('cliffy-config-file-parsing', 'typescript', 'medium-easy'),
  task('arktype-json-schema-refs-dependencies', 'typescript', 'medium-easy'),
  task('optique-conditional-option-dependencies', 'typescript', 'medium-hard'),
  task('clack-async-autocomplete-options', 'typescript', 'medium-hard'),
  task('eicrud-keyset-pagination-cursor', 'typescript', 'medium-hard'),
  task('koota-composite-trait-aspects', 'typescript', 'medium-hard'),
  task('kea-atomic-signal-selectors', 'typescript', 'medium-hard'),
  task('awilix-async-container-initialization', 'typescript', 'medium-hard'),
  task('superjson-error-stack-serialization', 'typescript', 'medium-hard'),
  task(
    'happy-dom-deterministic-intersectionobserver',
    'typescript',
    'medium-hard',
  ),
  task('ink-grid-box-layout', 'typescript', 'medium-hard'),
  task('koota-deferred-mutation-buffer', 'typescript', 'hard'),
  task('quill-shared-toolbar-focus', 'typescript', 'hard'),
  task('obsidian-linter-link-format-conversion', 'typescript', 'hard'),
  task('koota-query-predicates', 'typescript', 'hard'),
  task('prometheus-transactional-reload-status', 'typescript', 'hard'),
  task('koota-pair-relation-tracking', 'typescript', 'hard'),
  task('meriyah-explicit-resource-declarations', 'typescript', 'hard'),
  task('effect-sse-httpapi-streaming', 'typescript', 'hard'),
  task('obsidian-linter-auto-table-of-contents', 'typescript', 'hard'),
  // rust
  task('wasmi-trap-coredumps', 'rust', 'easy'),
  task('fd-deterministic-multi-key-sorting', 'rust', 'medium-easy'),
  task('boa-hierarchical-evaluation-cancellation', 'rust', 'medium-hard'),
  task('pest-character-class-coalescing', 'rust', 'hard'),
  task('oxvg-structural-selector-preservation', 'rust', 'hard'),
  // javascript
  task('yjs-map-conflict-detection', 'javascript', 'easy'),
  task('testem-per-launcher-reports', 'javascript', 'medium-easy'),
  task('katex-multicolumn-array-spans', 'javascript', 'medium-hard'),
  task('csstree-shorthand-expansion-compression', 'javascript', 'hard'),
  task('testem-bail-on-test-failure', 'javascript', 'hard'),
];

export const DEEP_SWE_TASK_SET_HASH = sha256(stableJson(DEEP_SWE_TASKS));

if (DEEP_SWE_TASKS.length !== 113) {
  throw new Error(`Expected 113 tasks, received ${DEEP_SWE_TASKS.length}.`);
}
