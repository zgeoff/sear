import type {
  CrashRecoveryParams,
  Recovery,
  RecoveryConfig,
  StartupRecoveryResult,
} from './types.ts';

export function createRecovery(config: RecoveryConfig): Recovery {
  return {
    performStartupRecovery: () => performStartupRecovery(config),
    performCrashRecovery: (params: CrashRecoveryParams): Promise<void> =>
      performCrashRecovery(config, params),
  };
}

async function performStartupRecovery(config: RecoveryConfig): Promise<StartupRecoveryResult> {
  const { octokit, owner, repo, emitter } = config;

  const { data: issues } = await octokit.issues.listForRepo({
    owner,
    repo,
    labels: 'task:implement,status:in-progress',
    state: 'open',
    per_page: 100,
  });

  await Promise.all(issues.map((issue) => resetIssueToPending(octokit, owner, repo, issue.number)));

  for (const issue of issues) {
    const priorityLabel = extractPriorityLabel(issue.labels);

    emitter.emit({
      type: 'issueStatusChanged',
      issueNumber: issue.number,
      title: issue.title,
      oldStatus: 'in-progress',
      newStatus: 'pending',
      priorityLabel,
      createdAt: issue.created_at,
      isRecovery: true,
    });
  }

  return { recoveriesPerformed: issues.length };
}

async function performCrashRecovery(
  config: RecoveryConfig,
  params: CrashRecoveryParams,
): Promise<void> {
  const { octokit, owner, repo, emitter } = config;
  const { agentType, issueNumber, snapshot } = params;

  if (agentType === 'planner') {
    return;
  }

  if (agentType === 'reviewer') {
    return;
  }

  const entry = snapshot.get(issueNumber);
  if (!entry) {
    return;
  }

  if (entry.statusLabel !== 'in-progress') {
    return;
  }

  await resetIssueToPending(octokit, owner, repo, issueNumber);

  snapshot.set(issueNumber, {
    ...entry,
    statusLabel: 'pending',
  });

  emitter.emit({
    type: 'issueStatusChanged',
    issueNumber,
    title: entry.title,
    oldStatus: 'in-progress',
    newStatus: 'pending',
    priorityLabel: entry.priorityLabel,
    createdAt: entry.createdAt,
    isRecovery: true,
  });
}

async function resetIssueToPending(
  octokit: RecoveryConfig['octokit'],
  owner: string,
  repo: string,
  issueNumber: number,
): Promise<void> {
  await octokit.issues.removeLabel({
    owner,
    repo,
    issue_number: issueNumber,
    name: 'status:in-progress',
  });

  await octokit.issues.addLabels({
    owner,
    repo,
    issue_number: issueNumber,
    labels: ['status:pending'],
  });
}

function extractPriorityLabel(labels: (string | { name?: string })[]): string {
  for (const label of labels) {
    const name = typeof label === 'string' ? label : label.name;
    if (name?.startsWith('priority:')) {
      return name;
    }
  }
  return '';
}
