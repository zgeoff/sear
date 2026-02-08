export type ResolvedIssuePollerConfig = {
  pollInterval: number;
};

export type ResolvedSpecPollerConfig = {
  pollInterval: number;
  specsDir: string;
  defaultBranch: string;
};

export type ResolvedAgentsConfig = {
  agentPlanner: string;
  agentImplementor: string;
  agentReviewer: string;
  maxAgentDuration: number;
};

export type ResolvedLoggingConfig = {
  agentSessions: boolean;
  logsDir: string;
};

export type ResolvedEngineConfig = {
  repository: string;
  githubAppID: number;
  githubAppPrivateKeyPath: string;
  githubAppInstallationID: number;
  logLevel: 'debug' | 'info' | 'error';
  shutdownTimeout: number;
  issuePoller: ResolvedIssuePollerConfig;
  specPoller: ResolvedSpecPollerConfig;
  agents: ResolvedAgentsConfig;
  logging: ResolvedLoggingConfig;
};
