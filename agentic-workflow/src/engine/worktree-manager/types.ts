export interface WorktreeResult {
  worktreePath: string;
  branch: string;
  created: boolean; // true if newly created, false if reused
}

export type ExecGit = (args: string[]) => Promise<{ stdout: string; stderr: string }>;

export interface WorktreeManagerDeps {
  repoRoot: string;
  execGit?: ExecGit;
}

export interface WorktreeManager {
  createOrReuse: (issueNumber: number) => Promise<WorktreeResult>;
  remove: (issueNumber: number) => Promise<void>;
}
