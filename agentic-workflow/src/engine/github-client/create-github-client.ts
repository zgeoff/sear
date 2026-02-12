import { createAppAuth } from '@octokit/auth-app';
import { Octokit } from '@octokit/rest';
import type {
  ChecksListForRefParams,
  ChecksListForRefResult,
  GitGetRefParams,
  GitGetRefResult,
  GitGetTreeParams,
  GitGetTreeResult,
  GitHubClient,
  GitHubClientConfig,
  IssuesAddLabelsParams,
  IssuesAddLabelsResult,
  IssuesGetParams,
  IssuesGetResult,
  IssuesListForRepoParams,
  IssuesListForRepoResult,
  IssuesRemoveLabelParams,
  IssuesRemoveLabelResult,
  PullsGetParams,
  PullsGetResult,
  PullsListFilesParams,
  PullsListFilesResult,
  PullsListParams,
  PullsListResult,
  PullsListReviewCommentsParams,
  PullsListReviewCommentsResult,
  PullsListReviewsParams,
  PullsListReviewsResult,
  ReposGetCombinedStatusParams,
  ReposGetCombinedStatusResult,
  ReposGetContentParams,
  ReposGetContentResult,
} from './types.ts';

export function createGitHubClient(config: GitHubClientConfig): GitHubClient {
  const octokit = new Octokit({
    authStrategy: createAppAuth,
    auth: {
      appId: config.appID,
      privateKey: config.privateKey,
      installationId: config.installationID,
    },
  });

  return {
    issues: {
      async get(params: IssuesGetParams): Promise<IssuesGetResult> {
        const response = await octokit.issues.get(params);
        return {
          data: {
            number: response.data.number,
            title: response.data.title,
            body: response.data.body ?? null,
            labels: response.data.labels,
            created_at: response.data.created_at,
          },
        };
      },

      async listForRepo(params: IssuesListForRepoParams): Promise<IssuesListForRepoResult> {
        const response = await octokit.issues.listForRepo(params);
        return {
          data: response.data.map((issue) => ({
            number: issue.number,
            title: issue.title,
            body: issue.body ?? null,
            labels: issue.labels,
            created_at: issue.created_at,
          })),
        };
      },

      async addLabels(params: IssuesAddLabelsParams): Promise<IssuesAddLabelsResult> {
        const response = await octokit.issues.addLabels(params);
        return { data: response.data };
      },

      async removeLabel(params: IssuesRemoveLabelParams): Promise<IssuesRemoveLabelResult> {
        const response = await octokit.issues.removeLabel(params);
        return { data: response.data };
      },
    },

    pulls: {
      async list(params: PullsListParams): Promise<PullsListResult> {
        const response = await octokit.pulls.list(params);
        return {
          data: response.data.map((pr) => ({
            number: pr.number,
            title: pr.title,
            html_url: pr.html_url,
            user: pr.user,
            head: {
              sha: pr.head.sha,
              ref: pr.head.ref,
            },
            body: pr.body,
            draft: pr.draft ?? false,
          })),
        };
      },

      async get(params: PullsGetParams): Promise<PullsGetResult> {
        const response = await octokit.pulls.get(params);
        return {
          data: {
            number: response.data.number,
            title: response.data.title,
            changed_files: response.data.changed_files,
            html_url: response.data.html_url,
            head: { sha: response.data.head.sha, ref: response.data.head.ref },
            draft: response.data.draft ?? false,
          },
        };
      },

      async listFiles(params: PullsListFilesParams): Promise<PullsListFilesResult> {
        const response = await octokit.pulls.listFiles(params);
        return {
          data: response.data.map((file) => {
            const entry: { filename: string; status: string; patch?: string } = {
              filename: file.filename,
              status: file.status,
            };
            if (file.patch !== undefined) {
              entry.patch = file.patch;
            }
            return entry;
          }),
        };
      },

      async listReviews(params: PullsListReviewsParams): Promise<PullsListReviewsResult> {
        const response = await octokit.pulls.listReviews(params);
        return {
          data: response.data.map((review) => ({
            id: review.id,
            user: review.user,
            state: review.state,
            body: review.body,
          })),
        };
      },

      async listReviewComments(
        params: PullsListReviewCommentsParams,
      ): Promise<PullsListReviewCommentsResult> {
        const response = await octokit.pulls.listReviewComments(params);
        return {
          data: response.data.map((comment) => ({
            id: comment.id,
            user: comment.user,
            body: comment.body,
            path: comment.path,
            line: comment.line ?? null,
          })),
        };
      },
    },

    repos: {
      async getCombinedStatusForRef(
        params: ReposGetCombinedStatusParams,
      ): Promise<ReposGetCombinedStatusResult> {
        const response = await octokit.repos.getCombinedStatusForRef(params);
        return {
          data: {
            state: response.data.state,
            total_count: response.data.total_count,
          },
        };
      },

      async getContent(params: ReposGetContentParams): Promise<ReposGetContentResult> {
        const response = await octokit.repos.getContent(params);
        const data = response.data;
        if ('content' in data && data.content !== undefined) {
          return { data: { content: data.content } };
        }
        return { data: {} };
      },
    },

    checks: {
      async listForRef(params: ChecksListForRefParams): Promise<ChecksListForRefResult> {
        const response = await octokit.checks.listForRef(params);
        return {
          data: {
            total_count: response.data.total_count,
            check_runs: response.data.check_runs.map((run) => ({
              status: run.status,
              conclusion: run.conclusion,
            })),
          },
        };
      },
    },

    git: {
      async getTree(params: GitGetTreeParams): Promise<GitGetTreeResult> {
        const response = await octokit.git.getTree(params);
        return {
          data: {
            sha: response.data.sha,
            tree: response.data.tree.map((entry) => ({
              path: entry.path,
              sha: entry.sha,
              type: entry.type,
            })),
          },
        };
      },

      async getRef(params: GitGetRefParams): Promise<GitGetRefResult> {
        const response = await octokit.git.getRef(params);
        return {
          data: {
            object: { sha: response.data.object.sha },
          },
        };
      },
    },
  };
}
