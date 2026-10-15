import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

import type { SuiteReport } from '../../domain/contract/index.js';
import { renderCharts } from '../../render/chart/svg.js';
import { renderMarkdown } from '../../render/markdown.js';

export async function renderReport(
  runRootInput: string,
  report: SuiteReport,
): Promise<readonly string[]> {
  const runRoot = path.resolve(runRootInput);
  const resultsRoot = path.join(runRoot, 'results');
  const chartsRoot = path.join(resultsRoot, 'charts');
  const renderedAt = new Date().toISOString();
  const provenance = `runRoot=${runRoot} configHash=${report.configHash.slice(0, 12)} reportGeneratedAt=${report.generatedAt} renderedAt=${renderedAt}`;
  const reportPath = path.join(resultsRoot, 'report.md');
  await mkdir(resultsRoot, { recursive: true });
  await writeFile(
    reportPath,
    renderMarkdown(report, runRoot, provenance),
    'utf8',
  );
  if (!report.reportConfig.renderCharts) return [reportPath];
  await mkdir(chartsRoot, { recursive: true });
  const chartEntries = Object.entries(renderCharts(report));
  await Promise.all(
    chartEntries.map(([name, content]) =>
      writeFile(path.join(chartsRoot, name), content, 'utf8'),
    ),
  );
  return [
    reportPath,
    ...chartEntries.map(([name]) => path.join(chartsRoot, name)),
  ];
}
