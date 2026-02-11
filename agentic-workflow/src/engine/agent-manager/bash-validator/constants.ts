import type { BlocklistPattern } from './types.ts';

export const BLOCKLIST_PATTERNS: BlocklistPattern[] = [
  // Git destructive operations
  {
    category: 'Git destructive',
    pattern: /git\s+reset\s+--hard/,
    source: 'git\\s+reset\\s+--hard',
  },
  {
    category: 'Git destructive',
    pattern: /git\s+clean\s+-[a-zA-Z]*f/,
    source: 'git\\s+clean\\s+-[a-zA-Z]*f',
  },
  { category: 'Git destructive', pattern: /git\s+checkout\s+\./, source: 'git\\s+checkout\\s+\\.' },
  { category: 'Git destructive', pattern: /git\s+restore\s+\./, source: 'git\\s+restore\\s+\\.' },
  {
    category: 'Git destructive',
    pattern: /git\s+branch\s+.*-D\b/,
    source: 'git\\s+branch\\s+.*-D\\b',
  },

  // File deletion
  { category: 'File deletion', pattern: /rm\s/, source: 'rm\\s' },

  // Privilege escalation
  { category: 'Privilege escalation', pattern: /\bsudo\b/, source: '\\bsudo\\b' },

  // Remote code execution
  {
    category: 'Remote code execution',
    pattern: /curl\s.*\|\s*(bash|sh|zsh)/,
    source: 'curl\\s.*\\|\\s*(bash|sh|zsh)',
  },
  {
    category: 'Remote code execution',
    pattern: /wget\s.*\|\s*(bash|sh|zsh)/,
    source: 'wget\\s.*\\|\\s*(bash|sh|zsh)',
  },
  { category: 'Remote code execution', pattern: /\beval\b/, source: '\\beval\\b' },

  // System modification
  { category: 'System modification', pattern: /\bdd\s+if=/, source: '\\bdd\\s+if=' },
  { category: 'System modification', pattern: /\bmkfs\b/, source: '\\bmkfs\\b' },
  { category: 'System modification', pattern: /\bfdisk\b/, source: '\\bfdisk\\b' },
  { category: 'System modification', pattern: /chmod\s+-R/, source: 'chmod\\s+-R' },
  { category: 'System modification', pattern: /chmod\s+777/, source: 'chmod\\s+777' },
  { category: 'System modification', pattern: /chmod\s+.*o\+w/, source: 'chmod\\s+.*o\\+w' },
  { category: 'System modification', pattern: /chmod\s+.*a\+w/, source: 'chmod\\s+.*a\\+w' },
  { category: 'System modification', pattern: /\bchown\b/, source: '\\bchown\\b' },

  // Process management
  { category: 'Process management', pattern: /\bkill\b/, source: '\\bkill\\b' },
  { category: 'Process management', pattern: /\bpkill\b/, source: '\\bpkill\\b' },
  { category: 'Process management', pattern: /\bkillall\b/, source: '\\bkillall\\b' },
];

export const ALLOWLIST_PREFIXES: string[] = [
  // Git
  'git',
  'scripts/workflow/gh.sh',
  './scripts/workflow/gh.sh',

  // Node.js ecosystem
  'yarn',

  // Text processing
  'head',
  'tail',
  'grep',
  'rg',
  'awk',
  'sed',
  'tr',
  'cut',
  'sort',
  'uniq',
  'wc',
  'jq',
  'xargs',
  'diff',
  'tee',

  // Shell utilities
  'echo',
  'printf',
  'ls',
  'pwd',
  'which',
  'command',
  'test',
  'true',
  'false',
  'env',
  'date',
  'basename',
  'dirname',
  'realpath',
  'find',

  // File operations
  'chmod',
  'mkdir',
  'touch',
  'cp',
  'mv',
];
