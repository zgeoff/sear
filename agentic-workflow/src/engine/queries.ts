import type { Octokit } from '@octokit/rest';
import type { IssueDetailsResult, PRDetailsResult } from '../types.js';

type QueriesConfig = {
  octokit: Octokit;
  owner: string;
  repo: string;
};

type CIStatus = 'pending' | 'success' | 'failure';

/**
 * Matches `Closes #<N>` with word-boundary semantics:
 * `#<N>` must be followed by whitespace, punctuation, or end of line (not additional digits).
 */
function buildClosesPattern(issueNumber: number): RegExp {
  return new RegExp(`Closes #${issueNumber}(?=[\\s.,;:!?)\\]}]|$)`, 'm');
}

function mapCIStatus(conclusion: string | null, status: string): CIStatus {
  if (status !== 'completed') {
    return 'pending';
  }
  if (conclusion === 'success') {
    return 'success';
  }
  return 'failure';
}

async function getIssueDetails(
  config: QueriesConfig,
  issueNumber: number,
): Promise<IssueDetailsResult> {
  const { octokit, owner, repo } = config;

  const { data } = await octokit.issues.get({
    owner,
    repo,
    issue_number: issueNumber,
  });

  return {
    number: data.number,
    title: data.title,
    body: data.body ?? '',
    labels: data.labels.map((label) => (typeof label === 'string' ? label : (label.name ?? ''))),
    createdAt: data.created_at,
  };
}

async function getPRForIssue(config: QueriesConfig, issueNumber: number): Promise<PRDetailsResult> {
  const { octokit, owner, repo } = config;

  const closesPattern = buildClosesPattern(issueNumber);

  const { data: pullRequests } = await octokit.pulls.list({
    owner,
    repo,
    state: 'open',
    per_page: 100,
  });

  const linkedPR = pullRequests.find((pr) => pr.body != null && closesPattern.test(pr.body));

  if (!linkedPR) {
    return null;
  }

  const { data: prDetail } = await octokit.pulls.get({
    owner,
    repo,
    pull_number: linkedPR.number,
  });

  let ciStatus: CIStatus = 'pending';

  try {
    const { data: combinedStatus } = await octokit.repos.getCombinedStatusForRef({
      owner,
      repo,
      ref: prDetail.head.sha,
    });

    if (combinedStatus.total_count > 0) {
      ciStatus = mapCIStatus(null, combinedStatus.state === 'pending' ? 'pending' : 'completed');
      if (combinedStatus.state === 'success') {
        ciStatus = 'success';
      } else if (combinedStatus.state === 'failure') {
        ciStatus = 'failure';
      }
    }

    // Also check check runs (GitHub Actions use check runs, not statuses)
    const { data: checkRuns } = await octokit.checks.listForRef({
      owner,
      repo,
      ref: prDetail.head.sha,
    });

    if (checkRuns.total_count > 0) {
      const allCompleted = checkRuns.check_runs.every((run) => run.status === 'completed');
      if (!allCompleted) {
        ciStatus = 'pending';
      } else {
        const allSuccess = checkRuns.check_runs.every(
          (run) => run.conclusion === 'success' || run.conclusion === 'skipped',
        );
        ciStatus = allSuccess ? 'success' : 'failure';
      }
    }
  } catch {
    // If CI status check fails, default to pending
    ciStatus = 'pending';
  }

  return {
    number: prDetail.number,
    title: prDetail.title,
    changedFilesCount: prDetail.changed_files,
    ciStatus,
    url: prDetail.html_url,
  };
}

export { buildClosesPattern, getIssueDetails, getPRForIssue };
export type { CIStatus, QueriesConfig };
