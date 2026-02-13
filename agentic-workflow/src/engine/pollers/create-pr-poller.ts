import type { GitHubClient, PullsListItem } from '../github-client/types.ts';
import type { PRCIStatus, PRPoller, PRPollerConfig, PRSnapshotEntry } from './types.ts';

export function createPRPoller(config: PRPollerConfig): PRPoller {
  const snapshot = new Map<number, PRSnapshotEntry>();
  let intervalID: ReturnType<typeof setInterval> | null = null;

  async function poll(): Promise<void> {
    let pullsList: PullsListItem[];

    try {
      const response = await config.gitHubClient.pulls.list({
        owner: config.owner,
        repo: config.repo,
        state: 'open',
        per_page: 100,
      });
      pullsList = response.data;
    } catch {
      // pulls.list failed — skip entire cycle, snapshot unchanged
      return;
    }

    // Build lookup structures from the response
    const currentPRNumbers = new Set<number>();
    const responseSHAs = new Map<number, string>();

    for (const pr of pullsList) {
      currentPRNumbers.add(pr.number);
      responseSHAs.set(pr.number, pr.head.sha);
    }

    // Step 2: Update snapshot — remove absent PRs, add new, update metadata for existing
    removeAbsentPRs(snapshot, currentPRNumbers, config.onPRRemoved);
    updateSnapshotMetadata(snapshot, pullsList, config.onPRDetected);

    // Steps 3–6: CI status fetch + change reporting + snapshot update
    // Use Promise.allSettled to avoid sequential await in loop
    const ciResults = await Promise.allSettled(
      pullsList.map((pr) => fetchCIForPR(config, snapshot, responseSHAs, pr)),
    );

    applyCIResults(snapshot, pullsList, ciResults, config.onCIStatusChanged);
  }

  function getSnapshot(): Map<number, PRSnapshotEntry> {
    return snapshot;
  }

  function stop(): void {
    if (intervalID !== null) {
      clearInterval(intervalID);
      intervalID = null;
    }
  }

  return { poll, getSnapshot, stop };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function removeAbsentPRs(
  snapshot: Map<number, PRSnapshotEntry>,
  currentPRNumbers: Set<number>,
  onPRRemoved: (prNumber: number) => void,
): void {
  const removedPRNumbers: number[] = [];
  for (const prNumber of snapshot.keys()) {
    if (!currentPRNumbers.has(prNumber)) {
      removedPRNumbers.push(prNumber);
    }
  }

  for (const prNumber of removedPRNumbers) {
    snapshot.delete(prNumber);
    onPRRemoved(prNumber);
  }
}

function updateSnapshotMetadata(
  snapshot: Map<number, PRSnapshotEntry>,
  pullsList: PullsListItem[],
  onPRDetected: ((prNumber: number) => void) | undefined,
): void {
  for (const pr of pullsList) {
    const existing = snapshot.get(pr.number);

    if (existing) {
      // Existing PR — update non-CI metadata only; headSHA updated in step 6
      snapshot.set(pr.number, {
        ...existing,
        title: pr.title,
        url: pr.html_url,
        author: pr.user?.login ?? '',
        body: pr.body ?? '',
      });
    } else {
      // New PR — add with ciStatus: null, headSHA from response
      snapshot.set(pr.number, {
        number: pr.number,
        title: pr.title,
        url: pr.html_url,
        headSHA: pr.head.sha,
        author: pr.user?.login ?? '',
        body: pr.body ?? '',
        ciStatus: null,
      });
      if (onPRDetected) {
        onPRDetected(pr.number);
      }
    }
  }
}

interface CIFetchResult {
  prNumber: number;
  newCIStatus: PRCIStatus;
  responseSHA: string;
}

async function fetchCIForPR(
  config: PRPollerConfig,
  snapshot: Map<number, PRSnapshotEntry>,
  responseSHAs: Map<number, string>,
  pr: PullsListItem,
): Promise<CIFetchResult | null> {
  const entry = snapshot.get(pr.number);
  if (!entry) {
    return null;
  }

  const responseSHA = responseSHAs.get(pr.number);
  if (!responseSHA) {
    return null;
  }

  // Step 3: Determine if CI fetch is needed (skip optimization)
  const shaUnchanged = entry.headSHA === responseSHA;
  if (shaUnchanged && entry.ciStatus === 'success') {
    return null;
  }

  // CI fetch needed: null, pending, failure, or SHA changed
  const newCIStatus = await deriveCIStatus(
    config.gitHubClient,
    config.owner,
    config.repo,
    responseSHA,
  );

  return { prNumber: pr.number, newCIStatus, responseSHA };
}

function applyCIResults(
  snapshot: Map<number, PRSnapshotEntry>,
  pullsList: PullsListItem[],
  ciResults: PromiseSettledResult<CIFetchResult | null>[],
  onCIStatusChanged: PRPollerConfig['onCIStatusChanged'],
): void {
  for (let idx = 0; idx < pullsList.length; idx += 1) {
    const result = ciResults[idx];
    if (!result || result.status === 'rejected') {
      // CI fetch failed — retain previous snapshot entry
      // biome-ignore lint/nursery/noContinue: intentional skip for failed CI fetches
      continue;
    }

    const ciResult = result.value;
    if (!ciResult) {
      // CI fetch was skipped (success + unchanged SHA, or missing entry)
      // biome-ignore lint/nursery/noContinue: intentional skip for skipped CI fetches
      continue;
    }

    const entry = snapshot.get(ciResult.prNumber);
    if (!entry) {
      // biome-ignore lint/nursery/noContinue: defensive guard
      continue;
    }

    // Step 5: Compare derived CI status against stored value
    if (entry.ciStatus !== ciResult.newCIStatus) {
      onCIStatusChanged(ciResult.prNumber, entry.ciStatus, ciResult.newCIStatus);
    }

    // Step 6: Update snapshot — set headSHA and ciStatus together
    snapshot.set(ciResult.prNumber, {
      ...entry,
      headSHA: ciResult.responseSHA,
      ciStatus: ciResult.newCIStatus,
    });
  }
}

const FAILURE_CONCLUSIONS: Set<string> = new Set(['failure', 'cancelled', 'timed_out']);

async function deriveCIStatus(
  gitHubClient: GitHubClient,
  owner: string,
  repo: string,
  headSHA: string,
): Promise<PRCIStatus> {
  const { data: combinedStatus } = await gitHubClient.repos.getCombinedStatusForRef({
    owner,
    repo,
    ref: headSHA,
  });

  const { data: checkRuns } = await gitHubClient.checks.listForRef({
    owner,
    repo,
    ref: headSHA,
  });

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
}
