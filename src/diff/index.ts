import type { DiffLine, FileChange, Hunk, LineRange } from '../contracts/index.js';

const MAX_FULL_LINES = 20_000;

function splitLines(content: string | undefined): string[] {
  if (content === undefined || content === '') return [];
  return content.replace(/\r?\n$/, '').split(/\r?\n/);
}

/**
 * Builds a full-file unified view: every line of the new file, with removed lines interleaved
 * where they were. Falls back to hunks only for very large files.
 */
export function buildDiffView(file: FileChange, options: { full?: boolean } = {}): { lines: DiffLine[]; truncated: boolean } {
  if (file.binary) return { lines: [], truncated: false };
  const oldLines = splitLines(file.oldContent);
  const newLines = splitLines(file.newContent);
  const out: DiffLine[] = [];

  if (file.status === 'added' && !file.oldContent) {
    return { lines: newLines.map((text, i) => ({ t: 'add', text, new: i + 1 })), truncated: false };
  }
  if (file.status === 'deleted') {
    return { lines: oldLines.map((text, i) => ({ t: 'del', text, old: i + 1 })), truncated: false };
  }

  const truncated = !options.full && newLines.length > MAX_FULL_LINES;
  let oldNo = 1;
  let newNo = 1;
  for (const hunk of file.hunks) {
    if (!truncated) {
      while (newNo < hunk.newStart || (hunk.newLines === 0 && newNo <= hunk.newStart)) {
        if (newNo > newLines.length) break;
        out.push({ t: 'ctx', text: newLines[newNo - 1]!, old: oldNo, new: newNo });
        oldNo++;
        newNo++;
      }
    }
    oldNo = hunk.oldLines === 0 ? hunk.oldStart + 1 : hunk.oldStart;
    newNo = hunk.newLines === 0 ? hunk.newStart + 1 : hunk.newStart;
    for (const l of hunk.lines) {
      if (l.type === 'add') out.push({ t: 'add', text: l.text, new: newNo++ });
      else if (l.type === 'del') out.push({ t: 'del', text: l.text, old: oldNo++ });
      else out.push({ t: 'ctx', text: l.text, old: oldNo++, new: newNo++ });
    }
  }
  if (!truncated) {
    while (newNo <= newLines.length) {
      out.push({ t: 'ctx', text: newLines[newNo - 1]!, old: oldNo++, new: newNo++ });
    }
  }
  return { lines: out, truncated };
}

/** Lines changed on each side: added lines by new number, removed lines by old number. */
export interface ChangedLines {
  added: Set<number>;
  removed: Set<number>;
}

export function changedLines(lines: readonly DiffLine[]): ChangedLines {
  const added = new Set<number>();
  const removed = new Set<number>();
  for (const l of lines) {
    if (l.t === 'add' && l.new) added.add(l.new);
    if (l.t === 'del' && l.old) removed.add(l.old);
  }
  return { added, removed };
}

export function countInRange(set: ReadonlySet<number>, range: LineRange | undefined): number {
  if (!range) return 0;
  let n = 0;
  for (const line of set) if (line >= range.start && line <= range.end) n++;
  return n;
}

/** Line ending style and final newline of a file, so rebuilt content round-trips byte for byte. */
export interface TextShape {
  eol: '\n' | '\r\n';
  finalNewline: boolean;
}

export function textShape(content: string | undefined): TextShape {
  return {
    eol: content?.includes('\r\n') ? '\r\n' : '\n',
    finalNewline: content === undefined || content === '' || /\n$/.test(content),
  };
}

/**
 * Rebuilds file content from a full diff view, applying only the selected changes: selected
 * additions are kept, selected deletions are dropped, unselected ones fall back to the old side.
 * This is how a part of a diff (one function) is staged or unstaged.
 */
export function applySelected(lines: readonly DiffLine[], isSelected: (line: DiffLine) => boolean, shape: TextShape): string {
  const out: string[] = [];
  for (const l of lines) {
    if (l.t === 'ctx') out.push(l.text);
    else if (l.t === 'add' && isSelected(l)) out.push(l.text);
    else if (l.t === 'del' && !isSelected(l)) out.push(l.text);
  }
  if (!out.length) return '';
  return out.join(shape.eol) + (shape.finalNewline ? shape.eol : '');
}

/**
 * Where each line of a view sits on the new side: its own number for added/context lines, and
 * the next new line for a deletion (the place where the removed text used to be).
 */
export function newSidePositions(lines: readonly DiffLine[]): number[] {
  const pos = new Array<number>(lines.length);
  let next = Number.POSITIVE_INFINITY;
  for (let i = lines.length - 1; i >= 0; i--) {
    const l = lines[i]!;
    if (l.new !== undefined) next = l.new;
    pos[i] = l.new ?? (Number.isFinite(next) ? next : (lines.findLast((x) => x.new !== undefined)?.new ?? 0) + 1);
  }
  return pos;
}

/** Maps an old-side line number to the new side through the hunks' offsets. */
export function mapLine(hunks: readonly Hunk[], line: number): number {
  let offset = 0;
  for (const h of hunks) {
    const oldFirst = h.oldLines === 0 ? h.oldStart + 1 : h.oldStart;
    const oldLast = oldFirst + h.oldLines - 1;
    if (line < oldFirst) break;
    if (h.oldLines > 0 && line <= oldLast) return Math.max(1, h.newLines === 0 ? h.newStart + 1 : h.newStart);
    offset += h.newLines - h.oldLines;
  }
  return line + offset;
}

/** New-side line span a hunk occupies (a pure deletion occupies the line after it). */
export function hunkNewSpan(h: Hunk): LineRange {
  if (h.newLines === 0) return { start: h.newStart + 1, end: h.newStart + 1 };
  return { start: h.newStart, end: h.newStart + h.newLines - 1 };
}

export function overlaps(a: LineRange, b: LineRange): boolean {
  return a.start <= b.end && b.start <= a.end;
}
