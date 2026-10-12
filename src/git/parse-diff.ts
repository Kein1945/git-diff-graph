import type { FileChangeStatus, Hunk, HunkLine } from '../contracts/index.js';

export interface ParsedFileDiff {
  path: string;
  oldPath?: string;
  status: FileChangeStatus;
  binary: boolean;
  hunks: Hunk[];
}

const HUNK_HEADER = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;

/** Strips the `a/` / `b/` prefix and git's C-style quoting from a path in a diff header. */
function cleanPath(raw: string): string {
  let p = raw.trim();
  if (p.startsWith('"') && p.endsWith('"')) {
    p = p.slice(1, -1).replace(/\\(.)/g, '$1');
  }
  return p.replace(/^[ab]\//, '');
}

/** Fallback when there are no ---/+++ lines (binary or mode-only changes): `diff --git a/x b/x`. */
function pathsFromGitHeader(header: string): { a: string; b: string } {
  const rest = header.slice('diff --git '.length);
  // Unquoted and identical halves is the common case: "a/p b/p" with p possibly containing spaces.
  const half = (rest.length - 1) / 2;
  if (Number.isInteger(half) && rest.slice(2, half) === rest.slice(half + 3)) {
    const p = rest.slice(2, half);
    return { a: p, b: p };
  }
  const m = /^(".*?"|\S+) (".*"|\S+)$/.exec(rest);
  return m ? { a: cleanPath(m[1]!), b: cleanPath(m[2]!) } : { a: rest, b: rest };
}

/** Parses `git diff` unified output (with `-M`, default a/ b/ prefixes) into per-file changes. */
export function parseUnifiedDiff(text: string): ParsedFileDiff[] {
  const files: ParsedFileDiff[] = [];
  const lines = text.split('\n');
  let file: (ParsedFileDiff & { minus?: string; plus?: string; header: string }) | undefined;
  let hunk: Hunk | undefined;

  const finish = () => {
    if (!file) return;
    const header = pathsFromGitHeader(file.header);
    const oldP = file.minus && file.minus !== '/dev/null' ? cleanPath(file.minus) : undefined;
    const newP = file.plus && file.plus !== '/dev/null' ? cleanPath(file.plus) : undefined;
    if (!file.path) file.path = newP ?? (file.status === 'deleted' ? oldP : undefined) ?? header.b;
    if (file.status === 'renamed' && !file.oldPath) file.oldPath = oldP ?? header.a;
    const { minus: _m, plus: _p, header: _h, ...rest } = file;
    files.push(rest);
    file = undefined;
    hunk = undefined;
  };

  for (const rawLine of lines) {
    const line = rawLine.endsWith('\r') ? rawLine.slice(0, -1) : rawLine;

    if (line.startsWith('diff --git ')) {
      finish();
      file = { path: '', status: 'modified', binary: false, hunks: [], header: line };
      continue;
    }
    if (!file) continue;

    if (hunk) {
      const c = line[0];
      if (c === '+' || c === '-' || c === ' ') {
        const l: HunkLine = { type: c === '+' ? 'add' : c === '-' ? 'del' : 'ctx', text: line.slice(1) };
        hunk.lines.push(l);
        continue;
      }
      if (c === '\\') continue; // "\ No newline at end of file"
      if (line === '' ) continue;
      hunk = undefined; // fall through: a new header line
    }

    const h = HUNK_HEADER.exec(line);
    if (h) {
      hunk = {
        oldStart: Number(h[1]),
        oldLines: h[2] === undefined ? 1 : Number(h[2]),
        newStart: Number(h[3]),
        newLines: h[4] === undefined ? 1 : Number(h[4]),
        lines: [],
      };
      file.hunks.push(hunk);
    } else if (line.startsWith('new file mode')) {
      file.status = 'added';
    } else if (line.startsWith('deleted file mode')) {
      file.status = 'deleted';
    } else if (line.startsWith('rename from ')) {
      file.status = 'renamed';
      file.oldPath = cleanPath(line.slice('rename from '.length));
    } else if (line.startsWith('rename to ')) {
      file.status = 'renamed';
      file.path = cleanPath(line.slice('rename to '.length));
    } else if (line.startsWith('--- ')) {
      file.minus = line.slice(4);
    } else if (line.startsWith('+++ ')) {
      file.plus = line.slice(4);
    } else if (line.startsWith('Binary files ') || line === 'GIT binary patch') {
      file.binary = true;
    }
  }
  finish();
  return files;
}
