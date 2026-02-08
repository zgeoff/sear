export type ResolvedEngineConfig = {
  repository: string;
  githubAppID: number;
  githubAppPrivateKeyPath: string;
  githubAppInstallationID: number;
  logLevel: 'debug' | 'info' | 'error';
  shutdownTimeout: number;
  issuePoller: {
    pollInterval: number;
  };
  specPoller: {
    pollInterval: number;
    specsDir: string;
    defaultBranch: string;
  };
  agents: {
    agentFilePlanner: string;
    agentFileImplementor: string;
    agentFileReviewer: string;
    maxAgentDuration: number;
  };
};
