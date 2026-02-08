import type { GitHubClient } from '../github-client/types.js';

export type QueriesConfig = {
  octokit: GitHubClient;
  owner: string;
  repo: string;
};

export type CIStatus = 'pending' | 'success' | 'failure';
