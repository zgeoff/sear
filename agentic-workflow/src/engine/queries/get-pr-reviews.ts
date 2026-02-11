import type { PRInlineComment, PRReview, PRReviewsResult } from '../../types.ts';
import type { QueriesConfig } from './types.ts';

const PER_PAGE = 100;

export async function getPRReviews(
  config: QueriesConfig,
  prNumber: number,
): Promise<PRReviewsResult> {
  const { octokit, owner, repo } = config;

  const [reviewsResult, commentsResult] = await Promise.all([
    octokit.pulls.listReviews({
      owner,
      repo,
      pull_number: prNumber,
      per_page: PER_PAGE,
    }),
    octokit.pulls.listReviewComments({
      owner,
      repo,
      pull_number: prNumber,
      per_page: PER_PAGE,
    }),
  ]);

  return {
    reviews: normalizeReviews(reviewsResult.data),
    comments: normalizeComments(commentsResult.data),
  };
}

function normalizeReviews(
  reviews: { id: number; user: { login: string } | null; state: string; body: string | null }[],
): PRReview[] {
  return reviews.map((review) => ({
    id: review.id,
    author: review.user?.login ?? '',
    state: review.state as PRReview['state'],
    body: review.body ?? '',
  }));
}

function normalizeComments(
  comments: {
    id: number;
    user: { login: string } | null;
    body: string | null;
    path: string;
    line: number | null;
  }[],
): PRInlineComment[] {
  return comments.map((comment) => ({
    id: comment.id,
    author: comment.user?.login ?? '',
    body: comment.body ?? '',
    path: comment.path,
    line: comment.line,
  }));
}
