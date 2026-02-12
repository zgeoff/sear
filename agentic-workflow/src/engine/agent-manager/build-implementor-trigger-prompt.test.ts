import { expect, test } from 'vitest';
import type {
  CIStatusResult,
  IssueDetailsResult,
  PRFileEntry,
  PRInlineComment,
  PRReview,
  PRReviewsResult,
} from '../../types.ts';
import { buildImplementorTriggerPrompt } from './build-implementor-trigger-prompt.ts';
import type { BuildImplementorTriggerPromptParams } from './types.ts';

function setupTest(overrides?: Partial<BuildImplementorTriggerPromptParams>): {
  params: BuildImplementorTriggerPromptParams;
} {
  const issueDetails: IssueDetailsResult = {
    number: 42,
    title: 'Fix authentication bug',
    body: 'The login flow fails when the token expires.',
    labels: ['task:implement', 'status:in-progress', 'priority:high'],
    createdAt: '2026-01-15T10:00:00Z',
  };

  const params: BuildImplementorTriggerPromptParams = {
    issueDetails,
    ...overrides,
  };

  return { params };
}

test('it includes only the issue section when no PR data is present', () => {
  const { params } = setupTest();

  const result = buildImplementorTriggerPrompt(params);

  expect(result).toContain('## Task Issue #42 — Fix authentication bug');
  expect(result).toContain('The login flow fails when the token expires.');
  expect(result).toContain('### Labels');
  expect(result).toContain('task:implement, status:in-progress, priority:high');
  expect(result).not.toContain('## PR #');
  expect(result).not.toContain('### Changed Files');
  expect(result).not.toContain('### Prior Reviews');
  expect(result).not.toContain('### Prior Inline Comments');
});

test('it includes the issue number, title, and body in the prompt', () => {
  const { params } = setupTest();

  const result = buildImplementorTriggerPrompt(params);

  expect(result).toContain('## Task Issue #42 — Fix authentication bug');
  expect(result).toContain('The login flow fails when the token expires.');
});

test('it includes comma-separated label names', () => {
  const { params } = setupTest();

  const result = buildImplementorTriggerPrompt(params);

  expect(result).toContain('### Labels');
  expect(result).toContain('task:implement, status:in-progress, priority:high');
});

test('it includes PR section when all PR data is present', () => {
  const prFiles: PRFileEntry[] = [
    {
      filename: 'src/auth/login.ts',
      status: 'modified',
      patch: '@@ -10,3 +10,5 @@\n-const token = getToken();\n+const token = refreshToken();',
    },
  ];

  const prReviews: PRReviewsResult = {
    reviews: [],
    comments: [],
  };

  const { params } = setupTest({
    prNumber: 99,
    prTitle: 'fix(auth): refresh expired tokens',
    prFiles,
    prReviews,
  });

  const result = buildImplementorTriggerPrompt(params);

  expect(result).toContain('## PR #99 — fix(auth): refresh expired tokens');
  expect(result).toContain('### Changed Files');
  expect(result).toContain('#### src/auth/login.ts (modified)');
});

test('it includes per-file patches with filename and status', () => {
  const prFiles: PRFileEntry[] = [
    {
      filename: 'src/auth/login.ts',
      status: 'modified',
      patch: '@@ -10,3 +10,5 @@\n-const token = getToken();\n+const token = refreshToken();',
    },
    {
      filename: 'src/auth/login.test.ts',
      status: 'modified',
      patch: '@@ -1,2 +1,4 @@\n+test("it refreshes expired token", () => {});',
    },
  ];

  const { params } = setupTest({
    prNumber: 99,
    prTitle: 'fix(auth): refresh expired tokens',
    prFiles,
    prReviews: { reviews: [], comments: [] },
  });

  const result = buildImplementorTriggerPrompt(params);

  expect(result).toContain('#### src/auth/login.ts (modified)');
  expect(result).toContain(
    '@@ -10,3 +10,5 @@\n-const token = getToken();\n+const token = refreshToken();',
  );
  expect(result).toContain('#### src/auth/login.test.ts (modified)');
});

test('it includes prior review submissions with author and state', () => {
  const prReviews: PRReviewsResult = {
    reviews: [
      {
        id: 1,
        author: 'reviewer1',
        state: 'CHANGES_REQUESTED',
        body: 'Please add error handling for the refresh call.',
      },
    ],
    comments: [],
  };

  const { params } = setupTest({
    prNumber: 99,
    prTitle: 'fix(auth): refresh expired tokens',
    prFiles: [],
    prReviews,
  });

  const result = buildImplementorTriggerPrompt(params);

  expect(result).toContain('### Prior Reviews');
  expect(result).toContain('#### Review by reviewer1 — CHANGES_REQUESTED');
  expect(result).toContain('Please add error handling for the refresh call.');
});

test('it includes prior inline comments with path, line, and author', () => {
  const prReviews: PRReviewsResult = {
    reviews: [],
    comments: [
      {
        id: 10,
        author: 'reviewer1',
        body: 'This should handle the case where refreshToken throws.',
        path: 'src/auth/login.ts',
        line: 12,
      },
    ],
  };

  const { params } = setupTest({
    prNumber: 99,
    prTitle: 'fix(auth): refresh expired tokens',
    prFiles: [],
    prReviews,
  });

  const result = buildImplementorTriggerPrompt(params);

  expect(result).toContain('### Prior Inline Comments');
  expect(result).toContain('#### src/auth/login.ts:12 — reviewer1');
  expect(result).toContain('This should handle the case where refreshToken throws.');
});

test('it omits the prior reviews section when there are no reviews', () => {
  const { params } = setupTest({
    prNumber: 99,
    prTitle: 'fix(auth): refresh expired tokens',
    prFiles: [],
    prReviews: { reviews: [], comments: [] },
  });

  const result = buildImplementorTriggerPrompt(params);

  expect(result).not.toContain('### Prior Reviews');
});

test('it omits the prior inline comments section when there are no comments', () => {
  const { params } = setupTest({
    prNumber: 99,
    prTitle: 'fix(auth): refresh expired tokens',
    prFiles: [],
    prReviews: { reviews: [], comments: [] },
  });

  const result = buildImplementorTriggerPrompt(params);

  expect(result).not.toContain('### Prior Inline Comments');
});

test('it omits comments section but keeps reviews section when only reviews exist', () => {
  const prReviews: PRReviewsResult = {
    reviews: [{ id: 1, author: 'alice', state: 'APPROVED', body: 'Looks good!' }],
    comments: [],
  };

  const { params } = setupTest({
    prNumber: 99,
    prTitle: 'fix(auth): refresh expired tokens',
    prFiles: [],
    prReviews,
  });

  const result = buildImplementorTriggerPrompt(params);

  expect(result).toContain('### Prior Reviews');
  expect(result).toContain('#### Review by alice — APPROVED');
  expect(result).not.toContain('### Prior Inline Comments');
});

test('it omits reviews section but keeps comments section when only comments exist', () => {
  const prReviews: PRReviewsResult = {
    reviews: [],
    comments: [
      { id: 5, author: 'bob', body: 'Nit: rename this variable', path: 'src/foo.ts', line: 7 },
    ],
  };

  const { params } = setupTest({
    prNumber: 99,
    prTitle: 'fix(auth): refresh expired tokens',
    prFiles: [],
    prReviews,
  });

  const result = buildImplementorTriggerPrompt(params);

  expect(result).not.toContain('### Prior Reviews');
  expect(result).toContain('### Prior Inline Comments');
  expect(result).toContain('#### src/foo.ts:7 — bob');
});

test('it includes filename and status but no code block when patch is absent', () => {
  const binaryFile: PRFileEntry = {
    filename: 'assets/logo.png',
    status: 'added',
  };

  const { params } = setupTest({
    prNumber: 99,
    prTitle: 'fix(auth): refresh expired tokens',
    prFiles: [binaryFile],
    prReviews: { reviews: [], comments: [] },
  });

  const result = buildImplementorTriggerPrompt(params);

  expect(result).toContain('#### assets/logo.png (added)');
  const fileEntryIndex = result.indexOf('#### assets/logo.png (added)');
  const afterEntry = result.slice(fileEntryIndex, fileEntryIndex + 100);
  expect(afterEntry).not.toContain('```');
});

test('it handles a mix of files with and without patches', () => {
  const files: PRFileEntry[] = [
    {
      filename: 'src/code.ts',
      status: 'modified',
      patch: '@@ -1,1 +1,2 @@\n+new line',
    },
    {
      filename: 'assets/image.png',
      status: 'added',
    },
    {
      filename: 'src/other.ts',
      status: 'removed',
      patch: '@@ -1,3 +0,0 @@\n-removed content',
    },
  ];

  const { params } = setupTest({
    prNumber: 99,
    prTitle: 'fix(auth): refresh expired tokens',
    prFiles: files,
    prReviews: { reviews: [], comments: [] },
  });

  const result = buildImplementorTriggerPrompt(params);

  expect(result).toContain('#### src/code.ts (modified)');
  expect(result).toContain('@@ -1,1 +1,2 @@\n+new line');
  expect(result).toContain('#### assets/image.png (added)');
  expect(result).toContain('#### src/other.ts (removed)');
  expect(result).toContain('@@ -1,3 +0,0 @@\n-removed content');
});

test('it does not include the issue creation date in the prompt', () => {
  const { params } = setupTest();

  const result = buildImplementorTriggerPrompt(params);

  expect(result).not.toContain('2026-01-15T10:00:00Z');
  expect(result).not.toContain('createdAt');
});

test('it handles an empty labels array', () => {
  const { params } = setupTest({
    issueDetails: {
      number: 42,
      title: 'Fix bug',
      body: 'Description',
      labels: [],
      createdAt: '2026-01-15T10:00:00Z',
    },
  });

  const result = buildImplementorTriggerPrompt(params);

  expect(result).toContain('### Labels');
  expect(result).toContain('## Task Issue #42 — Fix bug');
});

test('it handles inline comments with null line numbers', () => {
  const comments: PRInlineComment[] = [
    { id: 1, author: 'alice', body: 'Outdated comment', path: 'src/old.ts', line: null },
  ];

  const { params } = setupTest({
    prNumber: 99,
    prTitle: 'fix(auth): refresh expired tokens',
    prFiles: [],
    prReviews: { reviews: [], comments },
  });

  const result = buildImplementorTriggerPrompt(params);

  expect(result).toContain('#### src/old.ts:outdated — alice');
  expect(result).toContain('Outdated comment');
});

test('it handles an empty files array', () => {
  const { params } = setupTest({
    prNumber: 99,
    prTitle: 'fix(auth): refresh expired tokens',
    prFiles: [],
    prReviews: { reviews: [], comments: [] },
  });

  const result = buildImplementorTriggerPrompt(params);

  expect(result).toContain('### Changed Files');
  expect(result).not.toContain('####');
});

test('it produces the correct overall structure for a complete prompt', () => {
  const prFiles: PRFileEntry[] = [
    {
      filename: 'src/auth/login.ts',
      status: 'modified',
      patch: '@@ -10,3 +10,5 @@\n-const token = getToken();\n+const token = refreshToken();',
    },
  ];

  const prReviews: PRReviewsResult = {
    reviews: [
      {
        id: 1,
        author: 'reviewer1',
        state: 'CHANGES_REQUESTED',
        body: 'Please add error handling for the refresh call.',
      },
    ],
    comments: [
      {
        id: 10,
        author: 'reviewer1',
        body: 'This should handle the case where refreshToken throws.',
        path: 'src/auth/login.ts',
        line: 12,
      },
    ],
  };

  const { params } = setupTest({
    prNumber: 99,
    prTitle: 'fix(auth): refresh expired tokens',
    prFiles,
    prReviews,
  });

  const result = buildImplementorTriggerPrompt(params);

  const issueIndex = result.indexOf('## Task Issue #42');
  const labelsIndex = result.indexOf('### Labels');
  const prIndex = result.indexOf('## PR #99');
  const changedFilesIndex = result.indexOf('### Changed Files');
  const priorReviewsIndex = result.indexOf('### Prior Reviews');
  const priorCommentsIndex = result.indexOf('### Prior Inline Comments');

  expect(issueIndex).toBeLessThan(labelsIndex);
  expect(labelsIndex).toBeLessThan(prIndex);
  expect(prIndex).toBeLessThan(changedFilesIndex);
  expect(changedFilesIndex).toBeLessThan(priorReviewsIndex);
  expect(priorReviewsIndex).toBeLessThan(priorCommentsIndex);
});

test('it preserves chronological order of reviews', () => {
  const reviews: PRReview[] = [
    { id: 1, author: 'alice', state: 'COMMENTED', body: 'First review' },
    { id: 2, author: 'bob', state: 'CHANGES_REQUESTED', body: 'Second review' },
    { id: 3, author: 'alice', state: 'APPROVED', body: 'Third review' },
  ];

  const { params } = setupTest({
    prNumber: 99,
    prTitle: 'fix(auth): refresh expired tokens',
    prFiles: [],
    prReviews: { reviews, comments: [] },
  });

  const result = buildImplementorTriggerPrompt(params);

  const firstIndex = result.indexOf('First review');
  const secondIndex = result.indexOf('Second review');
  const thirdIndex = result.indexOf('Third review');

  expect(firstIndex).toBeLessThan(secondIndex);
  expect(secondIndex).toBeLessThan(thirdIndex);
});

test('it preserves chronological order of inline comments', () => {
  const comments: PRInlineComment[] = [
    { id: 1, author: 'alice', body: 'Comment one', path: 'a.ts', line: 1 },
    { id: 2, author: 'bob', body: 'Comment two', path: 'b.ts', line: 5 },
    { id: 3, author: 'alice', body: 'Comment three', path: 'a.ts', line: 10 },
  ];

  const { params } = setupTest({
    prNumber: 99,
    prTitle: 'fix(auth): refresh expired tokens',
    prFiles: [],
    prReviews: { reviews: [], comments },
  });

  const result = buildImplementorTriggerPrompt(params);

  const firstIndex = result.indexOf('Comment one');
  const secondIndex = result.indexOf('Comment two');
  const thirdIndex = result.indexOf('Comment three');

  expect(firstIndex).toBeLessThan(secondIndex);
  expect(secondIndex).toBeLessThan(thirdIndex);
});

test('it omits PR section when only some PR data is present', () => {
  const { params } = setupTest({
    prNumber: 99,
    prTitle: 'fix(auth): refresh expired tokens',
  });

  const result = buildImplementorTriggerPrompt(params);

  expect(result).toContain('## Task Issue #42');
  expect(result).not.toContain('## PR #99');
  expect(result).not.toContain('### Changed Files');
});

test('it omits PR section when only prFiles is missing', () => {
  const { params } = setupTest({
    prNumber: 99,
    prTitle: 'fix(auth): refresh expired tokens',
    prReviews: { reviews: [], comments: [] },
  });

  const result = buildImplementorTriggerPrompt(params);

  expect(result).toContain('## Task Issue #42');
  expect(result).not.toContain('## PR #99');
  expect(result).not.toContain('### Changed Files');
});

test('it omits PR section when only prReviews is missing', () => {
  const { params } = setupTest({
    prNumber: 99,
    prTitle: 'fix(auth): refresh expired tokens',
    prFiles: [],
  });

  const result = buildImplementorTriggerPrompt(params);

  expect(result).toContain('## Task Issue #42');
  expect(result).not.toContain('## PR #99');
  expect(result).not.toContain('### Changed Files');
});

test('it includes CI Status section when overall status is failure', () => {
  const ciStatus: CIStatusResult = {
    overall: 'failure',
    failedCheckRuns: [
      {
        name: 'lint',
        status: 'completed',
        conclusion: 'failure',
        detailsURL: 'https://github.com/owner/repo/runs/123',
      },
      {
        name: 'test',
        status: 'completed',
        conclusion: 'cancelled',
        detailsURL: 'https://github.com/owner/repo/runs/456',
      },
    ],
  };

  const { params } = setupTest({
    prNumber: 99,
    prTitle: 'fix(auth): refresh expired tokens',
    prFiles: [],
    prReviews: { reviews: [], comments: [] },
    ciStatus,
  });

  const result = buildImplementorTriggerPrompt(params);

  expect(result).toContain('### CI Status: FAILURE');
  expect(result).toContain('#### lint — failure');
  expect(result).toContain('Details: https://github.com/owner/repo/runs/123');
  expect(result).toContain('#### test — cancelled');
  expect(result).toContain('Details: https://github.com/owner/repo/runs/456');
});

test('it omits CI Status section when overall status is success', () => {
  const ciStatus: CIStatusResult = {
    overall: 'success',
    failedCheckRuns: [],
  };

  const { params } = setupTest({
    prNumber: 99,
    prTitle: 'fix(auth): refresh expired tokens',
    prFiles: [],
    prReviews: { reviews: [], comments: [] },
    ciStatus,
  });

  const result = buildImplementorTriggerPrompt(params);

  expect(result).not.toContain('### CI Status');
});

test('it omits CI Status section when overall status is pending', () => {
  const ciStatus: CIStatusResult = {
    overall: 'pending',
    failedCheckRuns: [],
  };

  const { params } = setupTest({
    prNumber: 99,
    prTitle: 'fix(auth): refresh expired tokens',
    prFiles: [],
    prReviews: { reviews: [], comments: [] },
    ciStatus,
  });

  const result = buildImplementorTriggerPrompt(params);

  expect(result).not.toContain('### CI Status');
});

test('it omits CI Status section when ciStatus is undefined', () => {
  const { params } = setupTest({
    prNumber: 99,
    prTitle: 'fix(auth): refresh expired tokens',
    prFiles: [],
    prReviews: { reviews: [], comments: [] },
  });

  const result = buildImplementorTriggerPrompt(params);

  expect(result).not.toContain('### CI Status');
});

test('it places CI Status section between Changed Files and Prior Reviews', () => {
  const ciStatus: CIStatusResult = {
    overall: 'failure',
    failedCheckRuns: [
      {
        name: 'build',
        status: 'completed',
        conclusion: 'failure',
        detailsURL: 'https://github.com/owner/repo/runs/789',
      },
    ],
  };

  const prReviews: PRReviewsResult = {
    reviews: [{ id: 1, author: 'alice', state: 'APPROVED', body: 'Looks good!' }],
    comments: [],
  };

  const { params } = setupTest({
    prNumber: 99,
    prTitle: 'fix(auth): refresh expired tokens',
    prFiles: [{ filename: 'src/code.ts', status: 'modified', patch: '@@ -1,1 +1,2 @@' }],
    prReviews,
    ciStatus,
  });

  const result = buildImplementorTriggerPrompt(params);

  const changedFilesIndex = result.indexOf('### Changed Files');
  const ciStatusIndex = result.indexOf('### CI Status: FAILURE');
  const priorReviewsIndex = result.indexOf('### Prior Reviews');

  expect(changedFilesIndex).toBeLessThan(ciStatusIndex);
  expect(ciStatusIndex).toBeLessThan(priorReviewsIndex);
});

test('it includes all failed check run conclusions in CI Status section', () => {
  const ciStatus: CIStatusResult = {
    overall: 'failure',
    failedCheckRuns: [
      {
        name: 'check-1',
        status: 'completed',
        conclusion: 'failure',
        detailsURL: 'https://github.com/owner/repo/runs/1',
      },
      {
        name: 'check-2',
        status: 'completed',
        conclusion: 'cancelled',
        detailsURL: 'https://github.com/owner/repo/runs/2',
      },
      {
        name: 'check-3',
        status: 'completed',
        conclusion: 'timed_out',
        detailsURL: 'https://github.com/owner/repo/runs/3',
      },
    ],
  };

  const { params } = setupTest({
    prNumber: 99,
    prTitle: 'fix(auth): refresh expired tokens',
    prFiles: [],
    prReviews: { reviews: [], comments: [] },
    ciStatus,
  });

  const result = buildImplementorTriggerPrompt(params);

  expect(result).toContain('#### check-1 — failure');
  expect(result).toContain('#### check-2 — cancelled');
  expect(result).toContain('#### check-3 — timed_out');
});
