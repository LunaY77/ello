import { agents } from './agents.config.mjs';
import { report } from './report.config.mjs';

export default {
  schema: 'ello.benchmark.config.v1',
  suite: 'swe-bench-pro-calibration',
  execution: {
    replicates: 1,
    concurrency: 2,
    maxInfrastructureRetries: 1,
  },
  report,
  agents,
};
