import type { IssueDetailsResult } from '../../types';
import type { QueriesConfig } from './types';

export async function getIssueDetails(
  config: QueriesConfig,
  issueNumber: number,
): Promise<IssueDetailsResult> {
  const { octokit, owner, repo } = config;

  const { data } = await octokit.issues.get({
    owner,
    repo,
    issue_number: issueNumber,
  });

  return {
    number: data.number,
    title: data.title,
    body: data.body ?? '',
    labels: data.labels.map((label) => (typeof label === 'string' ? label : (label.name ?? ''))),
    createdAt: data.created_at,
  };
}
