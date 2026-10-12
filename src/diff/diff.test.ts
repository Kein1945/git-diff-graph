import { describe, expect, it } from 'vitest';
import { change } from '../../test/fixtures/change.js';
import { applySelected, buildDiffView, mapLine, newSidePositions, textShape } from './index.js';

describe('applySelected', () => {
  const before = 'a\nb\nc\nd\n';
  const after = 'a\nB\nc\nD\ne\n';
  const { lines } = buildDiffView(change('f.ts', before, after), { full: true });

  it('applying everything gives the new file, nothing gives the old one', () => {
    expect(applySelected(lines, () => true, textShape(after))).toBe(after);
    expect(applySelected(lines, () => false, textShape(before))).toBe(before);
  });

  it('applies only changes in a new-side range', () => {
    const pos = newSidePositions(lines);
    const inFirst = (l: (typeof lines)[number]) => pos[lines.indexOf(l)]! <= 2;
    expect(applySelected(lines, inFirst, textShape(before))).toBe('a\nB\nc\nd\n');
  });

  it('keeps CRLF and a missing final newline', () => {
    const crlf = 'x\r\ny';
    const { lines: l2 } = buildDiffView(change('f.ts', 'x\ny', 'x\ny'), { full: true });
    expect(applySelected(l2, () => true, textShape(crlf))).toBe('x\r\ny');
  });
});

describe('mapLine', () => {
  it('shifts lines after hunks and pins lines inside a changed hunk', () => {
    // old 1..10; hunk replaces old 3..4 with 3 lines, hunk inserts 2 lines after old 7
    const hunks = [
      { oldStart: 3, oldLines: 2, newStart: 3, newLines: 3, lines: [] },
      { oldStart: 7, oldLines: 0, newStart: 9, newLines: 2, lines: [] },
    ];
    expect(mapLine(hunks, 2)).toBe(2);
    expect(mapLine(hunks, 4)).toBe(3);
    expect(mapLine(hunks, 5)).toBe(6);
    expect(mapLine(hunks, 7)).toBe(8);
    expect(mapLine(hunks, 8)).toBe(11);
  });
});
