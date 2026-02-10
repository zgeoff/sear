export type BashValidationResult = { allowed: true } | { allowed: false; reason: string };

export interface BlocklistPattern {
  category: string;
  pattern: RegExp;
  source: string;
}
