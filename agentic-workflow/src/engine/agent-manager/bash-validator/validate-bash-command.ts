import invariant from 'tiny-invariant';
import type { BashValidationResult } from './types';
import { ALLOWLIST_PREFIXES, BLOCKLIST_PATTERNS } from './types';

const ALLOWED: BashValidationResult = { allowed: true };

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
    if (firstWord === '') {
      continue;
    }

    if (!ALLOWLIST_PREFIXES.includes(firstWord)) {
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
        continue;
      }

      // Closing quote
      if (c === quote) {
        quote = '';
      }

      current += c;
      i++;
      continue;
    }

    // Outside quotes — opening quote
    if (c === '"' || c === "'") {
      quote = c;
      current += c;
      i++;
      continue;
    }

    // Outside quotes — backslash escape
    if (c === '\\' && i + 1 < command.length) {
      current += c + command[i + 1];
      i += 2;
      continue;
    }

    // Outside quotes — two-character operators (checked before single-char)
    if (i + 1 < command.length) {
      const next = command[i + 1];
      invariant(next !== undefined, 'character at i+1 must exist within bounds');
      const twoChar = c + next;
      if (twoChar === '&&' || twoChar === '||') {
        segments.push(current);
        current = '';
        i += 2;
        continue;
      }
    }

    // Outside quotes — single-character operators
    if (c === '|' || c === ';' || c === '\n') {
      segments.push(current);
      current = '';
      i++;
      continue;
    }

    current += c;
    i++;
  }

  if (current !== '') {
    segments.push(current);
  }

  return segments;
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
  const match = trimmed.match(/^(\S+)/);
  if (match === null) {
    return '';
  }
  const word = match[1];
  invariant(word !== undefined, 'capture group must exist when pattern matches');
  return word;
}
