import type { PRDetailsResult } from '../../types';
import type { CIStatus, QueriesConfig } from './types';

export async function getPRForIssue(
  config: QueriesConfig,
  issueNumber: number,
): Promise<PRDetailsResult> {
  const { octokit, owner, repo } = config;

  const closingPattern = buildClosingKeywordPattern(issueNumber);

  const { data: pullRequests } = await octokit.pulls.list({
    owner,
    repo,
    state: 'open',
    per_page: 100,
  });

  const matchingPRs = pullRequests
    .filter((pr) => pr.body != null && closingPattern.test(pr.body))
    .sort((a, b) => a.number - b.number);

  const linkedPR = matchingPRs[0];

  if (!linkedPR) {
    return null;
  }

  const { data: prDetail } = await octokit.pulls.get({
    owner,
    repo,
    pull_number: linkedPR.number,
  });

  const ciStatus = await deriveCIStatus(config, prDetail.head.sha);

  return {
    number: prDetail.number,
    title: prDetail.title,
    changedFilesCount: prDetail.changed_files,
    ciStatus,
    url: prDetail.html_url,
  };
}

/**
 * Matches GitHub closing keywords (`Close`, `Closed`, `Closes`, `Fix`, `Fixed`, `Fixes`,
 * `Resolve`, `Resolved`, `Resolves`) followed by `#<N>` with word-boundary semantics.
 * Case-insensitive. `#<N>` must be followed by whitespace, punctuation, or end of line.
 */
export function buildClosingKeywordPattern(issueNumber: number): RegExp {
  return new RegExp(
    `(?:close[sd]?|fix(?:e[sd])?|resolve[sd]?)\\s+#${issueNumber}(?=[\\s.,;:!?)\\]}]|$)`,
    'im',
  );
}

async function deriveCIStatus(config: QueriesConfig, headSHA: string): Promise<CIStatus> {
  const { octokit, owner, repo } = config;

  try {
    const { data: combinedStatus } = await octokit.repos.getCombinedStatusForRef({
      owner,
      repo,
      ref: headSHA,
    });

    const { data: checkRuns } = await octokit.checks.listForRef({
      owner,
      repo,
      ref: headSHA,
    });

    const FAILURE_CONCLUSIONS = new Set(['failure', 'cancelled', 'timed_out']);

    // failure: combined status failure, or any check run with a failure conclusion
    if (combinedStatus.state === 'failure') {
      return 'failure';
    }
    if (checkRuns.check_runs.some((run) => FAILURE_CONCLUSIONS.has(run.conclusion ?? ''))) {
      return 'failure';
    }

    // pending: any incomplete check run, or combined status pending (with real statuses),
    // or no CI configured at all (both endpoints zero)
    if (checkRuns.check_runs.some((run) => run.status !== 'completed')) {
      return 'pending';
    }
    if (combinedStatus.total_count > 0 && combinedStatus.state === 'pending') {
      return 'pending';
    }
    if (combinedStatus.total_count === 0 && checkRuns.total_count === 0) {
      return 'pending';
    }

    // success: combined status success (or no statuses) and all check runs succeeded
    const combinedOK = combinedStatus.state === 'success' || combinedStatus.total_count === 0;
    const checksOK =
      checkRuns.total_count === 0 ||
      checkRuns.check_runs.every((run) => run.conclusion === 'success');

    if (combinedOK && checksOK) {
      return 'success';
    }

    return 'pending';
  } catch {
    return 'pending';
  }
}
