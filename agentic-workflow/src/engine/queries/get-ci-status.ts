import type { CICheckRun, CIStatusResult } from '../../types.ts';
import type { CIStatus, QueriesConfig } from './types.ts';

export async function getCIStatus(
  config: QueriesConfig,
  prNumber: number,
): Promise<CIStatusResult> {
  const { octokit, owner, repo } = config;

  const { data: prDetail } = await octokit.pulls.get({
    owner,
    repo,
    pull_number: prNumber,
  });

  const headSha = prDetail.head.sha;

  const overall = await deriveCiStatus(config, headSha);
  const failedCheckRuns = await getFailedCheckRuns(config, headSha, overall);

  return {
    overall,
    failedCheckRuns,
  };
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

async function getFailedCheckRuns(
  config: QueriesConfig,
  headSha: string,
  overall: CIStatus,
): Promise<CICheckRun[]> {
  if (overall !== 'failure') {
    return [];
  }

  const { octokit, owner, repo } = config;

  try {
    const { data: checkRuns } = await octokit.checks.listForRef({
      owner,
      repo,
      ref: headSha,
    });

    const FailureConclusions = new Set(['failure', 'cancelled', 'timed_out']);

    return checkRuns.check_runs
      .filter((run) => FailureConclusions.has(run.conclusion ?? ''))
      .map((run) => ({
        name: run.name ?? '',
        status: normalizeStatus(run.status),
        conclusion: normalizeConclusion(run.conclusion),
        detailsURL: run.details_url ?? '',
      }));
  } catch {
    return [];
  }
}

function normalizeStatus(status: string): 'queued' | 'in_progress' | 'completed' {
  if (status === 'queued' || status === 'in_progress' || status === 'completed') {
    return status;
  }
  return 'queued';
}

function normalizeConclusion(
  conclusion: string | null,
):
  | 'success'
  | 'failure'
  | 'cancelled'
  | 'timed_out'
  | 'action_required'
  | 'neutral'
  | 'skipped'
  | 'stale'
  | null {
  if (conclusion === null) {
    return null;
  }

  const validConclusions = new Set([
    'success',
    'failure',
    'cancelled',
    'timed_out',
    'action_required',
    'neutral',
    'skipped',
    'stale',
  ]);

  if (validConclusions.has(conclusion)) {
    return conclusion as
      | 'success'
      | 'failure'
      | 'cancelled'
      | 'timed_out'
      | 'action_required'
      | 'neutral'
      | 'skipped'
      | 'stale';
  }

  return null;
}
