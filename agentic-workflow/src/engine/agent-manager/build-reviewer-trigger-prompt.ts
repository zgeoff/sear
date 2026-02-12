import type { PRFileEntry, PRInlineComment, PRReview } from '../../types.ts';
import type { BuildReviewerTriggerPromptParams } from './types.ts';

export function buildReviewerTriggerPrompt(params: BuildReviewerTriggerPromptParams): string {
  const sections: string[] = [];

  sections.push(buildIssueSection(params));
  sections.push(buildPRSection(params));

  const reviewsSection = buildReviewsSection(params.prReviews.reviews);
  if (reviewsSection !== null) {
    sections.push(reviewsSection);
  }

  const commentsSection = buildInlineCommentsSection(params.prReviews.comments);
  if (commentsSection !== null) {
    sections.push(commentsSection);
  }

  return sections.join('\n');
}

function buildIssueSection(params: BuildReviewerTriggerPromptParams): string {
  const lines: string[] = [];

  lines.push(`## Task Issue #${params.issueDetails.number} — ${params.issueDetails.title}`);
  lines.push('');
  lines.push(params.issueDetails.body);
  lines.push('');
  lines.push('### Labels');
  lines.push(params.issueDetails.labels.join(', '));
  lines.push('');

  return lines.join('\n');
}

function buildPRSection(params: BuildReviewerTriggerPromptParams): string {
  const lines: string[] = [];

  lines.push(`## PR #${params.prNumber} — ${params.prTitle}`);
  lines.push('');
  lines.push('### Changed Files');
  lines.push('');

  for (const file of params.prFiles) {
    lines.push(buildFileEntry(file));
  }

  return lines.join('\n');
}

function buildFileEntry(file: PRFileEntry): string {
  const lines: string[] = [];

  lines.push(`#### ${file.filename} (${file.status})`);

  if (file.patch !== undefined) {
    lines.push('```');
    lines.push(file.patch);
    lines.push('```');
  }

  lines.push('');

  return lines.join('\n');
}

function buildReviewsSection(reviews: PRReview[]): string | null {
  if (reviews.length === 0) {
    return null;
  }

  const lines: string[] = [];

  lines.push('### Prior Reviews');
  lines.push('');

  for (const review of reviews) {
    lines.push(`#### Review by ${review.author} — ${review.state}`);
    lines.push('');
    lines.push(review.body);
    lines.push('');
  }

  return lines.join('\n');
}

function buildInlineCommentsSection(comments: PRInlineComment[]): string | null {
  if (comments.length === 0) {
    return null;
  }

  const lines: string[] = [];

  lines.push('### Prior Inline Comments');
  lines.push('');

  for (const comment of comments) {
    const lineRef = comment.line !== null ? comment.line : 'outdated';
    lines.push(`#### ${comment.path}:${lineRef} — ${comment.author}`);
    lines.push('');
    lines.push(comment.body);
    lines.push('');
  }

  return lines.join('\n');
}
