export type ListProps = {
  label: string;
  items: ReadonlyArray<ListItemData>;
  selectedIndex: number;
  focused: boolean;
  paneWidth: number;
  paneHeight: number;
  viewportOffset: number;
  onViewportOffsetChange: (offset: number) => void;
  mouseScrolled: boolean;
  onMouseScrolledChange: (scrolled: boolean) => void;
};

export type ListItemData = {
  key: string;
  content: string;
};

export type ListItemProps = {
  content: string;
  selected: boolean;
  focused: boolean;
  visibleIndex: number;
  paneWidth: number;
};

export type ScrollState = {
  viewportOffset: number;
  mouseScrolled: boolean;
};
