import type { FileChange, Hunk } from '../../src/contracts/index.js';

const split = (s: string | undefined) => (s === undefined || s === '' ? [] : s.replace(/\n$/, '').split('\n'));

/** Zero-context hunks from an LCS line diff, matching what `git diff -U0` would produce. */
export function hunks(oldContent: string | undefined, newContent: string | undefined): Hunk[] {
  const a = split(oldContent);
  const b = split(newContent);
  const lcs = Array.from({ length: a.length + 1 }, () => new Array<number>(b.length + 1).fill(0));
  for (let i = a.length - 1; i >= 0; i--)
    for (let j = b.length - 1; j >= 0; j--)
      lcs[i]![j] = a[i] === b[j] ? lcs[i + 1]![j + 1]! + 1 : Math.max(lcs[i + 1]![j]!, lcs[i]![j + 1]!);

  const out: Hunk[] = [];
  let i = 0;
  let j = 0;
  let cur: Hunk | undefined;
  const flush = () => {
    if (!cur) return;
    const dels = cur.lines.filter((l) => l.type === 'del').length;
    const adds = cur.lines.length - dels;
    cur.oldLines = dels;
    cur.newLines = adds;
    if (!dels) cur.oldStart -= 1;
    if (!adds) cur.newStart -= 1;
    out.push(cur);
    cur = undefined;
  };
  while (i < a.length || j < b.length) {
    if (i < a.length && j < b.length && a[i] === b[j]) {
      flush();
      i++;
      j++;
    } else {
      cur ??= { oldStart: i + 1, oldLines: 0, newStart: j + 1, newLines: 0, lines: [] };
      if (j < b.length && (i >= a.length || lcs[i]![j + 1]! >= lcs[i + 1]![j]!)) {
        cur.lines.push({ type: 'add', text: b[j++]! });
      } else {
        cur.lines.push({ type: 'del', text: a[i++]! });
      }
    }
  }
  flush();
  // git lists deletions before additions inside a hunk
  for (const h of out) h.lines.sort((x, y) => (x.type === y.type ? 0 : x.type === 'del' ? -1 : 1));
  return out;
}

export function change(path: string, oldContent: string | undefined, newContent: string | undefined, oldPath?: string): FileChange {
  return {
    path,
    oldPath,
    status: oldContent === undefined ? 'added' : newContent === undefined ? 'deleted' : oldPath ? 'renamed' : 'modified',
    binary: false,
    oldContent,
    newContent,
    hunks: hunks(oldContent, newContent),
  };
}
