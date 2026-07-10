import { describe, expect, it } from 'vitest';

import * as codingAgent from '../index.js';

describe('@ello/coding-agent public API', () => {
  it('只暴露稳定产品入口', () => {
    expect(Object.keys(codingAgent).sort()).toEqual([
      'ApprovalModeSchema',
      'CodingAgentConfigSchema',
      'PermissionRuleSchema',
      'buildProgram',
      'createCodingSession',
      'getProjectConfigPath',
      'launchTui',
      'loadCodingAgentConfig',
      'normalizeApprovalMode',
      'runCli',
    ]);
  });
});
