import { agents } from './agents.config.mjs';
import { report } from './report.config.mjs';

export default {
  schema: 'ello.benchmark.config.v1',
  suite: 'deep-swe-v1.1',
  execution: {
    runtime: 'docker',
    replicates: 1,
    concurrency: 4,
    maxInfrastructureRetries: 1,
  },
  report,
  agents,
};
