import type { SpecChange, SpecPollerBatchResult } from '../../types';
import type { GitHubClient } from '../github-client/types';
import { parseFrontmatterStatus } from './parse-frontmatter-status';
import type { LogError, SpecPoller } from './types';

type SpecPollerConfig = {
  octokit: GitHubClient;
  owner: string;
  repo: string;
  specsDir: string;
  defaultBranch: string;
  logError?: LogError;
};

type SpecSnapshot = {
  treeSHA: string | null;
  fileSHAs: Map<string, string>; // filePath -> blob SHA
  fileStatuses: Map<string, string>; // filePath -> frontmatterStatus
};

const EMPTY_RESULT: SpecPollerBatchResult = { changes: [], commitSHA: '' };

export function createSpecPoller(config: SpecPollerConfig): SpecPoller {
  const { octokit, owner, repo, specsDir, defaultBranch, logError = console.error } = config;

  const snapshot: SpecSnapshot = {
    treeSHA: null,
    fileSHAs: new Map(),
    fileStatuses: new Map(),
  };

  async function getSpecsDirTreeSHA(): Promise<string | null> {
    // Fetch the tree SHA of the specs directory using a single recursive API call.
    // The recursive tree includes entries with full paths, so we can find the
    // specs directory entry directly without walking path segments.
    const normalizedDir = specsDir.endsWith('/') ? specsDir.slice(0, -1) : specsDir;

    const treeResponse = await octokit.git.getTree({
      owner,
      repo,
      tree_sha: defaultBranch,
      recursive: 'true',
    });

    const entry = treeResponse.data.tree.find((e) => e.path === normalizedDir && e.type === 'tree');

    return entry?.sha ?? null;
  }

  async function poll(): Promise<SpecPollerBatchResult> {
    try {
      // Step 1: Fetch the tree SHA of the specs directory
      const currentTreeSHA = await getSpecsDirTreeSHA();
      if (!currentTreeSHA) return EMPTY_RESULT;

      // Step 2: Compare tree SHA against snapshot -- if unchanged, done
      if (currentTreeSHA === snapshot.treeSHA) {
        return EMPTY_RESULT;
      }

      // Step 3: Tree SHA changed -- fetch full subtree to identify changes
      const specsTree = await octokit.git.getTree({
        owner,
        repo,
        tree_sha: currentTreeSHA,
        recursive: 'true',
      });

      // Build current file map from tree (blobs only)
      const currentFiles = new Map<string, string>();
      for (const entry of specsTree.data.tree) {
        if (entry.type === 'blob' && entry.path && entry.sha) {
          const fullPath = `${specsDir}${entry.path}`;
          currentFiles.set(fullPath, entry.sha);
        }
      }

      // Step 4: Handle removed files -- remove from snapshot, no event
      for (const existingPath of snapshot.fileSHAs.keys()) {
        if (!currentFiles.has(existingPath)) {
          snapshot.fileSHAs.delete(existingPath);
          snapshot.fileStatuses.delete(existingPath);
        }
      }

      // Step 5: Identify files that were added or modified (blob SHA differs)
      const changedFilePaths: string[] = [];
      for (const [filePath, blobSHA] of currentFiles) {
        if (snapshot.fileSHAs.get(filePath) !== blobSHA) {
          changedFilePaths.push(filePath);
        }
      }

      // Step 6: Fetch content of changed files and parse frontmatter
      const changes: SpecChange[] = [];
      for (const filePath of changedFilePaths) {
        try {
          const fileResponse = await octokit.repos.getContent({
            owner,
            repo,
            path: filePath,
            ref: defaultBranch,
          });

          const data = fileResponse.data;
          if (!('content' in data) || !data.content) continue;

          const content = Buffer.from(data.content, 'base64').toString('utf-8');
          const status = parseFrontmatterStatus(content);
          if (!status) continue;

          changes.push({ filePath, frontmatterStatus: status });
          snapshot.fileStatuses.set(filePath, status);
        } catch (error) {
          logError(`Failed to fetch spec content for ${filePath}`, error);
        }
      }

      // Update blob SHAs in snapshot for all current files
      for (const [filePath, blobSHA] of currentFiles) {
        snapshot.fileSHAs.set(filePath, blobSHA);
      }

      // Step 7: Fetch HEAD commit SHA (only when changes detected)
      let commitSHA = '';
      if (changes.length > 0) {
        const ref = await octokit.git.getRef({
          owner,
          repo,
          ref: `heads/${defaultBranch}`,
        });
        commitSHA = ref.data.object.sha;
      }

      // Step 8: Update snapshot tree SHA
      snapshot.treeSHA = currentTreeSHA;

      return { changes, commitSHA };
    } catch (error) {
      logError('SpecPoller poll cycle failed', error);
      return EMPTY_RESULT;
    }
  }

  return { poll };
}
