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
    labels: extractLabelNames(data.labels),
    createdAt: data.created_at,
  };
}

function extractLabelNames(labels: (string | { name?: string })[]): string[] {
  const result: string[] = [];
  for (const label of labels) {
    if (typeof label === 'string') {
      result.push(label);
      continue;
    }
    if (label.name != null) {
      result.push(label.name);
    }
  }
  return result;
}
