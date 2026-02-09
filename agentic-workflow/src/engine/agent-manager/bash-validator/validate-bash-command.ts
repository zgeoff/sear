import invariant from 'tiny-invariant';
import type { BashValidationResult } from './types.ts';
import { ALLOWLIST_PREFIXES, BLOCKLIST_PATTERNS } from './types.ts';

const ALLOWED: BashValidationResult = { allowed: true };

const FIRST_WORD_PATTERN = /^(\S+)/;

export function validateBashCommand(command: string): BashValidationResult {
  if (command === '') {
    return ALLOWED;
  }

  // Layer 1: Blocklist — checked first against the full command string
  for (const entry of BLOCKLIST_PATTERNS) {
    if (entry.pattern.test(command)) {
      return { allowed: false, reason: `Blocked: matches dangerous pattern '${entry.source}'` };
    }
  }

  // Layer 2: Allowlist — split into segments, check each segment's first word
  const segments = splitSegments(command);

  for (const segment of segments) {
    const firstWord = extractFirstWord(segment);
    if (firstWord !== '' && !ALLOWLIST_PREFIXES.includes(firstWord)) {
      return {
        allowed: false,
        reason: `Blocked: '${firstWord}' is not in the allowed command list`,
      };
    }
  }

  return ALLOWED;
}

// Quote-aware command segmentation. Splits on &&, ||, ;, |, and newlines.
// Respects single-quoted and double-quoted strings. Backslash escapes are
// handled outside quotes and inside double-quoted strings. Single-quoted
// strings are literal (no escape processing).
function splitSegments(command: string): string[] {
  const segments: string[] = [];
  let current = '';
  let quote = '';
  let i = 0;

  while (i < command.length) {
    const c = command[i];

    // Inside a quoted context
    if (quote !== '') {
      // Backslash escape inside double quotes
      if (c === '\\' && quote === '"' && i + 1 < command.length) {
        current += c + command[i + 1];
        i += 2;
      } else {
        // Closing quote
        if (c === quote) {
          quote = '';
        }
        current += c;
        i += 1;
      }
    } else if (c === '"' || c === "'") {
      // Outside quotes — opening quote
      quote = c;
      current += c;
      i += 1;
    } else if (c === '\\' && i + 1 < command.length) {
      // Outside quotes — backslash escape
      current += c + command[i + 1];
      i += 2;
    } else if (i + 1 < command.length && isTwoCharOperator(c, command[i + 1])) {
      // Outside quotes — two-character operators
      segments.push(current);
      current = '';
      i += 2;
    } else if (c === '|' || c === ';' || c === '\n') {
      // Outside quotes — single-character operators
      segments.push(current);
      current = '';
      i += 1;
    } else {
      current += c;
      i += 1;
    }
  }

  if (current !== '') {
    segments.push(current);
  }

  return segments;
}

function isTwoCharOperator(c: string, next: string | undefined): boolean {
  if (next === undefined) {
    return false;
  }
  const twoChar = c + next;
  return twoChar === '&&' || twoChar === '||';
}

// Extracts the first word from a segment. Takes only the first line,
// trims leading whitespace, and returns the first whitespace-delimited token.
function extractFirstWord(segment: string): string {
  const parts = segment.split('\n');
  const firstLine = parts[0];
  invariant(firstLine !== undefined, 'split always produces at least one element');
  const trimmed = firstLine.trimStart();
  if (trimmed === '') {
    return '';
  }
  const match = trimmed.match(FIRST_WORD_PATTERN);
  if (match === null) {
    return '';
  }
  const word = match[1];
  invariant(word !== undefined, 'capture group must exist when pattern matches');
  return word;
}
