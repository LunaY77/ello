import { access, readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const designPath = path.join(root, 'docs', 'functional-design.md');
const testDesignPath = path.join(root, 'docs', 'test-design.md');
const [design, testDesign] = await Promise.all([
  readFile(designPath, 'utf8'),
  readFile(testDesignPath, 'utf8'),
]);

const idPattern = /\bF-[A-Z]+-\d{2}\b/gu;
const designIds = uniqueMatches(design, idPattern);
const testIds = uniqueMatches(testDesign, idPattern);
const missingTests = difference(designIds, testIds);
const undocumentedTests = difference(testIds, designIds);

if (missingTests.length > 0 || undocumentedTests.length > 0) {
  fail([
    ...(missingTests.length === 0
      ? []
      : [`功能文档中存在未进入测试矩阵的 ID：${missingTests.join(', ')}`]),
    ...(undocumentedTests.length === 0
      ? []
      : [`测试矩阵中存在无功能设计的 ID：${undocumentedTests.join(', ')}`]),
  ]);
}

const rows = testDesign
  .split('\n')
  .filter((line) => /^\| `F-[A-Z]+-\d{2}` \|/u.test(line));
const rowIds = new Set();
const missingPaths = [];
for (const row of rows) {
  const id = row.match(idPattern)?.[0];
  if (id === undefined) continue;
  if (rowIds.has(id)) fail([`测试矩阵存在重复功能行：${id}`]);
  rowIds.add(id);
  const paths = [...row.matchAll(/`((?:packages|scripts|eslint\.)[^`]+)`/gu)]
    .map((match) => match[1])
    .filter((value) => value !== undefined);
  if (paths.length === 0) {
    missingPaths.push(`${id}: 未声明测试或静态检查路径`);
    continue;
  }
  for (const relativePath of paths) {
    try {
      await access(path.join(root, relativePath));
    } catch {
      missingPaths.push(`${id}: ${relativePath}`);
    }
  }
}

const missingRows = difference(designIds, rowIds);
const testLayoutErrors = await verifyTestLayout();
if (
  missingRows.length > 0 ||
  missingPaths.length > 0 ||
  testLayoutErrors.length > 0
) {
  fail([
    ...(missingRows.length === 0
      ? []
      : [`以下功能没有唯一测试矩阵行：${missingRows.join(', ')}`]),
    ...missingPaths.map((entry) => `测试路径不存在：${entry}`),
    ...testLayoutErrors,
  ]);
}

process.stdout.write(
  `功能契约检查通过：${designIds.size} 个功能均有设计和测试映射。\n`,
);

function uniqueMatches(content, pattern) {
  return new Set(content.match(pattern) ?? []);
}

function difference(left, right) {
  return [...left].filter((value) => !right.has(value)).sort();
}

function fail(messages) {
  throw new Error(`功能契约检查失败：\n- ${messages.join('\n- ')}`);
}

async function verifyTestLayout() {
  const errors = [];
  for (const packageName of ['ello-agent', 'ello-tui']) {
    const packageRoot = path.join(root, 'packages', packageName);
    for (const relativePath of await testFiles(packageRoot)) {
      if (!/^tests\/[^/]+\/.+\.test\.tsx?$/u.test(relativePath)) {
        errors.push(
          `测试文件必须位于 packages/${packageName}/tests/<功能模块>/：${relativePath}`,
        );
      }
    }
  }
  return errors;
}

async function testFiles(packageRoot) {
  const files = [];
  for (const directory of ['src', 'tests']) {
    const searchRoot = path.join(packageRoot, directory);
    const entries = await readdir(searchRoot, {
      recursive: true,
      withFileTypes: true,
    });
    files.push(
      ...entries
        .filter((entry) => entry.isFile() && /\.test\.tsx?$/u.test(entry.name))
        .map((entry) =>
          path.relative(packageRoot, path.join(entry.parentPath, entry.name)),
        ),
    );
  }
  return files;
}
