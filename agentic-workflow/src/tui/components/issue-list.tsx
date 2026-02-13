import { Box, Text } from 'ink';
import type { ReactNode } from 'react';
import { match } from 'ts-pattern';
import type { StoreApi } from 'zustand';
import { useStore } from 'zustand';
import { selectActionCount, selectAgentSectionCount, selectSortedTasks } from '../store.ts';
import type { CIStatus, Priority, SortedTask, Task, TaskStatus, TUIStore } from '../types.ts';

export interface IssueListProps {
  store: StoreApi<TUIStore>;
  paneWidth: number;
  paneHeight: number;
}

interface SectionSlice {
  items: SortedTask[];
  capacity: number;
  total: number;
}

const ISSUE_COL_WIDTH = 6;
const PR_COL_WIDTH = 8;
const STATUS_COL_WIDTH = 10;
const ICON_COL_WIDTH = 2;
const COLUMN_GAPS = 4;
const FIXED_COLUMNS_WIDTH: number =
  ISSUE_COL_WIDTH + PR_COL_WIDTH + STATUS_COL_WIDTH + ICON_COL_WIDTH + COLUMN_GAPS;
const HORIZONTAL_PADDING = 1;

const SECTION_HEADER_ROWS = 1;
const MIN_SECTIONS = 2;

const ELLIPSIS = '\u2026';

const STATUS_DISPLAY: Record<TaskStatus, string> = {
  'ready-to-merge': 'APPROVED',
  'agent-crashed': 'FAILED',
  blocked: 'BLOCKED',
  'needs-refinement': 'REFINE',
  'ready-to-implement': 'DISPATCH',
  'agent-implementing': 'WIP',
  'agent-reviewing': 'REVIEW',
};

const STATUS_ICON: Record<TaskStatus, string> = {
  'ready-to-merge': '\u2714',
  // biome-ignore lint/security/noSecrets: emoji character, not a secret
  'agent-crashed': '\uD83D\uDCA5',
  blocked: '\u26D4',
  'needs-refinement': '\uD83D\uDCDD',
  'ready-to-implement': '\u25CF',
  // biome-ignore lint/security/noSecrets: emoji character, not a secret
  'agent-implementing': '\uD83E\uDD16',
  // biome-ignore lint/security/noSecrets: emoji character, not a secret
  'agent-reviewing': '\uD83D\uDD0E',
};

const CI_STATUS_PRIORITY: Record<string, number> = {
  failure: 3,
  pending: 2,
  success: 1,
};

export function IssueList(props: IssueListProps): ReactNode {
  const tasks = useStore(props.store, (s) => s.tasks);
  const selectedIssue = useStore(props.store, (s) => s.selectedIssue);
  const actionCount = useStore(props.store, selectActionCount);
  const agentSectionCount = useStore(props.store, selectAgentSectionCount);

  const sortedTasks = selectSortedTasks(tasks);

  const actionItems = sortedTasks.filter((st) => st.section === 'action');
  const agentItems = sortedTasks.filter((st) => st.section === 'agents');

  const contentHeight = props.paneHeight;
  const actionPaneHeight = Math.ceil(contentHeight / MIN_SECTIONS);
  const agentsPaneHeight = Math.floor(contentHeight / MIN_SECTIONS);

  const actionCapacity = Math.max(0, actionPaneHeight - SECTION_HEADER_ROWS);
  const agentsCapacity = Math.max(0, agentsPaneHeight - SECTION_HEADER_ROWS);

  const actionSlice = buildSectionSlice(actionItems, actionCapacity, actionCount);
  const agentsSlice = buildSectionSlice(agentItems, agentsCapacity, agentSectionCount);

  const titleWidth = Math.max(0, props.paneWidth - FIXED_COLUMNS_WIDTH - HORIZONTAL_PADDING);

  return (
    <Box flexDirection="column" height={contentHeight}>
      <Box flexDirection="column" height={actionPaneHeight}>
        <SectionHeader label="ACTION" slice={actionSlice} />
        {actionSlice.items.map((st) => (
          <TaskRow
            key={st.task.issueNumber}
            task={st.task}
            selected={st.task.issueNumber === selectedIssue}
            titleWidth={titleWidth}
          />
        ))}
      </Box>
      <Box flexDirection="column" height={agentsPaneHeight}>
        <SectionHeader label="AGENTS" slice={agentsSlice} />
        {agentsSlice.items.map((st) => (
          <TaskRow
            key={st.task.issueNumber}
            task={st.task}
            selected={st.task.issueNumber === selectedIssue}
            titleWidth={titleWidth}
          />
        ))}
      </Box>
    </Box>
  );
}

export function getVisibleTasks(
  sortedTasks: SortedTask[],
  actionCapacity: number,
  agentsCapacity: number,
): SortedTask[] {
  const actionItems = sortedTasks.filter((st) => st.section === 'action');
  const agentItems = sortedTasks.filter((st) => st.section === 'agents');
  return [...actionItems.slice(0, actionCapacity), ...agentItems.slice(0, agentsCapacity)];
}

export function computeSectionCapacities(paneHeight: number): {
  actionCapacity: number;
  agentsCapacity: number;
} {
  const actionPaneHeight = Math.ceil(paneHeight / MIN_SECTIONS);
  const agentsPaneHeight = Math.floor(paneHeight / MIN_SECTIONS);
  return {
    actionCapacity: Math.max(0, actionPaneHeight - SECTION_HEADER_ROWS),
    agentsCapacity: Math.max(0, agentsPaneHeight - SECTION_HEADER_ROWS),
  };
}

// ---------------------------------------------------------------------------
// Section Header
// ---------------------------------------------------------------------------

interface SectionHeaderProps {
  label: string;
  slice: SectionSlice;
}

function SectionHeader(props: SectionHeaderProps): ReactNode {
  const countDisplay =
    props.slice.items.length < props.slice.total
      ? `(${props.slice.items.length}/${props.slice.total})`
      : `(${props.slice.total})`;

  return (
    <Box paddingLeft={HORIZONTAL_PADDING}>
      <Text bold={true} dimColor={true}>
        {props.label} {countDisplay}
      </Text>
    </Box>
  );
}

// ---------------------------------------------------------------------------
// Task Row
// ---------------------------------------------------------------------------

interface TaskRowProps {
  task: Task;
  selected: boolean;
  titleWidth: number;
}

function TaskRow(props: TaskRowProps): ReactNode {
  const issueCol = renderIssueColumn(props.task);
  const prCol = renderPRColumn(props.task);
  const statusCol = renderStatusColumn(props.task);
  const iconCol = renderIconColumn(props.task);
  const titleCol = truncateText(props.task.title, props.titleWidth);

  return (
    <Box paddingLeft={HORIZONTAL_PADDING}>
      <Text inverse={props.selected}>
        {issueCol} {prCol} {statusCol} {iconCol} {titleCol}
      </Text>
    </Box>
  );
}

// ---------------------------------------------------------------------------
// Column Renderers
// ---------------------------------------------------------------------------

function renderIssueColumn(task: Task): string {
  const issueStr = `#${task.issueNumber}`;
  return padRight(issueStr, ISSUE_COL_WIDTH);
}

export function getIssuePriorityColor(priority: Priority | null): string | undefined {
  if (priority === null) {
    return;
  }
  return match(priority)
    .with('high', () => 'red')
    .with('medium', () => 'yellow')
    .with('low', () => 'dim')
    .exhaustive();
}

function renderPRColumn(task: Task): string {
  if (task.prs.length === 0) {
    return padRight('\u2014', PR_COL_WIDTH);
  }
  if (task.prs.length === 1) {
    const pr = task.prs[0];
    if (pr) {
      return padRight(`PR#${pr.number}`, PR_COL_WIDTH);
    }
  }
  return padRight(`PRx${task.prs.length}`, PR_COL_WIDTH);
}

export function getWorstCIStatus(prs: Array<{ ciStatus: CIStatus | null }>): CIStatus | null {
  let worst: CIStatus | null = null;
  let worstPriority = 0;

  for (const pr of prs) {
    if (pr.ciStatus !== null) {
      const priority = CI_STATUS_PRIORITY[pr.ciStatus] ?? 0;
      if (priority > worstPriority) {
        worstPriority = priority;
        worst = pr.ciStatus;
      }
    }
  }

  return worst;
}

export function getCIStatusColor(ciStatus: CIStatus | null): string | undefined {
  if (ciStatus === null) {
    return 'dim';
  }
  return match(ciStatus)
    .with('failure', () => 'red')
    .with('pending', () => 'dim')
    .with('success', () => 'green')
    .exhaustive();
}

function renderStatusColumn(task: Task): string {
  const display = STATUS_DISPLAY[task.status] ?? '';
  if (task.status === 'agent-implementing') {
    return padRight(`WIP(${task.agentCount})`, STATUS_COL_WIDTH);
  }
  return padRight(display, STATUS_COL_WIDTH);
}

function renderIconColumn(task: Task): string {
  const icon = STATUS_ICON[task.status] ?? '';
  return padRight(icon, ICON_COL_WIDTH);
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function buildSectionSlice(items: SortedTask[], capacity: number, total: number): SectionSlice {
  return {
    items: items.slice(0, capacity),
    capacity,
    total,
  };
}

function padRight(text: string, width: number): string {
  if (text.length >= width) {
    return text.slice(0, width);
  }
  return text + ' '.repeat(width - text.length);
}

function truncateText(text: string, maxWidth: number): string {
  if (maxWidth <= 0) {
    return '';
  }
  if (text.length <= maxWidth) {
    return text;
  }
  if (maxWidth === 1) {
    return ELLIPSIS;
  }
  return text.slice(0, maxWidth - 1) + ELLIPSIS;
}
