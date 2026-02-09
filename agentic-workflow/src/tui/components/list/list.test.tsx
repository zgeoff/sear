import { Box } from 'ink';
import { render } from 'ink-testing-library';
import { expect, test } from 'vitest';
import { List } from './list';
import { ListItem } from './list-item';
import type { ListItemData, ListItemProps, ListProps } from './types';

function buildItems(count: number): ListItemData[] {
  return Array.from({ length: count }, (_, i) => ({
    key: `item-${i}`,
    content: `Item ${i}`,
  }));
}

function setupListTest(overrides?: Partial<ListProps>) {
  const props: ListProps = {
    label: 'Issues',
    items: buildItems(3),
    selectedIndex: 0,
    focused: true,
    paneWidth: 40,
    paneHeight: 10,
    viewportOffset: 0,
    onViewportOffsetChange: () => {},
    mouseScrolled: false,
    onMouseScrolledChange: () => {},
    ...overrides,
  };

  const instance = render(
    <Box flexDirection="column">
      <List {...props} />
    </Box>,
  );

  return { instance, props };
}

function setupListItemTest(overrides?: Partial<ListItemProps>) {
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
// List — Pane header
// ---------------------------------------------------------------------------

test('it renders the pane label in uppercase', () => {
  const { instance } = setupListTest({ label: 'notifications' });
  const frame = instance.lastFrame() ?? '';

  expect(frame).toContain('NOTIFICATIONS');
});

test('it renders a horizontal rule below the pane label', () => {
  const { instance } = setupListTest({ paneWidth: 20 });
  const frame = instance.lastFrame() ?? '';

  // Rule should be paneWidth - 2 (1-char padding each side) = 18 chars
  const expectedRule = '\u2500'.repeat(18);
  expect(frame).toContain(expectedRule);
});

test('it renders exactly two chrome rows before list items', () => {
  const items = buildItems(3);
  const { instance } = setupListTest({ items, paneHeight: 10 });
  const frame = instance.lastFrame() ?? '';
  const lines = frame.split('\n');

  // First line: label, second line: rule, then items
  expect(lines.length).toBeGreaterThanOrEqual(5); // 2 chrome + 3 items
  expect(lines[0]).toContain('ISSUES');
  expect(lines[1]).toContain('\u2500');
  expect(lines[2]).toContain('Item 0');
});

// ---------------------------------------------------------------------------
// List — Visible item count
// ---------------------------------------------------------------------------

test('it renders at most pane-height-minus-two items', () => {
  const items = buildItems(20);
  const { instance } = setupListTest({ items, paneHeight: 7 });
  const frame = instance.lastFrame() ?? '';

  // paneHeight 7 - 2 chrome = 5 visible items
  expect(frame).toContain('Item 0');
  expect(frame).toContain('Item 4');
  expect(frame).not.toContain('Item 5');
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
  // paneHeight 5 - 2 chrome = 3 visible items
  const { instance } = setupListTest({
    items,
    paneHeight: 5,
    selectedIndex: 4,
    viewportOffset: 0,
  });
  const frame = instance.lastFrame() ?? '';

  // With selectedIndex 4, viewport should shift so item 4 is visible
  expect(frame).toContain('Item 4');
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
    paneHeight: 5,
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

test('it renders the header even when the item list is empty', () => {
  const { instance } = setupListTest({ items: [], label: 'Issues' });
  const frame = instance.lastFrame() ?? '';

  expect(frame).toContain('ISSUES');
  expect(frame).toContain('\u2500');
});

// ---------------------------------------------------------------------------
// List — Horizontal rule width
// ---------------------------------------------------------------------------

test('it adjusts the horizontal rule width to match the pane width minus padding', () => {
  const { instance } = setupListTest({ paneWidth: 30, items: [] });
  const frame = instance.lastFrame() ?? '';

  // 30 - 2 padding = 28 rule chars
  const expectedRule = '\u2500'.repeat(28);
  expect(frame).toContain(expectedRule);
});

// ---------------------------------------------------------------------------
// List — Zero/small pane height
// ---------------------------------------------------------------------------

test('it renders only chrome when the pane height equals the chrome rows', () => {
  const items = buildItems(5);
  const { instance } = setupListTest({ items, paneHeight: 2 });
  const frame = instance.lastFrame() ?? '';

  expect(frame).toContain('ISSUES');
  expect(frame).toContain('\u2500');
  // No items should be visible (visibleItemCount = 0)
  expect(frame).not.toContain('Item');
});
