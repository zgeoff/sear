import { Box, Text } from 'ink';
import type { ReactNode } from 'react';
import { ListItem } from './list-item.tsx';
import type { ListItemData } from './types.ts';

export interface ListProps {
  label: string;
  items: readonly ListItemData[];
  selectedIndex: number;
  focused: boolean;
  paneWidth: number;
  paneHeight: number;
  viewportOffset: number;
  onViewportOffsetChange: (offset: number) => void;
  mouseScrolled: boolean;
  onMouseScrolledChange: (scrolled: boolean) => void;
}

const CHROME_ROWS = 2;
const HORIZONTAL_PADDING = 1;

export function List(props: ListProps): ReactNode {
  const visibleItemCount = Math.max(0, props.paneHeight - CHROME_ROWS);
  const ruleWidth = Math.max(0, props.paneWidth - HORIZONTAL_PADDING * 2);
  const rule = '\u2500'.repeat(ruleWidth);

  const viewportStart = computeViewportStart({
    selectedIndex: props.selectedIndex,
    viewportOffset: props.viewportOffset,
    totalCount: props.items.length,
    visibleCount: visibleItemCount,
    mouseScrolled: props.mouseScrolled,
  });

  const visibleItems = props.items.slice(viewportStart, viewportStart + visibleItemCount);

  return (
    <Box flexDirection="column">
      <Box paddingLeft={HORIZONTAL_PADDING} paddingRight={HORIZONTAL_PADDING}>
        <Text bold={true}>{props.label.toUpperCase()}</Text>
      </Box>
      <Box paddingLeft={HORIZONTAL_PADDING} paddingRight={HORIZONTAL_PADDING}>
        <Text>{rule}</Text>
      </Box>
      {visibleItems.map((item, index) => (
        <ListItem
          key={item.key}
          content={item.content}
          selected={viewportStart + index === props.selectedIndex}
          focused={props.focused}
          visibleIndex={index}
          paneWidth={props.paneWidth}
        />
      ))}
    </Box>
  );
}

interface ComputeViewportStartParams {
  selectedIndex: number;
  viewportOffset: number;
  totalCount: number;
  visibleCount: number;
  mouseScrolled: boolean;
}

function computeViewportStart(params: ComputeViewportStartParams): number {
  const { selectedIndex, viewportOffset, totalCount, visibleCount, mouseScrolled } = params;
  if (totalCount <= visibleCount) {
    return 0;
  }

  if (mouseScrolled) {
    return clampViewportOffset(viewportOffset, totalCount, visibleCount);
  }

  let start = viewportOffset;

  if (selectedIndex < start) {
    start = selectedIndex;
  }

  if (selectedIndex >= start + visibleCount) {
    start = selectedIndex - visibleCount + 1;
  }

  return clampViewportOffset(start, totalCount, visibleCount);
}

function clampViewportOffset(offset: number, totalCount: number, visibleCount: number): number {
  const maxOffset = Math.max(0, totalCount - visibleCount);
  if (offset < 0) {
    return 0;
  }
  if (offset > maxOffset) {
    return maxOffset;
  }
  return offset;
}
