import { expect, test } from 'vitest';
import type { LogEntry } from './create-logger.ts';
import { createLogger } from './create-logger.ts';

// ---------------------------------------------------------------------------
// Test utilities
// ---------------------------------------------------------------------------

function setupTest(logLevel: 'debug' | 'info' | 'error' = 'info'): {
  logger: ReturnType<typeof createLogger>;
  entries: LogEntry[];
} {
  const entries: LogEntry[] = [];
  const writer = (entry: LogEntry): number => entries.push(entry);
  const logger = createLogger({ logLevel, writer });

  return { logger, entries };
}

// ---------------------------------------------------------------------------
// Level filtering
// ---------------------------------------------------------------------------

test('it outputs debug messages when log level is debug', () => {
  const { logger, entries } = setupTest('debug');

  logger.debug('test message');

  expect(entries).toHaveLength(1);
  expect(entries[0]?.level).toBe('debug');
  expect(entries[0]?.message).toBe('test message');
});

test('it suppresses debug messages when log level is info', () => {
  const { logger, entries } = setupTest('info');

  logger.debug('test message');

  expect(entries).toHaveLength(0);
});

test('it outputs info messages when log level is info', () => {
  const { logger, entries } = setupTest('info');

  logger.info('info message');

  expect(entries).toHaveLength(1);
  expect(entries[0]?.level).toBe('info');
});

test('it suppresses debug and info messages when log level is error', () => {
  const { logger, entries } = setupTest('error');

  logger.debug('debug message');
  logger.info('info message');

  expect(entries).toHaveLength(0);
});

test('it outputs error messages at all log levels', () => {
  const { logger, entries } = setupTest('error');

  logger.error('error message');

  expect(entries).toHaveLength(1);
  expect(entries[0]?.level).toBe('error');
});

test('it outputs all levels when log level is debug', () => {
  const { logger, entries } = setupTest('debug');

  logger.debug('d');
  logger.info('i');
  logger.error('e');

  expect(entries).toHaveLength(3);
});

// ---------------------------------------------------------------------------
// Structured output
// ---------------------------------------------------------------------------

test('it includes timestamp, level, and message in each entry', () => {
  const { logger, entries } = setupTest('debug');

  logger.info('startup complete');

  expect(entries[0]?.timestamp).toBeDefined();
  expect(entries[0]?.level).toBe('info');
  expect(entries[0]?.message).toBe('startup complete');
});

test('it includes additional data fields in the entry', () => {
  const { logger, entries } = setupTest('debug');

  logger.info('agent started', { issueNumber: 42, agentType: 'implementor' });

  expect(entries[0]?.issueNumber).toBe(42);
  expect(entries[0]?.agentType).toBe('implementor');
});
