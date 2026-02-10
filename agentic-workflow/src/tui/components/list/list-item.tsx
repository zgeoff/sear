import { Box, Text } from 'ink';
import type { ReactNode } from 'react';

export interface ListItemProps {
  content: string;
  richContent?: ReactNode;
  selected: boolean;
  focused: boolean;
  visibleIndex: number;
  paneWidth: number;
}

const HORIZONTAL_PADDING = 1;
const ELLIPSIS = '\u2026';

export function ListItem(props: ListItemProps): ReactNode {
  const isOddRow = props.visibleIndex % 2 === 1;
  const showInverse = props.selected && props.focused;
  const showDimBackground = isOddRow && !showInverse;

  const availableWidth = props.paneWidth - HORIZONTAL_PADDING * 2;
  const needsTruncation = props.content.length > availableWidth;

  if (props.richContent && !needsTruncation) {
    return (
      <Box paddingLeft={HORIZONTAL_PADDING} paddingRight={HORIZONTAL_PADDING}>
        <Text inverse={showInverse} dimColor={showDimBackground}>
          {props.richContent}
        </Text>
      </Box>
    );
  }

  const displayContent = truncateContent(props.content, availableWidth);

  return (
    <Box paddingLeft={HORIZONTAL_PADDING} paddingRight={HORIZONTAL_PADDING}>
      <Text inverse={showInverse} dimColor={showDimBackground}>
        {displayContent}
      </Text>
    </Box>
  );
}

function truncateContent(content: string, maxWidth: number): string {
  if (maxWidth <= 0) {
    return '';
  }
  if (content.length <= maxWidth) {
    return content;
  }
  if (maxWidth === 1) {
    return ELLIPSIS;
  }
  return content.slice(0, maxWidth - 1) + ELLIPSIS;
}
