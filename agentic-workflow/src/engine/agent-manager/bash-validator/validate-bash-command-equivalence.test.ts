import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { expect, test } from 'vitest';
import { validateBashCommand } from './validate-bash-command.ts';

interface TestVector {
  command: string;
  expected: 'allow' | 'block';
  description: string;
}

function isTestVector(value: unknown): value is TestVector {
  return (
    typeof value === 'object' &&
    value !== null &&
    'command' in value &&
    typeof value.command === 'string' &&
    'expected' in value &&
    (value.expected === 'allow' || value.expected === 'block') &&
    'description' in value &&
    typeof value.description === 'string'
  );
}

function loadTestVectors(): TestVector[] {
  const vectorsPath = resolve(import.meta.dirname, 'bash-validator-test-vectors.json');
  const content = readFileSync(vectorsPath, 'utf-8');
  const parsed: unknown = JSON.parse(content);

  if (!Array.isArray(parsed)) {
    throw new Error('Test vectors file must contain a JSON array');
  }

  for (const entry of parsed) {
    if (!isTestVector(entry)) {
      throw new Error(`Invalid test vector: ${JSON.stringify(entry)}`);
    }
  }

  return parsed;
}

test('it loads the shared test vectors file successfully', () => {
  const vectors = loadTestVectors();
  expect(vectors.length).toBeGreaterThan(0);
});

test('it produces the expected outcome for every shared test vector', () => {
  const vectors = loadTestVectors();
  const failures: string[] = [];

  for (const vector of vectors) {
    const result = validateBashCommand(vector.command);
    const actual = result.allowed ? 'allow' : 'block';

    if (actual !== vector.expected) {
      failures.push(
        `  FAIL: ${vector.description}\n` +
          `    command:  ${vector.command}\n` +
          `    expected: ${vector.expected}\n` +
          `    actual:   ${actual}`,
      );
    }
  }

  if (failures.length > 0) {
    throw new Error(`${failures.length} vector(s) failed:\n${failures.join('\n')}`);
  }
});
