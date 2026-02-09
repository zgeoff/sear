import type { GitHubClient } from '../github-client/types.ts';

export interface QueriesConfig {
  octokit: GitHubClient;
  owner: string;
  repo: string;
}

export type CIStatus = 'pending' | 'success' | 'failure';
