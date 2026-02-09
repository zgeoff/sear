import { expect, test } from 'vitest';
import { parseFrontmatterStatus } from './parse-frontmatter-status.ts';

function buildSpecContent(status: string): string {
  return `---\ntitle: Test Spec\nversion: 0.1.0\nstatus: ${status}\n---\n\n# Test Spec\n\nContent here.\n`;
}

test('it extracts the status from valid frontmatter', () => {
  const content = buildSpecContent('approved');
  expect(parseFrontmatterStatus(content)).toBe('approved');
});

test('it extracts draft status from frontmatter', () => {
  const content = buildSpecContent('draft');
  expect(parseFrontmatterStatus(content)).toBe('draft');
});

test('it returns null when the content has no frontmatter', () => {
  expect(parseFrontmatterStatus('# Just a heading\n\nNo frontmatter.')).toBeNull();
});

test('it returns null when the frontmatter has no status field', () => {
  const content = '---\ntitle: Test\nversion: 0.1.0\n---\n\n# Content';
  expect(parseFrontmatterStatus(content)).toBeNull();
});

test('it trims whitespace from the status value', () => {
  const content = '---\nstatus:   approved  \n---\n\nContent';
  expect(parseFrontmatterStatus(content)).toBe('approved');
});
