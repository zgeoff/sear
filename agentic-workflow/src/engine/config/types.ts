export interface ResolvedIssuePollerConfig {
  pollInterval: number;
}

export interface ResolvedSpecPollerConfig {
  pollInterval: number;
  specsDir: string;
  defaultBranch: string;
}

export interface ResolvedAgentsConfig {
  agentPlanner: string;
  agentImplementor: string;
  agentReviewer: string;
  maxAgentDuration: number;
}

export interface ResolvedLoggingConfig {
  agentSessions: boolean;
  logsDir: string;
}

export interface ResolvedPRPollerConfig {
  pollInterval: number;
}

export interface ResolvedEngineConfig {
  repository: string;
  githubAppID: number;
  githubAppPrivateKeyPath: string;
  githubAppInstallationID: number;
  logLevel: 'debug' | 'info' | 'error';
  shutdownTimeout: number;
  issuePoller: ResolvedIssuePollerConfig;
  specPoller: ResolvedSpecPollerConfig;
  prPoller: ResolvedPRPollerConfig;
  agents: ResolvedAgentsConfig;
  logging: ResolvedLoggingConfig;
}
