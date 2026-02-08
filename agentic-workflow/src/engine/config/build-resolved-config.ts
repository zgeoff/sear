import type { EngineConfig } from '../../types';
import type { ResolvedEngineConfig } from './types';

const DEFAULTS = {
  logLevel: 'info' as const,
  shutdownTimeout: 300,
  issuePoller: {
    pollInterval: 30,
  },
  specPoller: {
    pollInterval: 60,
    specsDir: 'docs/specs/',
    defaultBranch: 'main',
  },
  agents: {
    agentPlanner: 'planner',
    agentImplementor: 'implementor',
    agentReviewer: 'reviewer',
    maxAgentDuration: 1800,
  },
  logging: {
    agentSessions: false,
    logsDir: 'logs',
  },
};

export function buildResolvedConfig(config: EngineConfig): ResolvedEngineConfig {
  return {
    repository: config.repository,
    githubAppID: config.githubAppID,
    githubAppPrivateKeyPath: config.githubAppPrivateKeyPath,
    githubAppInstallationID: config.githubAppInstallationID,
    logLevel: config.logLevel ?? DEFAULTS.logLevel,
    shutdownTimeout: config.shutdownTimeout ?? DEFAULTS.shutdownTimeout,
    issuePoller: {
      pollInterval: config.issuePoller?.pollInterval ?? DEFAULTS.issuePoller.pollInterval,
    },
    specPoller: {
      pollInterval: config.specPoller?.pollInterval ?? DEFAULTS.specPoller.pollInterval,
      specsDir: config.specPoller?.specsDir ?? DEFAULTS.specPoller.specsDir,
      defaultBranch: config.specPoller?.defaultBranch ?? DEFAULTS.specPoller.defaultBranch,
    },
    agents: {
      agentPlanner: config.agents?.agentPlanner ?? DEFAULTS.agents.agentPlanner,
      agentImplementor: config.agents?.agentImplementor ?? DEFAULTS.agents.agentImplementor,
      agentReviewer: config.agents?.agentReviewer ?? DEFAULTS.agents.agentReviewer,
      maxAgentDuration: config.agents?.maxAgentDuration ?? DEFAULTS.agents.maxAgentDuration,
    },
    logging: {
      agentSessions: config.logging?.agentSessions ?? DEFAULTS.logging.agentSessions,
      logsDir: config.logging?.logsDir ?? DEFAULTS.logging.logsDir,
    },
  };
}
