import type { PRFileEntry } from '../../types.ts';
import type { QueriesConfig } from './types.ts';

const PER_PAGE = 100;
const VALID_STATUSES: Record<string, PRFileEntry['status']> = {
  added: 'added',
  modified: 'modified',
  removed: 'removed',
  renamed: 'renamed',
  copied: 'copied',
  changed: 'changed',
  unchanged: 'unchanged',
};

export async function getPRFiles(config: QueriesConfig, prNumber: number): Promise<PRFileEntry[]> {
  const { octokit, owner, repo } = config;

  const { data: files } = await octokit.pulls.listFiles({
    owner,
    repo,
    pull_number: prNumber,
    per_page: PER_PAGE,
  });

  return files.map((file) => normalizeFileEntry(file));
}

function normalizeFileEntry(file: {
  filename: string;
  status: string;
  patch?: string;
}): PRFileEntry {
  return {
    filename: file.filename,
    status: VALID_STATUSES[file.status] ?? 'changed',
    ...(file.patch !== undefined && { patch: file.patch }),
  };
}
