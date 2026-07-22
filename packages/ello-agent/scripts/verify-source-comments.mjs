import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

import ts from 'typescript';

const packageDir = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
);
const sourceRoots = [
  path.join(packageDir, 'src'),
  path.join(packageDir, 'tests'),
];
const chinesePattern = /[\u3400-\u9fff]/u;
const historicalPattern =
  /以前|之前|原来|本次|这次|为了兼容|暂时保留|后续再改|旧实现|旧命名|旧目录|迁移过程/u;
const lifecycleNames = new Set(['initialize', 'startRun', 'close']);
const summaryOnly = process.argv.includes('--summary');
const findings = [];

for (const filePath of await listTypeScriptFiles(sourceRoots)) {
  const sourceText = await readFile(filePath, 'utf8');
  const sourceFile = ts.createSourceFile(
    filePath,
    sourceText,
    ts.ScriptTarget.Latest,
    true,
    scriptKind(filePath),
  );
  verifyFileComment(sourceFile, sourceText, filePath);
  verifyDeclarations(sourceFile, filePath);
  verifyCommentLanguage(sourceFile, sourceText, filePath);
}

if (findings.length > 0) {
  const counts = Object.fromEntries(
    Object.entries(Object.groupBy(findings, (finding) => finding.kind)).map(
      ([kind, entries]) => [kind, entries.length],
    ),
  );
  console.error(
    `Source comment verification failed with ${findings.length} finding(s): ${JSON.stringify(counts)}`,
  );
  if (!summaryOnly) {
    for (const finding of findings) {
      console.error(
        `${path.relative(packageDir, finding.filePath)}:${finding.line}:${finding.column} ${finding.message}`,
      );
    }
  }
  process.exitCode = 1;
} else {
  console.log('Source comment verification passed.');
}

async function listTypeScriptFiles(roots) {
  const files = [];
  for (const root of roots) {
    for (const entry of await readdir(root, { withFileTypes: true })) {
      const target = path.join(root, entry.name);
      if (entry.isDirectory()) {
        files.push(...(await listTypeScriptFiles([target])));
      } else if (
        entry.isFile() &&
        (entry.name.endsWith('.ts') || entry.name.endsWith('.tsx'))
      ) {
        files.push(target);
      }
    }
  }
  return files.sort();
}

function scriptKind(filePath) {
  return filePath.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS;
}

function verifyFileComment(sourceFile, sourceText, filePath) {
  const firstStatement = sourceFile.statements[0];
  const leadingText = sourceText.slice(
    0,
    firstStatement === undefined
      ? sourceText.length
      : firstStatement.getStart(sourceFile),
  );
  if (!chinesePattern.test(leadingText) || !containsComment(leadingText)) {
    addFinding(
      sourceFile,
      filePath,
      0,
      'file-comment',
      '缺少位于首个声明之前的中文文件级职责说明。',
    );
  }
}

function verifyDeclarations(sourceFile, filePath) {
  const verified = new Set();
  visit(sourceFile);

  function visit(node) {
    if (ts.isFunctionDeclaration(node) && isExported(node)) {
      verifyCallable(node, node.name?.text ?? 'default export function');
    } else if (ts.isVariableStatement(node) && isExported(node)) {
      for (const declaration of node.declarationList.declarations) {
        if (
          declaration.initializer !== undefined &&
          (ts.isArrowFunction(declaration.initializer) ||
            ts.isFunctionExpression(declaration.initializer))
        ) {
          verifyCallable(node, declaration.name.getText(sourceFile));
        }
      }
    } else if (ts.isClassDeclaration(node) && isExported(node)) {
      for (const member of node.members) {
        if (hasModifier(member, ts.SyntaxKind.PrivateKeyword)) continue;
        if (hasModifier(member, ts.SyntaxKind.ProtectedKeyword)) continue;
        if (ts.isConstructorDeclaration(member)) {
          verifyDoc(
            member,
            `constructor ${node.name?.text ?? 'default export class'}`,
            {
              args: true,
              returns: false,
            },
          );
        } else if (ts.isGetAccessorDeclaration(member)) {
          verifyDoc(member, `getter ${member.name.getText(sourceFile)}`, {
            args: false,
            returns: true,
          });
        } else if (
          ts.isMethodDeclaration(member) ||
          ts.isSetAccessorDeclaration(member)
        ) {
          verifyCallable(member, member.name.getText(sourceFile));
        }
      }
    } else if (
      ts.isInterfaceDeclaration(node) &&
      filePath.includes(`${path.sep}features${path.sep}`)
    ) {
      for (const member of node.members) {
        if (ts.isMethodSignature(member)) {
          verifyCallable(member, member.name.getText(sourceFile));
        } else if (
          ts.isPropertySignature(member) &&
          member.type !== undefined &&
          ts.isFunctionTypeNode(member.type)
        ) {
          verifyCallable(member, member.name.getText(sourceFile));
        }
      }
    } else if (
      ts.isTypeAliasDeclaration(node) &&
      ts.isFunctionTypeNode(node.type)
    ) {
      verifyCallable(node, node.name.text);
    }

    if (isLifecycleDeclaration(node)) {
      verifyCallable(node, declarationName(node));
    }
    ts.forEachChild(node, visit);
  }

  function verifyCallable(node, name) {
    if (verified.has(node)) return;
    verified.add(node);
    verifyDoc(node, name, { args: true, returns: true });
  }

  function verifyDoc(node, name, requirements) {
    const docs = ts
      .getJSDocCommentsAndTags(node)
      .filter((comment) => ts.isJSDoc(comment));
    const text = docs.map((doc) => doc.getText(sourceFile)).join('\n');
    const missing = [];
    if (!chinesePattern.test(text)) missing.push('中文说明');
    if (requirements.args && !/\bArgs:/u.test(text)) missing.push('Args:');
    if (requirements.returns && !/\bReturns:/u.test(text)) {
      missing.push('Returns:');
    }
    if (missing.length > 0) {
      addFinding(
        sourceFile,
        filePath,
        node.getStart(sourceFile),
        'callable-doc',
        `${name} 缺少 ${missing.join('、')}。`,
      );
    }
  }
}

function isLifecycleDeclaration(node) {
  if (
    !ts.isFunctionDeclaration(node) &&
    !ts.isMethodDeclaration(node) &&
    !ts.isMethodSignature(node) &&
    !ts.isPropertySignature(node)
  ) {
    return false;
  }
  const name =
    'name' in node && node.name !== undefined ? node.name : undefined;
  return name !== undefined && lifecycleNames.has(name.getText());
}

function declarationName(node) {
  return 'name' in node && node.name !== undefined
    ? node.name.getText()
    : 'lifecycle function';
}

function isExported(node) {
  return (
    hasModifier(node, ts.SyntaxKind.ExportKeyword) ||
    hasModifier(node, ts.SyntaxKind.DefaultKeyword)
  );
}

function hasModifier(node, kind) {
  return node.modifiers?.some((modifier) => modifier.kind === kind) === true;
}

function verifyCommentLanguage(sourceFile, sourceText, filePath) {
  const scanner = ts.createScanner(
    ts.ScriptTarget.Latest,
    false,
    sourceFile.languageVariant,
    sourceText,
  );
  while (scanner.scan() !== ts.SyntaxKind.EndOfFileToken) {
    const token = scanner.getToken();
    if (
      token !== ts.SyntaxKind.SingleLineCommentTrivia &&
      token !== ts.SyntaxKind.MultiLineCommentTrivia
    ) {
      continue;
    }
    const comment = scanner.getTokenText();
    const match = comment.match(historicalPattern);
    if (match !== null) {
      addFinding(
        sourceFile,
        filePath,
        scanner.getTokenPos(),
        'historical-comment',
        `注释包含历史或过程性词语“${match[0]}”。`,
      );
    }
  }
}

function containsComment(text) {
  const scanner = ts.createScanner(
    ts.ScriptTarget.Latest,
    false,
    ts.LanguageVariant.Standard,
    text,
  );
  while (scanner.scan() !== ts.SyntaxKind.EndOfFileToken) {
    const token = scanner.getToken();
    if (
      token === ts.SyntaxKind.SingleLineCommentTrivia ||
      token === ts.SyntaxKind.MultiLineCommentTrivia
    ) {
      return true;
    }
  }
  return false;
}

function addFinding(sourceFile, filePath, position, kind, message) {
  const location = sourceFile.getLineAndCharacterOfPosition(position);
  findings.push({
    filePath,
    line: location.line + 1,
    column: location.character + 1,
    kind,
    message,
  });
}
