import type { EngineConfig } from './src/types';

const config: EngineConfig = {
  // Required: GitHub repository in owner/repo format
  repository: 'owner/repo',

  // Required: GitHub App credentials
  githubAppID: 123456,
  githubAppPrivateKeyPath: './private-key.pem',
  githubAppInstallationID: 789012,

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
  // agents: {
  //   agentFilePlanner: '.claude/agents/planner.md',
  //   agentFileImplementor: '.claude/agents/implementor.md',
  //   agentFileReviewer: '.claude/agents/reviewer.md',
  //   maxAgentDuration: 1800, // seconds before agent is cancelled
  // },
};

export default config;
