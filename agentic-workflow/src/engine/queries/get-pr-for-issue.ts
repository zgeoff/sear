import type { PRDetailsResult } from '../../types.ts';
import type { CIStatus, QueriesConfig } from './types.ts';

export async function getPRForIssue(
  config: QueriesConfig,
  issueNumber: number,
  options?: { includeDrafts?: boolean },
): Promise<PRDetailsResult> {
  const { octokit, owner, repo } = config;
  const includeDrafts = options?.includeDrafts ?? false;

  const closingPattern = buildClosingKeywordPattern(issueNumber);

  const { data: pullRequests } = await octokit.pulls.list({
    owner,
    repo,
    state: 'open',
    per_page: 100,
  });

  const matchingPRs = pullRequests
    .filter((pr) => pr.body !== null && closingPattern.test(pr.body))
    .filter((pr) => includeDrafts || !pr.draft)
    .sort((a, b) => a.number - b.number);

  const linkedPr = matchingPRs[0];

  if (!linkedPr) {
    return null;
  }

  const { data: prDetail } = await octokit.pulls.get({
    owner,
    repo,
    pull_number: linkedPr.number,
  });

  const ciStatus = await deriveCiStatus(config, prDetail.head.sha);

  return {
    number: prDetail.number,
    title: prDetail.title,
    changedFilesCount: prDetail.changed_files,
    ciStatus,
    url: prDetail.html_url,
    isDraft: prDetail.draft,
    headRefName: prDetail.head.ref,
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

async function deriveCiStatus(config: QueriesConfig, headSha: string): Promise<CIStatus> {
  const { octokit, owner, repo } = config;

  try {
    const { data: combinedStatus } = await octokit.repos.getCombinedStatusForRef({
      owner,
      repo,
      ref: headSha,
    });

    const { data: checkRuns } = await octokit.checks.listForRef({
      owner,
      repo,
      ref: headSha,
    });

    const FailureConclusions = new Set(['failure', 'cancelled', 'timed_out']);

    // failure: combined status failure, or any check run with a failure conclusion
    if (combinedStatus.state === 'failure') {
      return 'failure';
    }
    if (checkRuns.check_runs.some((run) => FailureConclusions.has(run.conclusion ?? ''))) {
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
    const combinedOk = combinedStatus.state === 'success' || combinedStatus.total_count === 0;
    const checksOk =
      checkRuns.total_count === 0 ||
      checkRuns.check_runs.every((run) => run.conclusion === 'success');

    if (combinedOk && checksOk) {
      return 'success';
    }

    return 'pending';
  } catch {
    return 'pending';
  }
}
