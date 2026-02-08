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
    agentFilePlanner: '.claude/agents/planner.md',
    agentFileImplementor: '.claude/agents/implementor.md',
    agentFileReviewer: '.claude/agents/reviewer.md',
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
      agentFilePlanner: config.agents?.agentFilePlanner ?? DEFAULTS.agents.agentFilePlanner,
      agentFileImplementor:
        config.agents?.agentFileImplementor ?? DEFAULTS.agents.agentFileImplementor,
      agentFileReviewer: config.agents?.agentFileReviewer ?? DEFAULTS.agents.agentFileReviewer,
      maxAgentDuration: config.agents?.maxAgentDuration ?? DEFAULTS.agents.maxAgentDuration,
    },
    logging: {
      agentSessions: config.logging?.agentSessions ?? DEFAULTS.logging.agentSessions,
      logsDir: config.logging?.logsDir ?? DEFAULTS.logging.logsDir,
    },
  };
}
