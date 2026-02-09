import type { EngineConfig } from './src/types.ts';

const config: EngineConfig = {
  // Required: GitHub repository in owner/repo format
  repository: 'zgeoff/sear',

  // Required: GitHub App credentials
  githubAppID: 2_801_903,
  githubAppPrivateKeyPath: './private-key.pem',
  githubAppInstallationID: 108_185_071,

  logging: {
    agentSessions: true,
  },

  // Optional: Logging verbosity (default: 'info')
  // logLevel: 'debug',

  // Optional: Seconds to wait for agents during shutdown (default: 300)
  // shutdownTimeout: 300,

  // Optional: IssuePoller settings
  // issuePoller: {
  //   pollInterval: 30, // seconds between poll cycles
  // },

  // Optional: SpecPoller settings
  // specPoller: {
  //   pollInterval: 60,        // seconds between poll cycles
  //   specsDir: 'docs/specs/', // path to specs directory (relative to repo root)
  //   defaultBranch: 'main',   // branch to monitor for spec changes
  // },

  // Optional: Agent settings
  agents: {
    agentPlanner: 'planner',
    agentImplementor: 'implementor',
    agentReviewer: 'reviewer',
    maxAgentDuration: 1800, // seconds before agent is cancelled
  },
};

// biome-ignore lint/style/noDefaultExport: config files use default export by convention
export default config;
