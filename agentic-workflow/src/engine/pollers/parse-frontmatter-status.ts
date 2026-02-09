const FRONTMATTER_RE = /^---\n([\s\S]*?)\n---/;
const STATUS_RE = /^status:\s*(.+)$/m;

export function parseFrontmatterStatus(content: string): string | null {
  const fmMatch = FRONTMATTER_RE.exec(content);
  if (!fmMatch?.[1]) {
    return null;
  }
  const statusMatch = STATUS_RE.exec(fmMatch[1]);
  return statusMatch?.[1]?.trim() ?? null;
}
