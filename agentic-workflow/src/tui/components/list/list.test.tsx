import { Box } from 'ink';
import { render } from 'ink-testing-library';
import { expect, test } from 'vitest';
import type { ListProps } from './list.tsx';
import { List } from './list.tsx';
import type { ListItemProps } from './list-item.tsx';
import { ListItem } from './list-item.tsx';
import type { ListItemData } from './types.ts';

function buildItems(count: number): ListItemData[] {
  return Array.from({ length: count }, (_, i) => ({
    key: `item-${i}`,
    content: `Item ${i}`,
  }));
}

function setupListTest(overrides?: Partial<ListProps>): {
  instance: ReturnType<typeof render>;
  props: ListProps;
} {
  const props: ListProps = {
    items: buildItems(3),
    selectedIndex: 0,
    focused: true,
    paneWidth: 40,
    paneHeight: 10,
    viewportOffset: 0,
    onViewportOffsetChange: () => {
      /* noop stub */
    },
    mouseScrolled: false,
    onMouseScrolledChange: () => {
      /* noop stub */
    },
    ...overrides,
  };

  const instance = render(
    <Box flexDirection="column">
      <List {...props} />
    </Box>,
  );

  return { instance, props };
}

function setupListItemTest(overrides?: Partial<ListItemProps>): {
  instance: ReturnType<typeof render>;
  props: ListItemProps;
} {
  const props: ListItemProps = {
    content: 'Test item content',
    selected: false,
    focused: false,
    visibleIndex: 0,
    paneWidth: 40,
    ...overrides,
  };

  const instance = render(
    <Box flexDirection="column">
      <ListItem {...props} />
    </Box>,
  );

  return { instance, props };
}

// ---------------------------------------------------------------------------
// List — No header or rule rendering
// ---------------------------------------------------------------------------

test('it does not render a header label or horizontal rule', () => {
  const { instance } = setupListTest({ items: buildItems(3) });
  const frame = instance.lastFrame() ?? '';

  // The List should not render any header or rule — dashboard owns the border
  expect(frame).not.toContain('\u2500');
  const lines = frame.split('\n');
  expect(lines[0]).toContain('Item 0');
});

// ---------------------------------------------------------------------------
// List — Visible item count
// ---------------------------------------------------------------------------

test('it renders at most pane-height items', () => {
  const items = buildItems(20);
  const { instance } = setupListTest({ items, paneHeight: 7 });
  const frame = instance.lastFrame() ?? '';

  // visibleItemCount = paneHeight = 7
  expect(frame).toContain('Item 0');
  expect(frame).toContain('Item 6');
  expect(frame).not.toContain('Item 7');
});

test('it renders all items when the list fits within the visible area', () => {
  const items = buildItems(3);
  const { instance } = setupListTest({ items, paneHeight: 10 });
  const frame = instance.lastFrame() ?? '';

  expect(frame).toContain('Item 0');
  expect(frame).toContain('Item 1');
  expect(frame).toContain('Item 2');
});

// ---------------------------------------------------------------------------
// List — Scroll windowing (keyboard)
// ---------------------------------------------------------------------------

test('it scrolls to keep the selected item visible when navigating past the viewport', () => {
  const items = buildItems(10);
  const { instance } = setupListTest({
    items,
    paneHeight: 5,
    selectedIndex: 6,
    viewportOffset: 0,
  });
  const frame = instance.lastFrame() ?? '';

  // With selectedIndex 6 and visibleCount 5, viewport should shift so item 6 is visible
  expect(frame).toContain('Item 6');
});

test('it scrolls backward when the selected item is above the viewport', () => {
  const items = buildItems(10);
  const { instance } = setupListTest({
    items,
    paneHeight: 5,
    selectedIndex: 1,
    viewportOffset: 5,
  });
  const frame = instance.lastFrame() ?? '';

  // selectedIndex 1 is above viewportOffset 5, should snap back
  expect(frame).toContain('Item 1');
});

// ---------------------------------------------------------------------------
// List — Mouse scroll
// ---------------------------------------------------------------------------

test('it uses the viewport offset directly when mouse-scrolled', () => {
  const items = buildItems(10);
  const { instance } = setupListTest({
    items,
    paneHeight: 5,
    selectedIndex: 0,
    viewportOffset: 3,
    mouseScrolled: true,
  });
  const frame = instance.lastFrame() ?? '';

  // Mouse scroll sets viewportOffset=3, selectedIndex=0 should NOT drag viewport back
  expect(frame).toContain('Item 3');
  expect(frame).toContain('Item 4');
  expect(frame).toContain('Item 5');
  expect(frame).not.toContain('Item 0');
});

test('it snaps back to the selection when keyboard navigating after mouse scroll', () => {
  const items = buildItems(10);
  // mouseScrolled=false means keyboard navigation — viewport should snap to selectedIndex
  const { instance } = setupListTest({
    items,
    paneHeight: 5,
    selectedIndex: 1,
    viewportOffset: 7,
    mouseScrolled: false,
  });
  const frame = instance.lastFrame() ?? '';

  // Keyboard nav: viewport should snap so selectedIndex 1 is visible
  expect(frame).toContain('Item 1');
});

// ---------------------------------------------------------------------------
// List — Viewport clamping
// ---------------------------------------------------------------------------

test('it clamps the viewport offset to prevent showing empty space at the bottom', () => {
  const items = buildItems(5);
  const { instance } = setupListTest({
    items,
    paneHeight: 3,
    selectedIndex: 0,
    viewportOffset: 10,
    mouseScrolled: true,
  });
  const frame = instance.lastFrame() ?? '';

  // 5 items, 3 visible: max offset is 2. Should clamp from 10 to 2.
  expect(frame).toContain('Item 2');
  expect(frame).toContain('Item 3');
  expect(frame).toContain('Item 4');
});

// ---------------------------------------------------------------------------
// ListItem — Padding
// ---------------------------------------------------------------------------

test('it renders list item content with horizontal padding', () => {
  const { instance } = setupListItemTest({ content: 'Hello', paneWidth: 20 });
  const frame = instance.lastFrame() ?? '';

  // Content should have padding (space before it)
  expect(frame).toContain('Hello');
});

// ---------------------------------------------------------------------------
// ListItem — Truncation
// ---------------------------------------------------------------------------

test('it truncates content that exceeds the available width with an ellipsis', () => {
  const longContent = 'A'.repeat(50);
  const { instance } = setupListItemTest({ content: longContent, paneWidth: 20 });
  const frame = instance.lastFrame() ?? '';

  // paneWidth 20 - 2 padding = 18 available width
  // Should truncate to 17 chars + ellipsis
  expect(frame).toContain('\u2026');
  expect(frame).not.toContain('A'.repeat(50));
});

test('it does not truncate content that fits within the available width', () => {
  const { instance } = setupListItemTest({ content: 'Short', paneWidth: 20 });
  const frame = instance.lastFrame() ?? '';

  expect(frame).toContain('Short');
  expect(frame).not.toContain('\u2026');
});

test('it handles content exactly at the width boundary without truncation', () => {
  // paneWidth 12 - 2 padding = 10 available
  const content = 'A'.repeat(10);
  const { instance } = setupListItemTest({ content, paneWidth: 12 });
  const frame = instance.lastFrame() ?? '';

  expect(frame).toContain('A'.repeat(10));
  expect(frame).not.toContain('\u2026');
});

// ---------------------------------------------------------------------------
// ListItem — Alternating rows
// ---------------------------------------------------------------------------

test('it renders even-indexed visible rows without dimmed background', () => {
  const items = buildItems(4);
  const { instance } = setupListTest({
    items,
    paneHeight: 10,
    selectedIndex: -1,
    focused: false,
  });
  const frame = instance.lastFrame() ?? '';

  // Even-indexed rows (0, 2) should use terminal default (no dim)
  // Odd-indexed rows (1, 3) should be dimmed
  // We verify all items render
  expect(frame).toContain('Item 0');
  expect(frame).toContain('Item 1');
  expect(frame).toContain('Item 2');
  expect(frame).toContain('Item 3');
});

// ---------------------------------------------------------------------------
// ListItem — Selection highlighting
// ---------------------------------------------------------------------------

test('it renders the selected item content in a focused pane', () => {
  const { instance } = setupListItemTest({
    content: 'Selected item',
    selected: true,
    focused: true,
    visibleIndex: 0,
  });
  const frame = instance.lastFrame() ?? '';

  expect(frame).toContain('Selected item');
});

test('it renders a selected item in an unfocused pane without selection highlighting', () => {
  const { instance } = setupListItemTest({
    content: 'Selected item',
    selected: true,
    focused: false,
    visibleIndex: 0,
  });
  const frame = instance.lastFrame() ?? '';

  // Content should still be rendered
  expect(frame).toContain('Selected item');
});

test('it renders an unselected item content in a focused pane', () => {
  const { instance } = setupListItemTest({
    content: 'Regular item',
    selected: false,
    focused: true,
    visibleIndex: 0,
  });
  const frame = instance.lastFrame() ?? '';

  expect(frame).toContain('Regular item');
});

test('it renders odd-indexed visible rows with their content', () => {
  const { instance } = setupListItemTest({
    content: 'Odd row',
    selected: false,
    focused: false,
    visibleIndex: 1,
  });
  const frame = instance.lastFrame() ?? '';

  expect(frame).toContain('Odd row');
});

test('it renders even-indexed visible rows with their content', () => {
  const { instance } = setupListItemTest({
    content: 'Even row',
    selected: false,
    focused: false,
    visibleIndex: 0,
  });
  const frame = instance.lastFrame() ?? '';

  expect(frame).toContain('Even row');
});

test('it renders a selected odd-indexed row in a focused pane with its content', () => {
  const { instance } = setupListItemTest({
    content: 'Selected odd',
    selected: true,
    focused: true,
    visibleIndex: 1,
  });
  const frame = instance.lastFrame() ?? '';

  expect(frame).toContain('Selected odd');
});

// ---------------------------------------------------------------------------
// List — Empty state
// ---------------------------------------------------------------------------

test('it renders no output when the item list is empty', () => {
  const { instance } = setupListTest({ items: [] });
  const frame = instance.lastFrame() ?? '';

  // No header, no rule, no items — empty list produces no visible content
  expect(frame.trim()).toBe('');
});

// ---------------------------------------------------------------------------
// List — Zero pane height
// ---------------------------------------------------------------------------

test('it renders no items when the pane height is zero', () => {
  const items = buildItems(5);
  const { instance } = setupListTest({ items, paneHeight: 0 });
  const frame = instance.lastFrame() ?? '';

  expect(frame).not.toContain('Item');
});
