import { expect, test } from 'vitest';
import type {
  IssueDetailsResult,
  PRFileEntry,
  PRInlineComment,
  PRReview,
  PRReviewsResult,
} from '../../types.ts';
import { buildReviewerTriggerPrompt } from './build-reviewer-trigger-prompt.ts';
import type { BuildReviewerTriggerPromptParams } from './types.ts';

function setupTest(overrides?: Partial<BuildReviewerTriggerPromptParams>): {
  params: BuildReviewerTriggerPromptParams;
} {
  const issueDetails: IssueDetailsResult = {
    number: 42,
    title: 'Fix authentication bug',
    body: 'The login flow fails when the token expires.',
    labels: ['task:implement', 'status:review', 'priority:high'],
    createdAt: '2026-01-15T10:00:00Z',
  };

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

  const params: BuildReviewerTriggerPromptParams = {
    issueDetails: overrides?.issueDetails ?? issueDetails,
    prNumber: overrides?.prNumber ?? 99,
    prTitle: overrides?.prTitle ?? 'fix(auth): refresh expired tokens',
    prFiles: overrides?.prFiles ?? prFiles,
    prReviews: overrides?.prReviews ?? prReviews,
  };

  return { params };
}

test('it includes the issue number, title, and body in the prompt', () => {
  const { params } = setupTest();

  const result = buildReviewerTriggerPrompt(params);

  expect(result).toContain('## Task Issue #42 — Fix authentication bug');
  expect(result).toContain('The login flow fails when the token expires.');
});

test('it includes comma-separated label names', () => {
  const { params } = setupTest();

  const result = buildReviewerTriggerPrompt(params);

  expect(result).toContain('### Labels');
  expect(result).toContain('task:implement, status:review, priority:high');
});

test('it includes the PR number and title in the header', () => {
  const { params } = setupTest();

  const result = buildReviewerTriggerPrompt(params);

  expect(result).toContain('## PR #99 — fix(auth): refresh expired tokens');
});

test('it includes per-file patches with filename and status', () => {
  const { params } = setupTest();

  const result = buildReviewerTriggerPrompt(params);

  expect(result).toContain('#### src/auth/login.ts (modified)');
  expect(result).toContain(
    '@@ -10,3 +10,5 @@\n-const token = getToken();\n+const token = refreshToken();',
  );
  expect(result).toContain('#### src/auth/login.test.ts (modified)');
});

test('it includes prior review submissions with author and state', () => {
  const { params } = setupTest();

  const result = buildReviewerTriggerPrompt(params);

  expect(result).toContain('### Prior Reviews');
  expect(result).toContain('#### Review by reviewer1 — CHANGES_REQUESTED');
  expect(result).toContain('Please add error handling for the refresh call.');
});

test('it includes prior inline comments with path, line, and author', () => {
  const { params } = setupTest();

  const result = buildReviewerTriggerPrompt(params);

  expect(result).toContain('### Prior Inline Comments');
  expect(result).toContain('#### src/auth/login.ts:12 — reviewer1');
  expect(result).toContain('This should handle the case where refreshToken throws.');
});

test('it omits the prior reviews section when there are no reviews', () => {
  const { params } = setupTest({
    prReviews: { reviews: [], comments: [] },
  });

  const result = buildReviewerTriggerPrompt(params);

  expect(result).not.toContain('### Prior Reviews');
});

test('it omits the prior inline comments section when there are no comments', () => {
  const { params } = setupTest({
    prReviews: { reviews: [], comments: [] },
  });

  const result = buildReviewerTriggerPrompt(params);

  expect(result).not.toContain('### Prior Inline Comments');
});

test('it omits comments section but keeps reviews section when only reviews exist', () => {
  const { params } = setupTest({
    prReviews: {
      reviews: [{ id: 1, author: 'alice', state: 'APPROVED', body: 'Looks good!' }],
      comments: [],
    },
  });

  const result = buildReviewerTriggerPrompt(params);

  expect(result).toContain('### Prior Reviews');
  expect(result).toContain('#### Review by alice — APPROVED');
  expect(result).not.toContain('### Prior Inline Comments');
});

test('it omits reviews section but keeps comments section when only comments exist', () => {
  const { params } = setupTest({
    prReviews: {
      reviews: [],
      comments: [
        { id: 5, author: 'bob', body: 'Nit: rename this variable', path: 'src/foo.ts', line: 7 },
      ],
    },
  });

  const result = buildReviewerTriggerPrompt(params);

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
    prFiles: [binaryFile],
  });

  const result = buildReviewerTriggerPrompt(params);

  expect(result).toContain('#### assets/logo.png (added)');
  // Should not have a code block after the binary file entry
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

  const { params } = setupTest({ prFiles: files });

  const result = buildReviewerTriggerPrompt(params);

  expect(result).toContain('#### src/code.ts (modified)');
  expect(result).toContain('@@ -1,1 +1,2 @@\n+new line');
  expect(result).toContain('#### assets/image.png (added)');
  expect(result).toContain('#### src/other.ts (removed)');
  expect(result).toContain('@@ -1,3 +0,0 @@\n-removed content');
});

test('it preserves chronological order of reviews', () => {
  const reviews: PRReview[] = [
    { id: 1, author: 'alice', state: 'COMMENTED', body: 'First review' },
    { id: 2, author: 'bob', state: 'CHANGES_REQUESTED', body: 'Second review' },
    { id: 3, author: 'alice', state: 'APPROVED', body: 'Third review' },
  ];

  const { params } = setupTest({
    prReviews: { reviews, comments: [] },
  });

  const result = buildReviewerTriggerPrompt(params);

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
    prReviews: { reviews: [], comments },
  });

  const result = buildReviewerTriggerPrompt(params);

  const firstIndex = result.indexOf('Comment one');
  const secondIndex = result.indexOf('Comment two');
  const thirdIndex = result.indexOf('Comment three');

  expect(firstIndex).toBeLessThan(secondIndex);
  expect(secondIndex).toBeLessThan(thirdIndex);
});

test('it does not include the issue creation date in the prompt', () => {
  const { params } = setupTest();

  const result = buildReviewerTriggerPrompt(params);

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

  const result = buildReviewerTriggerPrompt(params);

  expect(result).toContain('### Labels');
  expect(result).toContain('## Task Issue #42 — Fix bug');
});

test('it handles inline comments with null line numbers', () => {
  const comments: PRInlineComment[] = [
    { id: 1, author: 'alice', body: 'Outdated comment', path: 'src/old.ts', line: null },
  ];

  const { params } = setupTest({
    prReviews: { reviews: [], comments },
  });

  const result = buildReviewerTriggerPrompt(params);

  expect(result).toContain('#### src/old.ts:outdated — alice');
  expect(result).toContain('Outdated comment');
});

test('it handles an empty files array', () => {
  const { params } = setupTest({
    prFiles: [],
    prReviews: { reviews: [], comments: [] },
  });

  const result = buildReviewerTriggerPrompt(params);

  expect(result).toContain('### Changed Files');
  // No file entries and no reviews/comments — no #### headings
  expect(result).not.toContain('####');
});

test('it produces the correct overall structure for a complete prompt', () => {
  const { params } = setupTest();

  const result = buildReviewerTriggerPrompt(params);

  // Verify the sections appear in the correct order
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
