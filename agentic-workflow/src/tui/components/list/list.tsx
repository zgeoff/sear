import { Box } from 'ink';
import type { ReactNode } from 'react';
import { ListItem } from './list-item.tsx';
import type { ListItemData } from './types.ts';

export interface ListProps {
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

export function List(props: ListProps): ReactNode {
  const visibleItemCount = Math.max(0, props.paneHeight);

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
      {visibleItems.map((item, index) => (
        <ListItem
          key={item.key}
          content={item.content}
          richContent={item.richContent}
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
