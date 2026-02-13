import { expect, test, vi } from 'vitest';
import { createMockGitHubClient } from '../../test-utils/create-mock-github-client.ts';
import type {
  ChecksListForRefResult,
  GitHubClient,
  PullsListItem,
  ReposGetCombinedStatusResult,
} from '../github-client/types.ts';
import { createPRPoller } from './create-pr-poller.ts';
import type { PRCIStatus } from './types.ts';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

interface CIStatusCall {
  prNumber: number;
  oldCIStatus: PRCIStatus | null;
  newCIStatus: PRCIStatus;
}

interface PRDetectedCall {
  prNumber: number;
}

interface SetupOptions {
  prs?: PullsListItem[];
}

function buildPR(overrides: Partial<PullsListItem> & { number: number }): PullsListItem {
  return {
    title: `PR #${overrides.number}`,
    html_url: `https://github.com/test-owner/test-repo/pull/${overrides.number}`,
    user: { login: 'test-author' },
    head: { sha: `sha-${overrides.number}`, ref: `branch-${overrides.number}` },
    body: `Closes #${overrides.number}`,
    draft: false,
    ...overrides,
  };
}

function buildSuccessCIResponse(): {
  combinedStatus: ReposGetCombinedStatusResult;
  checkRuns: ChecksListForRefResult;
} {
  return {
    combinedStatus: { data: { state: 'success', total_count: 1 } },
    checkRuns: {
      data: {
        total_count: 1,
        check_runs: [{ status: 'completed', conclusion: 'success' }],
      },
    },
  };
}

function buildPendingCIResponse(): {
  combinedStatus: ReposGetCombinedStatusResult;
  checkRuns: ChecksListForRefResult;
} {
  return {
    combinedStatus: { data: { state: 'pending', total_count: 0 } },
    checkRuns: {
      data: {
        total_count: 1,
        check_runs: [{ status: 'in_progress', conclusion: null }],
      },
    },
  };
}

function buildFailureCIResponse(): {
  combinedStatus: ReposGetCombinedStatusResult;
  checkRuns: ChecksListForRefResult;
} {
  return {
    combinedStatus: { data: { state: 'success', total_count: 0 } },
    checkRuns: {
      data: {
        total_count: 1,
        check_runs: [{ status: 'completed', conclusion: 'failure' }],
      },
    },
  };
}

function setupCIMocks(
  client: GitHubClient,
  combinedStatus: ReposGetCombinedStatusResult,
  checkRuns: ChecksListForRefResult,
): void {
  vi.mocked(client.repos.getCombinedStatusForRef).mockResolvedValue(combinedStatus);
  vi.mocked(client.checks.listForRef).mockResolvedValue(checkRuns);
}

function setupTest(options: SetupOptions = {}): {
  client: GitHubClient;
  ciStatusCalls: CIStatusCall[];
  detectedCalls: PRDetectedCall[];
  removedCalls: number[];
  poller: ReturnType<typeof createPRPoller>;
} {
  const client = createMockGitHubClient();
  const ciStatusCalls: CIStatusCall[] = [];
  const detectedCalls: PRDetectedCall[] = [];
  const removedCalls: number[] = [];

  vi.mocked(client.pulls.list).mockResolvedValue({
    data: options.prs ?? [],
  });

  // Default CI responses: success
  const successCI = buildSuccessCIResponse();
  setupCIMocks(client, successCI.combinedStatus, successCI.checkRuns);

  const poller = createPRPoller({
    gitHubClient: client,
    owner: 'test-owner',
    repo: 'test-repo',
    pollInterval: 30,
    onCIStatusChanged: (
      prNumber: number,
      oldCIStatus: PRCIStatus | null,
      newCIStatus: PRCIStatus,
    ) => {
      ciStatusCalls.push({ prNumber, oldCIStatus, newCIStatus });
    },
    onPRDetected: (prNumber: number) => {
      detectedCalls.push({ prNumber });
    },
    onPRRemoved: (prNumber: number) => {
      removedCalls.push(prNumber);
    },
  });

  return { client, ciStatusCalls, detectedCalls, removedCalls, poller };
}

// ---------------------------------------------------------------------------
// Poll Cycle — first cycle with empty snapshot
// ---------------------------------------------------------------------------

test('it adds each detected PR to the snapshot on the first cycle', async () => {
  const prs = [buildPR({ number: 1 }), buildPR({ number: 2 })];
  const { poller } = setupTest({ prs });

  await poller.poll();

  const snapshot = poller.getSnapshot();
  expect(snapshot.size).toBe(2);
  expect(snapshot.has(1)).toBe(true);
  expect(snapshot.has(2)).toBe(true);
});

// ---------------------------------------------------------------------------
// Poll Cycle — pulls.list failure skips entire cycle
// ---------------------------------------------------------------------------

test('it skips the entire cycle when the pulls list call fails', async () => {
  const { client, ciStatusCalls, removedCalls, poller } = setupTest();

  vi.mocked(client.pulls.list).mockRejectedValue(new Error('API rate limit'));

  await poller.poll();

  expect(poller.getSnapshot().size).toBe(0);
  expect(ciStatusCalls).toHaveLength(0);
  expect(removedCalls).toHaveLength(0);
});

test('it retains the previous snapshot when pulls list fails on a subsequent cycle', async () => {
  const prs = [buildPR({ number: 1 })];
  const { client, poller } = setupTest({ prs });

  await poller.poll();
  expect(poller.getSnapshot().size).toBe(1);

  vi.mocked(client.pulls.list).mockRejectedValue(new Error('Network error'));

  await poller.poll();
  expect(poller.getSnapshot().size).toBe(1);
  expect(poller.getSnapshot().get(1)?.title).toBe('PR #1');
});

// ---------------------------------------------------------------------------
// Poll Cycle — CI status fetch failure for one PR does not affect others
// ---------------------------------------------------------------------------

test('it continues processing other PRs when a CI fetch fails for one PR', async () => {
  const prs = [
    buildPR({ number: 1, head: { sha: 'sha-1', ref: 'branch-1' } }),
    buildPR({ number: 2, head: { sha: 'sha-2', ref: 'branch-2' } }),
  ];
  const { client, ciStatusCalls, poller } = setupTest({ prs });

  let callCount = 0;
  vi.mocked(client.repos.getCombinedStatusForRef).mockImplementation(async () => {
    callCount += 1;
    if (callCount === 1) {
      throw new Error('CI fetch failed');
    }
    return { data: { state: 'success', total_count: 1 } };
  });

  const successCheckRuns = buildSuccessCIResponse().checkRuns;
  vi.mocked(client.checks.listForRef).mockResolvedValue(successCheckRuns);

  await poller.poll();

  // PR #1 failed — should have ciStatus: null still
  expect(poller.getSnapshot().get(1)?.ciStatus).toBeNull();
  // PR #2 should have succeeded
  expect(poller.getSnapshot().get(2)?.ciStatus).toBe('success');
  // Only one callback (for PR #2)
  expect(ciStatusCalls).toHaveLength(1);
  expect(ciStatusCalls[0]).toMatchObject({
    prNumber: 2,
    oldCIStatus: null,
    newCIStatus: 'success',
  });
});

// ---------------------------------------------------------------------------
// Snapshot — contains all required fields
// ---------------------------------------------------------------------------

test('it stores number, title, url, headSHA, author, body, and ciStatus in each snapshot entry', async () => {
  const prs = [
    buildPR({
      number: 42,
      title: 'feat: add login',
      html_url: 'https://github.com/test-owner/test-repo/pull/42',
      user: { login: 'alice' },
      head: { sha: 'abc123', ref: 'feat-login' },
      body: 'Closes #10',
    }),
  ];
  const { poller } = setupTest({ prs });

  await poller.poll();

  const entry = poller.getSnapshot().get(42);
  expect(entry).toStrictEqual({
    number: 42,
    title: 'feat: add login',
    url: 'https://github.com/test-owner/test-repo/pull/42',
    headSHA: 'abc123',
    author: 'alice',
    body: 'Closes #10',
    ciStatus: 'success',
  });
});

// ---------------------------------------------------------------------------
// Snapshot — PR removed calls onPRRemoved
// ---------------------------------------------------------------------------

test('it removes the PR from the snapshot and calls onPRRemoved when a PR disappears', async () => {
  const prs = [buildPR({ number: 1 }), buildPR({ number: 2 })];
  const { client, removedCalls, poller } = setupTest({ prs });

  await poller.poll();
  expect(poller.getSnapshot().size).toBe(2);

  // PR #2 is closed/merged
  vi.mocked(client.pulls.list).mockResolvedValue({
    data: [buildPR({ number: 1 })],
  });

  await poller.poll();

  expect(poller.getSnapshot().size).toBe(1);
  expect(poller.getSnapshot().has(2)).toBe(false);
  expect(removedCalls).toContain(2);
});

// ---------------------------------------------------------------------------
// Snapshot — getSnapshot returns the current state as a Map
// ---------------------------------------------------------------------------

test('it returns a Map keyed by PR number from getSnapshot', async () => {
  const prs = [buildPR({ number: 5 }), buildPR({ number: 10 })];
  const { poller } = setupTest({ prs });

  await poller.poll();

  const snapshot = poller.getSnapshot();
  expect(snapshot).toBeInstanceOf(Map);
  expect(snapshot.size).toBe(2);
  expect(snapshot.get(5)?.number).toBe(5);
  expect(snapshot.get(10)?.number).toBe(10);
});

// ---------------------------------------------------------------------------
// Snapshot — title and body updates reflected
// ---------------------------------------------------------------------------

test('it updates the snapshot when a PR title or body changes between cycles', async () => {
  const prs = [buildPR({ number: 1, title: 'Original title', body: 'Original body' })];
  const { client, poller } = setupTest({ prs });

  await poller.poll();
  expect(poller.getSnapshot().get(1)?.title).toBe('Original title');
  expect(poller.getSnapshot().get(1)?.body).toBe('Original body');

  vi.mocked(client.pulls.list).mockResolvedValue({
    data: [buildPR({ number: 1, title: 'Updated title', body: 'Updated body' })],
  });

  await poller.poll();

  expect(poller.getSnapshot().get(1)?.title).toBe('Updated title');
  expect(poller.getSnapshot().get(1)?.body).toBe('Updated body');
});

// ---------------------------------------------------------------------------
// Snapshot — null body coerced to empty string
// ---------------------------------------------------------------------------

test('it stores body as empty string when the GitHub API returns null body', async () => {
  const prs = [buildPR({ number: 1, body: null })];
  const { poller } = setupTest({ prs });

  await poller.poll();

  expect(poller.getSnapshot().get(1)?.body).toBe('');
});

// ---------------------------------------------------------------------------
// Snapshot — null user coerced to empty string
// ---------------------------------------------------------------------------

test('it stores author as empty string when the GitHub API returns null user', async () => {
  const prs = [buildPR({ number: 1, user: null })];
  const { poller } = setupTest({ prs });

  await poller.poll();

  expect(poller.getSnapshot().get(1)?.author).toBe('');
});

// ---------------------------------------------------------------------------
// CI Status Monitoring — skip when SHA unchanged and ciStatus is success
// ---------------------------------------------------------------------------

test('it skips the CI fetch when SHA is unchanged and ciStatus is success', async () => {
  const prs = [buildPR({ number: 1, head: { sha: 'sha-1', ref: 'branch-1' } })];
  const { client, ciStatusCalls, poller } = setupTest({ prs });

  // First poll — fetches CI, gets success
  await poller.poll();
  expect(ciStatusCalls).toHaveLength(1);

  // Reset mocks
  vi.mocked(client.repos.getCombinedStatusForRef).mockClear();
  vi.mocked(client.checks.listForRef).mockClear();
  ciStatusCalls.length = 0;

  // Second poll — same SHA, ciStatus is success → skip
  await poller.poll();

  expect(client.repos.getCombinedStatusForRef).not.toHaveBeenCalled();
  expect(client.checks.listForRef).not.toHaveBeenCalled();
  expect(ciStatusCalls).toHaveLength(0);
});

// ---------------------------------------------------------------------------
// CI Status Monitoring — fetch when SHA unchanged but ciStatus is pending
// ---------------------------------------------------------------------------

test('it fetches CI status when SHA is unchanged but ciStatus is pending', async () => {
  const prs = [buildPR({ number: 1, head: { sha: 'sha-1', ref: 'branch-1' } })];
  const { client, poller } = setupTest({ prs });

  // First poll — CI is pending
  const pendingCI = buildPendingCIResponse();
  setupCIMocks(client, pendingCI.combinedStatus, pendingCI.checkRuns);

  await poller.poll();
  expect(poller.getSnapshot().get(1)?.ciStatus).toBe('pending');

  // Reset call tracking
  vi.mocked(client.repos.getCombinedStatusForRef).mockClear();
  vi.mocked(client.checks.listForRef).mockClear();

  // Second poll — same SHA, ciStatus is pending → should still fetch
  await poller.poll();

  expect(client.repos.getCombinedStatusForRef).toHaveBeenCalledTimes(1);
  expect(client.checks.listForRef).toHaveBeenCalledTimes(1);
});

// ---------------------------------------------------------------------------
// CI Status Monitoring — fetch when SHA unchanged but ciStatus is failure
// ---------------------------------------------------------------------------

test('it fetches CI status when SHA is unchanged but ciStatus is failure', async () => {
  const prs = [buildPR({ number: 1, head: { sha: 'sha-1', ref: 'branch-1' } })];
  const { client, poller } = setupTest({ prs });

  // First poll — CI is failure
  const failureCI = buildFailureCIResponse();
  setupCIMocks(client, failureCI.combinedStatus, failureCI.checkRuns);

  await poller.poll();
  expect(poller.getSnapshot().get(1)?.ciStatus).toBe('failure');

  // Reset call tracking
  vi.mocked(client.repos.getCombinedStatusForRef).mockClear();
  vi.mocked(client.checks.listForRef).mockClear();

  // Second poll — same SHA, ciStatus is failure → should still fetch
  await poller.poll();

  expect(client.repos.getCombinedStatusForRef).toHaveBeenCalledTimes(1);
  expect(client.checks.listForRef).toHaveBeenCalledTimes(1);
});

// ---------------------------------------------------------------------------
// CI Status Monitoring — fetch when SHA changed
// ---------------------------------------------------------------------------

test('it fetches CI status when SHA changes regardless of stored ciStatus', async () => {
  const prs = [buildPR({ number: 1, head: { sha: 'sha-1', ref: 'branch-1' } })];
  const { client, poller } = setupTest({ prs });

  // First poll — success
  await poller.poll();
  expect(poller.getSnapshot().get(1)?.ciStatus).toBe('success');

  // SHA changes
  vi.mocked(client.pulls.list).mockResolvedValue({
    data: [buildPR({ number: 1, head: { sha: 'sha-2', ref: 'branch-1' } })],
  });
  vi.mocked(client.repos.getCombinedStatusForRef).mockClear();
  vi.mocked(client.checks.listForRef).mockClear();

  // Second poll — SHA changed → fetch even though previous was success
  await poller.poll();

  expect(client.repos.getCombinedStatusForRef).toHaveBeenCalledTimes(1);
  expect(client.checks.listForRef).toHaveBeenCalledTimes(1);
});

// ---------------------------------------------------------------------------
// CI Status Monitoring — newly detected PR always fetches CI
// ---------------------------------------------------------------------------

test('it fetches CI for newly detected PRs and calls onCIStatusChanged with null oldCIStatus', async () => {
  const prs = [buildPR({ number: 1, head: { sha: 'sha-1', ref: 'branch-1' } })];
  const { ciStatusCalls, poller } = setupTest({ prs });

  await poller.poll();

  expect(ciStatusCalls).toHaveLength(1);
  expect(ciStatusCalls[0]).toStrictEqual({
    prNumber: 1,
    oldCIStatus: null,
    newCIStatus: 'success',
  });
});

// ---------------------------------------------------------------------------
// CI Status Monitoring — newly detected PR with pending CI
// ---------------------------------------------------------------------------

test('it calls onCIStatusChanged with pending for a newly detected PR with pending CI', async () => {
  const prs = [buildPR({ number: 1 })];
  const { client, ciStatusCalls, poller } = setupTest({ prs });

  const pendingCI = buildPendingCIResponse();
  setupCIMocks(client, pendingCI.combinedStatus, pendingCI.checkRuns);

  await poller.poll();

  expect(ciStatusCalls).toHaveLength(1);
  expect(ciStatusCalls[0]).toStrictEqual({
    prNumber: 1,
    oldCIStatus: null,
    newCIStatus: 'pending',
  });
});

// ---------------------------------------------------------------------------
// CI Status Monitoring — CI fetch failure retains stale headSHA for skip comparison
// ---------------------------------------------------------------------------

test('it re-attempts the CI fetch on the next cycle when a previous fetch failed', async () => {
  const prs = [buildPR({ number: 1, head: { sha: 'sha-1', ref: 'branch-1' } })];
  const { client, ciStatusCalls, poller } = setupTest({ prs });

  // First poll — CI fetch fails
  vi.mocked(client.repos.getCombinedStatusForRef).mockRejectedValue(new Error('CI fetch failed'));

  await poller.poll();

  // ciStatus should remain null (fetch failed)
  expect(poller.getSnapshot().get(1)?.ciStatus).toBeNull();
  expect(ciStatusCalls).toHaveLength(0);

  // Second poll — same SHA, ciStatus: null → should re-attempt
  const successCI = buildSuccessCIResponse();
  setupCIMocks(client, successCI.combinedStatus, successCI.checkRuns);

  await poller.poll();

  expect(ciStatusCalls).toHaveLength(1);
  expect(ciStatusCalls[0]).toMatchObject({
    prNumber: 1,
    oldCIStatus: null,
    newCIStatus: 'success',
  });
});

// ---------------------------------------------------------------------------
// Change Reporting — success to failure
// ---------------------------------------------------------------------------

test('it calls onCIStatusChanged when CI transitions from success to failure', async () => {
  const prs = [buildPR({ number: 1, head: { sha: 'sha-1', ref: 'branch-1' } })];
  const { client, ciStatusCalls, poller } = setupTest({ prs });

  // First poll — success
  await poller.poll();
  expect(ciStatusCalls).toHaveLength(1);
  ciStatusCalls.length = 0;

  // SHA changes, new CI is failure
  vi.mocked(client.pulls.list).mockResolvedValue({
    data: [buildPR({ number: 1, head: { sha: 'sha-2', ref: 'branch-1' } })],
  });
  const failureCI = buildFailureCIResponse();
  setupCIMocks(client, failureCI.combinedStatus, failureCI.checkRuns);

  await poller.poll();

  expect(ciStatusCalls).toHaveLength(1);
  expect(ciStatusCalls[0]).toStrictEqual({
    prNumber: 1,
    oldCIStatus: 'success',
    newCIStatus: 'failure',
  });
});

// ---------------------------------------------------------------------------
// Change Reporting — pending to success
// ---------------------------------------------------------------------------

test('it calls onCIStatusChanged when CI transitions from pending to success', async () => {
  const prs = [buildPR({ number: 1, head: { sha: 'sha-1', ref: 'branch-1' } })];
  const { client, ciStatusCalls, poller } = setupTest({ prs });

  // First poll — pending
  const pendingCI = buildPendingCIResponse();
  setupCIMocks(client, pendingCI.combinedStatus, pendingCI.checkRuns);

  await poller.poll();
  ciStatusCalls.length = 0;

  // Second poll — same SHA, now success
  const successCI = buildSuccessCIResponse();
  setupCIMocks(client, successCI.combinedStatus, successCI.checkRuns);

  await poller.poll();

  expect(ciStatusCalls).toHaveLength(1);
  expect(ciStatusCalls[0]).toStrictEqual({
    prNumber: 1,
    oldCIStatus: 'pending',
    newCIStatus: 'success',
  });
});

// ---------------------------------------------------------------------------
// Change Reporting — removed PR does not trigger onCIStatusChanged
// ---------------------------------------------------------------------------

test('it calls onPRRemoved but not onCIStatusChanged when a PR is removed', async () => {
  const prs = [buildPR({ number: 1 }), buildPR({ number: 2 })];
  const { client, ciStatusCalls, removedCalls, poller } = setupTest({ prs });

  await poller.poll();
  ciStatusCalls.length = 0;

  // PR #2 removed
  vi.mocked(client.pulls.list).mockResolvedValue({
    data: [buildPR({ number: 1 })],
  });

  await poller.poll();

  expect(removedCalls).toContain(2);
  // No CI status change for the removed PR
  const pr2CIChanges = ciStatusCalls.filter((c) => c.prNumber === 2);
  expect(pr2CIChanges).toHaveLength(0);
});

// ---------------------------------------------------------------------------
// Implementation — stop() clears the interval timer
// ---------------------------------------------------------------------------

test('it clears the interval timer when stop is called', () => {
  const { poller } = setupTest();

  // stop() should not throw even without an interval
  expect(() => {
    poller.stop();
  }).not.toThrow();
});

// ---------------------------------------------------------------------------
// Implementation — poll() can be called directly
// ---------------------------------------------------------------------------

test('it can be invoked directly without an interval timer', async () => {
  const prs = [buildPR({ number: 1 })];
  const { poller } = setupTest({ prs });

  // Direct call should work
  await poller.poll();

  expect(poller.getSnapshot().size).toBe(1);
});

// ---------------------------------------------------------------------------
// Implementation — headSHA and ciStatus updated together in step 6
// ---------------------------------------------------------------------------

test('it updates headSHA and ciStatus together after CI fetch completes', async () => {
  const prs = [buildPR({ number: 1, head: { sha: 'sha-1', ref: 'branch-1' } })];
  const { client, poller } = setupTest({ prs });

  await poller.poll();

  const entry = poller.getSnapshot().get(1);
  expect(entry?.headSHA).toBe('sha-1');
  expect(entry?.ciStatus).toBe('success');

  // SHA changes
  vi.mocked(client.pulls.list).mockResolvedValue({
    data: [buildPR({ number: 1, head: { sha: 'sha-2', ref: 'branch-1' } })],
  });

  await poller.poll();

  const updated = poller.getSnapshot().get(1);
  expect(updated?.headSHA).toBe('sha-2');
  expect(updated?.ciStatus).toBe('success');
});

// ---------------------------------------------------------------------------
// Implementation — headSHA not updated in step 2 for existing PRs
// ---------------------------------------------------------------------------

test('it does not update headSHA during metadata update when CI fetch is skipped', async () => {
  const prs = [buildPR({ number: 1, head: { sha: 'sha-1', ref: 'branch-1' } })];
  const { ciStatusCalls, poller } = setupTest({ prs });

  // First poll — success
  await poller.poll();
  expect(poller.getSnapshot().get(1)?.headSHA).toBe('sha-1');
  expect(poller.getSnapshot().get(1)?.ciStatus).toBe('success');
  ciStatusCalls.length = 0;

  // Second poll — same SHA + success → CI fetch skipped
  // headSHA remains sha-1, not re-assigned from the response
  await poller.poll();

  expect(poller.getSnapshot().get(1)?.headSHA).toBe('sha-1');
  expect(ciStatusCalls).toHaveLength(0);
});

// ---------------------------------------------------------------------------
// CI Derivation — combined status failure
// ---------------------------------------------------------------------------

test('it derives failure when combined status is failure', async () => {
  const prs = [buildPR({ number: 1 })];
  const { client, ciStatusCalls, poller } = setupTest({ prs });

  vi.mocked(client.repos.getCombinedStatusForRef).mockResolvedValue({
    data: { state: 'failure', total_count: 1 },
  });
  vi.mocked(client.checks.listForRef).mockResolvedValue({
    data: { total_count: 0, check_runs: [] },
  });

  await poller.poll();

  expect(ciStatusCalls[0]?.newCIStatus).toBe('failure');
});

// ---------------------------------------------------------------------------
// CI Derivation — check run with failure conclusion
// ---------------------------------------------------------------------------

test('it derives failure when a check run has a failure conclusion', async () => {
  const prs = [buildPR({ number: 1 })];
  const { client, ciStatusCalls, poller } = setupTest({ prs });

  vi.mocked(client.repos.getCombinedStatusForRef).mockResolvedValue({
    data: { state: 'success', total_count: 0 },
  });
  vi.mocked(client.checks.listForRef).mockResolvedValue({
    data: {
      total_count: 2,
      check_runs: [
        { status: 'completed', conclusion: 'success' },
        { status: 'completed', conclusion: 'failure' },
      ],
    },
  });

  await poller.poll();

  expect(ciStatusCalls[0]?.newCIStatus).toBe('failure');
});

// ---------------------------------------------------------------------------
// CI Derivation — check run with cancelled conclusion is failure
// ---------------------------------------------------------------------------

test('it derives failure when a check run has a cancelled conclusion', async () => {
  const prs = [buildPR({ number: 1 })];
  const { client, ciStatusCalls, poller } = setupTest({ prs });

  vi.mocked(client.repos.getCombinedStatusForRef).mockResolvedValue({
    data: { state: 'success', total_count: 0 },
  });
  vi.mocked(client.checks.listForRef).mockResolvedValue({
    data: {
      total_count: 1,
      check_runs: [{ status: 'completed', conclusion: 'cancelled' }],
    },
  });

  await poller.poll();

  expect(ciStatusCalls[0]?.newCIStatus).toBe('failure');
});

// ---------------------------------------------------------------------------
// CI Derivation — check run with timed_out conclusion is failure
// ---------------------------------------------------------------------------

test('it derives failure when a check run has a timed out conclusion', async () => {
  const prs = [buildPR({ number: 1 })];
  const { client, ciStatusCalls, poller } = setupTest({ prs });

  vi.mocked(client.repos.getCombinedStatusForRef).mockResolvedValue({
    data: { state: 'success', total_count: 0 },
  });
  vi.mocked(client.checks.listForRef).mockResolvedValue({
    data: {
      total_count: 1,
      check_runs: [{ status: 'completed', conclusion: 'timed_out' }],
    },
  });

  await poller.poll();

  expect(ciStatusCalls[0]?.newCIStatus).toBe('failure');
});

// ---------------------------------------------------------------------------
// CI Derivation — incomplete check run is pending
// ---------------------------------------------------------------------------

test('it derives pending when a check run is not yet completed', async () => {
  const prs = [buildPR({ number: 1 })];
  const { client, ciStatusCalls, poller } = setupTest({ prs });

  vi.mocked(client.repos.getCombinedStatusForRef).mockResolvedValue({
    data: { state: 'success', total_count: 0 },
  });
  vi.mocked(client.checks.listForRef).mockResolvedValue({
    data: {
      total_count: 1,
      check_runs: [{ status: 'queued', conclusion: null }],
    },
  });

  await poller.poll();

  expect(ciStatusCalls[0]?.newCIStatus).toBe('pending');
});

// ---------------------------------------------------------------------------
// CI Derivation — no CI configured is pending
// ---------------------------------------------------------------------------

test('it derives pending when no CI is configured', async () => {
  const prs = [buildPR({ number: 1 })];
  const { client, ciStatusCalls, poller } = setupTest({ prs });

  vi.mocked(client.repos.getCombinedStatusForRef).mockResolvedValue({
    data: { state: 'pending', total_count: 0 },
  });
  vi.mocked(client.checks.listForRef).mockResolvedValue({
    data: { total_count: 0, check_runs: [] },
  });

  await poller.poll();

  expect(ciStatusCalls[0]?.newCIStatus).toBe('pending');
});

// ---------------------------------------------------------------------------
// CI Derivation — combined status pending with real statuses
// ---------------------------------------------------------------------------

test('it derives pending when combined status is pending with real statuses', async () => {
  const prs = [buildPR({ number: 1 })];
  const { client, ciStatusCalls, poller } = setupTest({ prs });

  vi.mocked(client.repos.getCombinedStatusForRef).mockResolvedValue({
    data: { state: 'pending', total_count: 2 },
  });
  vi.mocked(client.checks.listForRef).mockResolvedValue({
    data: {
      total_count: 1,
      check_runs: [{ status: 'completed', conclusion: 'success' }],
    },
  });

  await poller.poll();

  expect(ciStatusCalls[0]?.newCIStatus).toBe('pending');
});

// ---------------------------------------------------------------------------
// No callback when CI status has not changed
// ---------------------------------------------------------------------------

test('it does not call onCIStatusChanged when the CI status has not changed', async () => {
  const prs = [buildPR({ number: 1, head: { sha: 'sha-1', ref: 'branch-1' } })];
  const { client, ciStatusCalls, poller } = setupTest({ prs });

  // First poll — pending
  const pendingCI = buildPendingCIResponse();
  setupCIMocks(client, pendingCI.combinedStatus, pendingCI.checkRuns);

  await poller.poll();
  ciStatusCalls.length = 0;

  // Second poll — still pending
  await poller.poll();

  expect(ciStatusCalls).toHaveLength(0);
});

// ---------------------------------------------------------------------------
// Empty snapshot before any polls
// ---------------------------------------------------------------------------

test('it returns an empty snapshot before any poll has run', () => {
  const { poller } = setupTest();
  const snapshot = poller.getSnapshot();
  expect(snapshot.size).toBe(0);
});

// ---------------------------------------------------------------------------
// Multiple PRs — independent CI fetch tracking
// ---------------------------------------------------------------------------

test('it tracks CI status independently for each PR', async () => {
  const prs = [
    buildPR({ number: 1, head: { sha: 'sha-1', ref: 'branch-1' } }),
    buildPR({ number: 2, head: { sha: 'sha-2', ref: 'branch-2' } }),
  ];
  const { client, ciStatusCalls, poller } = setupTest({ prs });

  // PR #1 gets success, PR #2 gets pending
  vi.mocked(client.repos.getCombinedStatusForRef).mockImplementation(async (params) => {
    if (params.ref === 'sha-1') {
      return { data: { state: 'success', total_count: 1 } };
    }
    return { data: { state: 'pending', total_count: 0 } };
  });
  vi.mocked(client.checks.listForRef).mockImplementation(async (params) => {
    if (params.ref === 'sha-1') {
      return {
        data: { total_count: 1, check_runs: [{ status: 'completed', conclusion: 'success' }] },
      };
    }
    return {
      data: { total_count: 1, check_runs: [{ status: 'in_progress', conclusion: null }] },
    };
  });

  await poller.poll();

  expect(ciStatusCalls).toHaveLength(2);
  expect(poller.getSnapshot().get(1)?.ciStatus).toBe('success');
  expect(poller.getSnapshot().get(2)?.ciStatus).toBe('pending');
});

// ---------------------------------------------------------------------------
// CI fetch uses head.sha from the response, not stored headSHA
// ---------------------------------------------------------------------------

test('it uses head SHA from the response for CI fetch when SHA has changed', async () => {
  const prs = [buildPR({ number: 1, head: { sha: 'sha-1', ref: 'branch-1' } })];
  const { client, poller } = setupTest({ prs });

  await poller.poll();

  // SHA changes
  vi.mocked(client.pulls.list).mockResolvedValue({
    data: [buildPR({ number: 1, head: { sha: 'sha-2', ref: 'branch-1' } })],
  });

  await poller.poll();

  // Verify the CI fetch used the new SHA
  const combinedCalls = vi.mocked(client.repos.getCombinedStatusForRef).mock.calls;
  const lastCall = combinedCalls.at(-1);
  expect(lastCall?.[0]).toMatchObject({ ref: 'sha-2' });
});

// ---------------------------------------------------------------------------
// headSHA not updated when CI fetch fails
// ---------------------------------------------------------------------------

test('it retains the stored headSHA when a CI fetch fails for a SHA change', async () => {
  const prs = [buildPR({ number: 1, head: { sha: 'sha-1', ref: 'branch-1' } })];
  const { client, poller } = setupTest({ prs });

  // First poll — success
  await poller.poll();
  expect(poller.getSnapshot().get(1)?.headSHA).toBe('sha-1');

  // SHA changes but CI fetch fails
  vi.mocked(client.pulls.list).mockResolvedValue({
    data: [buildPR({ number: 1, head: { sha: 'sha-2', ref: 'branch-1' } })],
  });
  vi.mocked(client.repos.getCombinedStatusForRef).mockRejectedValue(new Error('CI fetch failed'));

  await poller.poll();

  // headSHA should still be sha-1 (not updated because CI fetch failed)
  expect(poller.getSnapshot().get(1)?.headSHA).toBe('sha-1');
  // ciStatus should still be success (not updated)
  expect(poller.getSnapshot().get(1)?.ciStatus).toBe('success');
});

// ---------------------------------------------------------------------------
// Queries correct owner/repo
// ---------------------------------------------------------------------------

test('it passes the correct owner and repo to the pulls list call', async () => {
  const { client, poller } = setupTest();

  await poller.poll();

  expect(client.pulls.list).toHaveBeenCalledWith(
    expect.objectContaining({
      owner: 'test-owner',
      repo: 'test-repo',
      state: 'open',
      per_page: 100,
    }),
  );
});

// ---------------------------------------------------------------------------
// Change Reporting — onPRDetected
// ---------------------------------------------------------------------------

test('it calls onPRDetected when a new PR appears that was not in the previous snapshot', async () => {
  const prs = [buildPR({ number: 1 })];
  const { client, detectedCalls, poller } = setupTest({ prs });

  // First poll — PR #1 detected
  await poller.poll();
  expect(detectedCalls).toHaveLength(1);
  expect(detectedCalls[0]).toStrictEqual({ prNumber: 1 });

  detectedCalls.length = 0;

  // Second poll — PR #2 appears
  vi.mocked(client.pulls.list).mockResolvedValue({
    data: [buildPR({ number: 1 }), buildPR({ number: 2 })],
  });

  await poller.poll();

  expect(detectedCalls).toHaveLength(1);
  expect(detectedCalls[0]).toStrictEqual({ prNumber: 2 });
});

test('it calls onPRDetected for each PR on the first cycle with empty snapshot', async () => {
  const prs = [buildPR({ number: 1 }), buildPR({ number: 2 }), buildPR({ number: 3 })];
  const { detectedCalls, poller } = setupTest({ prs });

  await poller.poll();

  expect(detectedCalls).toHaveLength(3);
  expect(detectedCalls).toContainEqual({ prNumber: 1 });
  expect(detectedCalls).toContainEqual({ prNumber: 2 });
  expect(detectedCalls).toContainEqual({ prNumber: 3 });
});

test('it does not call onPRDetected when a PR was already in the snapshot from the previous cycle', async () => {
  const prs = [buildPR({ number: 1 })];
  const { detectedCalls, poller } = setupTest({ prs });

  // First poll — PR #1 detected
  await poller.poll();
  expect(detectedCalls).toHaveLength(1);

  detectedCalls.length = 0;

  // Second poll — PR #1 still present
  await poller.poll();

  expect(detectedCalls).toHaveLength(0);
});

test('it calls onPRDetected after the PR has been added to the snapshot', async () => {
  const prs = [buildPR({ number: 1 })];
  const client = createMockGitHubClient();
  let snapshotSizeWhenCallbackFired = 0;

  vi.mocked(client.pulls.list).mockResolvedValue({
    data: prs,
  });

  const successCI = buildSuccessCIResponse();
  setupCIMocks(client, successCI.combinedStatus, successCI.checkRuns);

  const poller = createPRPoller({
    gitHubClient: client,
    owner: 'test-owner',
    repo: 'test-repo',
    pollInterval: 30,
    onCIStatusChanged: () => {
      // no-op
    },
    onPRDetected: () => {
      snapshotSizeWhenCallbackFired = poller.getSnapshot().size;
    },
    onPRRemoved: () => {
      // no-op
    },
  });

  await poller.poll();

  expect(snapshotSizeWhenCallbackFired).toBe(1);
  expect(poller.getSnapshot().size).toBe(1);
});
