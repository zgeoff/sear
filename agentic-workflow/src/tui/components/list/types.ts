import type { ReactNode } from 'react';

export interface ListItemData {
  key: string;
  content: string;
  richContent?: ReactNode;
}

export interface ScrollState {
  viewportOffset: number;
  mouseScrolled: boolean;
}
