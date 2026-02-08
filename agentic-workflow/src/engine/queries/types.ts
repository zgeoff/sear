import type { GitHubClient } from '../github-client.js';

export type QueriesConfig = {
  octokit: GitHubClient;
  owner: string;
  repo: string;
};

export type CIStatus = 'pending' | 'success' | 'failure';
