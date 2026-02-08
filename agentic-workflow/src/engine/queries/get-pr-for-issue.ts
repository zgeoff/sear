import type { PRDetailsResult } from '../../types.js';
import type { CIStatus, QueriesConfig } from './types.js';

export async function getPRForIssue(
  config: QueriesConfig,
  issueNumber: number,
): Promise<PRDetailsResult> {
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

    if (combinedStatus.total_count > 0 && combinedStatus.state === 'success') {
      ciStatus = 'success';
    }
    if (combinedStatus.total_count > 0 && combinedStatus.state === 'failure') {
      ciStatus = 'failure';
    }

    // Also check check runs (GitHub Actions use check runs, not statuses)
    const { data: checkRuns } = await octokit.checks.listForRef({
      owner,
      repo,
      ref: prDetail.head.sha,
    });

    if (checkRuns.total_count > 0) {
      const allCompleted = checkRuns.check_runs.every((run) => run.status === 'completed');
      const allSuccess =
        allCompleted &&
        checkRuns.check_runs.every(
          (run) => run.conclusion === 'success' || run.conclusion === 'skipped',
        );

      if (!allCompleted) {
        ciStatus = 'pending';
      } else if (allSuccess) {
        ciStatus = 'success';
      } else {
        ciStatus = 'failure';
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

/**
 * Matches `Closes #<N>` with word-boundary semantics:
 * `#<N>` must be followed by whitespace, punctuation, or end of line (not additional digits).
 */
export function buildClosesPattern(issueNumber: number): RegExp {
  return new RegExp(`Closes #${issueNumber}(?=[\\s.,;:!?)\\]}]|$)`, 'm');
}
