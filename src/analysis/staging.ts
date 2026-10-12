import type { FileChange, Hunk, LineRange, Staged } from '../contracts/index.js';
import { hunkNewSpan, mapLine, overlaps } from '../diff/index.js';

function oldSpan(h: Hunk): LineRange {
  if (h.oldLines === 0) return { start: h.oldStart + 1, end: h.oldStart + 1 };
  return { start: h.oldStart, end: h.oldStart + h.oldLines - 1 };
}

function verdict(staged: boolean, unstaged: boolean): Staged {
  return staged ? (unstaged ? 'partial' : 'full') : 'none';
}

/** How much of a file's change is in the index. Undefined when staging info is unavailable. */
export function fileStaged(change: FileChange): Staged | undefined {
  const s = change.staging;
  return s && verdict(s.staged.length > 0, s.unstaged.length > 0);
}

/**
 * How much of a symbol's change is in the index. Staged hunks (HEAD → index) are moved into
 * working-tree coordinates through the unstaged hunks (index → working tree) before comparing.
 */
export function rangeStaged(change: FileChange, ranges: { old?: LineRange; new?: LineRange }): Staged | undefined {
  const s = change.staging;
  if (!s) return undefined;
  if (ranges.new) {
    const target = ranges.new;
    const unstaged = s.unstaged.some((h) => overlaps(hunkNewSpan(h), target));
    const staged = s.staged.some((h) => {
      const span = hunkNewSpan(h); // index coordinates
      return overlaps({ start: mapLine(s.unstaged, span.start), end: mapLine(s.unstaged, span.end) }, target);
    });
    return verdict(staged, unstaged);
  }
  if (ranges.old) {
    // Removed symbol: compare in HEAD coordinates, then in index coordinates.
    const target = ranges.old;
    const staged = s.staged.some((h) => overlaps(oldSpan(h), target));
    const inIndex = { start: mapLine(s.staged, target.start), end: mapLine(s.staged, target.end) };
    const unstaged = s.unstaged.some((h) => overlaps(oldSpan(h), inIndex));
    return verdict(staged, unstaged);
  }
  return undefined;
}

/** A container is fully staged when all its changed parts are, untouched when none are. */
export function combineStaged(parts: readonly (Staged | undefined)[]): Staged | undefined {
  const known = parts.filter((p): p is Staged => p !== undefined);
  if (!known.length) return undefined;
  if (known.every((p) => p === 'full')) return 'full';
  if (known.every((p) => p === 'none')) return 'none';
  return 'partial';
}
