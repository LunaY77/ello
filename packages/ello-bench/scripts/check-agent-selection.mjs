#!/usr/bin/env node
// 校验本次选择的 agent 集合与 run root 首次创建时冻结的集合一致。
//
//   node check-agent-selection.mjs <run-root> "<agent id 列表，空格分隔>"
//
// 为什么需要它：agent 集合决定 job 矩阵，而 suite-manifest.json 的 jobs 数组在
// run root 创建时就冻结了。往已有 run root 里加 agent 会凭空长出 attempt，之后
// ello-bench validate 必然报「Attempt job is not in the suite matrix」。
//
// 退出码：0 一致（或选择为空，只告警）；2 不一致或读不到 manifest。
import { readFile } from 'node:fs/promises';
import path from 'node:path';

const [runRoot, rawSelection = ''] = process.argv.slice(2);
if (runRoot === undefined) {
  console.error(
    'Usage: node check-agent-selection.mjs <run-root> "<agent-id> [<agent-id>...]"',
  );
  process.exit(2);
}

const manifestPath = path.join(path.resolve(runRoot), 'suite-manifest.json');
let manifest;
try {
  manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
} catch (error) {
  console.error(`Cannot read ${manifestPath}: ${error.message}`);
  process.exit(2);
}

const frozen = (manifest.agents ?? []).map((agent) => agent.id).sort();
const selection = rawSelection.trim();
if (selection === '') {
  console.error(
    'warning: 未指定 AGENTS，将按 --all-agents 展开，可能给 run root 增加新 agent',
  );
  process.exit(0);
}

const selected = [...new Set(selection.split(/\s+/))].sort();
if (selected.join(' ') === frozen.join(' ')) process.exit(0);

console.error('error: agent 集合与 run root 不一致，resume 拒绝执行');
console.error(`  run root 冻结的：${frozen.join(' ')}`);
console.error(`  本次选择的：    ${selected.join(' ')}`);
console.error(
  `  改用 AGENTS='${frozen.join(' ')}'，或 make fresh 开新 run root，或 ALLOW_MATRIX_CHANGE=1 强制继续`,
);
process.exit(2);
