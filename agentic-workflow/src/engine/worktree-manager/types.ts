export type WorktreeResult = {
  worktreePath: string;
  branch: string;
  created: boolean; // true if newly created, false if reused
};

export type ExecGit = (args: string[]) => Promise<{ stdout: string; stderr: string }>;

export type WorktreeManagerDeps = {
  repoRoot: string;
  execGit?: ExecGit;
};

export type WorktreeManager = {
  createOrReuse(issueNumber: number): Promise<WorktreeResult>;
  remove(issueNumber: number): Promise<void>;
};
