import type { SpecChange, SpecPollerBatchResult } from '../../types.ts';
import type { GitHubClient } from '../github-client/types.ts';
import { parseFrontmatterStatus } from './parse-frontmatter-status.ts';
import type { LogError, SpecPoller, SpecPollerFileEntry, SpecPollerSnapshot } from './types.ts';

interface SpecPollerConfig {
  octokit: GitHubClient;
  owner: string;
  repo: string;
  specsDir: string;
  defaultBranch: string;
  logError?: LogError;
  initialSnapshot?: SpecPollerSnapshot;
}

interface SpecSnapshot {
  treeSHA: string | null;
  fileSHAs: Map<string, string>; // filePath -> blob SHA
  fileStatuses: Map<string, string>; // filePath -> frontmatterStatus
}

const EMPTY_RESULT: SpecPollerBatchResult = { changes: [], commitSHA: '' };

export function createSpecPoller(config: SpecPollerConfig): SpecPoller {
  const { octokit, owner, repo, specsDir, defaultBranch } = config;
  const logError = config.logError ?? defaultLogError;

  const snapshot: SpecSnapshot = buildInitialSnapshot(config.initialSnapshot);

  async function getSpecsDirTreeSha(): Promise<string | null> {
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
      const currentTreeSha = await getSpecsDirTreeSha();
      if (!currentTreeSha) {
        return EMPTY_RESULT;
      }

      // Step 2: Compare tree SHA against snapshot -- if unchanged, done
      if (currentTreeSha === snapshot.treeSHA) {
        return EMPTY_RESULT;
      }

      // Step 3: Tree SHA changed -- fetch full subtree to identify changes
      const specsTree = await octokit.git.getTree({
        owner,
        repo,
        tree_sha: currentTreeSha,
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
      const changeTypes = new Map<string, 'added' | 'modified'>();
      for (const [filePath, blobSha] of currentFiles) {
        if (snapshot.fileSHAs.get(filePath) !== blobSha) {
          changedFilePaths.push(filePath);
          changeTypes.set(filePath, snapshot.fileSHAs.has(filePath) ? 'modified' : 'added');
        }
      }

      // Step 6: Fetch content of changed files and parse frontmatter
      const fetchResults = await Promise.allSettled(
        changedFilePaths.map((filePath) =>
          octokit.repos
            .getContent({ owner, repo, path: filePath, ref: defaultBranch })
            .then((fileResponse) => ({ filePath, fileResponse })),
        ),
      );

      const changes: SpecChange[] = [];
      for (const result of fetchResults) {
        if (result.status === 'rejected') {
          logError('Failed to fetch spec content', result.reason);
        } else {
          const data = result.value.fileResponse.data;
          if ('content' in data && data.content) {
            const content = Buffer.from(data.content, 'base64').toString('utf-8');
            const status = parseFrontmatterStatus(content);
            if (status) {
              const filePath = result.value.filePath;
              const changeType = changeTypes.get(filePath) ?? 'added';
              changes.push({ filePath, frontmatterStatus: status, changeType });
              snapshot.fileStatuses.set(filePath, status);
            }
          }
        }
      }

      // Update blob SHAs in snapshot for all current files
      for (const [filePath, blobSha] of currentFiles) {
        snapshot.fileSHAs.set(filePath, blobSha);
      }

      // Step 7: Fetch HEAD commit SHA (only when changes detected)
      let commitSha = '';
      if (changes.length > 0) {
        const ref = await octokit.git.getRef({
          owner,
          repo,
          ref: `heads/${defaultBranch}`,
        });
        commitSha = ref.data.object.sha;
      }

      // Step 8: Update snapshot tree SHA
      snapshot.treeSHA = currentTreeSha;

      return { changes, commitSHA: commitSha };
    } catch (error) {
      logError('SpecPoller poll cycle failed', error);
      return EMPTY_RESULT;
    }
  }

  function getSnapshot(): SpecPollerSnapshot {
    const files: Record<string, SpecPollerFileEntry> = {};
    for (const [path, blobSha] of snapshot.fileSHAs) {
      const frontmatterStatus = snapshot.fileStatuses.get(path) ?? '';
      files[path] = { blobSHA: blobSha, frontmatterStatus };
    }
    return { specsDirTreeSHA: snapshot.treeSHA, files };
  }

  return { poll, getSnapshot };
}

function buildInitialSnapshot(initial?: SpecPollerSnapshot): SpecSnapshot {
  if (!initial) {
    return { treeSHA: null, fileSHAs: new Map(), fileStatuses: new Map() };
  }

  const fileShAs = new Map<string, string>();
  const fileStatuses = new Map<string, string>();
  for (const [path, entry] of Object.entries(initial.files)) {
    fileShAs.set(path, entry.blobSHA);
    fileStatuses.set(path, entry.frontmatterStatus);
  }
  return { treeSHA: initial.specsDirTreeSHA, fileSHAs: fileShAs, fileStatuses };
}

function defaultLogError(message: string, error: unknown): void {
  // biome-ignore lint/suspicious/noConsole: fallback logger when none is injected
  console.error(message, error);
}
