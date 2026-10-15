import { access, readFile } from 'node:fs/promises';
import path from 'node:path';
import type { DiffLine, Hunk, LineRange, StageRequest } from '../contracts/index.js';
import { applySelected, buildDiffView, mapLine, newSidePositions, textShape } from '../diff/index.js';
import { parseUnifiedDiff } from './parse-diff.js';
import { git, gitError, gitWithInput, hasCommits, resolveRepoRoot, tryGit } from './run.js';

/** Git operations the viewer can trigger. The server only sees this interface. */
export interface GitActions {
  stage(request: StageRequest): Promise<void>;
  commit(message: string): Promise<{ hash: string }>;
}

/** Swaps the sides of hunks, so `mapLine` can translate new-side numbers back to the old side. */
function invert(hunks: readonly Hunk[]): Hunk[] {
  return hunks.map((h) => ({ oldStart: h.newStart, oldLines: h.newLines, newStart: h.oldStart, newLines: h.oldLines, lines: [] }));
}

function within(n: number, r: LineRange) {
  return n >= r.start && n <= r.end;
}

async function fileDiff(repoRoot: string, args: string[], file: string): Promise<Hunk[]> {
  const out = await git(repoRoot, ['diff', '--no-color', '--no-ext-diff', '--no-renames', '-U0', ...args, '--', file]);
  return parseUnifiedDiff(out)[0]?.hunks ?? [];
}

/** Writes `content` as the index version of `file`, keeping its file mode. */
async function writeIndex(repoRoot: string, file: string, content: string): Promise<void> {
  const sha = (await gitWithInput(repoRoot, ['hash-object', '-w', '--stdin', '--path', file], content)).trim();
  const entry = await tryGit(repoRoot, ['ls-files', '-s', '--', file]);
  const mode = entry?.split(/\s+/)[0] || '100644';
  await git(repoRoot, ['update-index', '--add', '--cacheinfo', `${mode},${sha},${file}`]);
}

function view(oldContent: string, newContent: string, hunks: Hunk[]): DiffLine[] {
  return buildDiffView(
    { path: '', status: 'modified', binary: false, hunks, oldContent, newContent },
    { full: true },
  ).lines;
}

function addAll(content: string): Hunk {
  const lines = content === '' ? [] : content.replace(/\r?\n$/, '').split(/\r?\n/);
  return { oldStart: 0, oldLines: 0, newStart: 1, newLines: lines.length, lines: lines.map((text) => ({ type: 'add', text })) };
}

async function readText(repoRoot: string, args: string[]): Promise<string> {
  return (await tryGit(repoRoot, args)) ?? '';
}

/**
 * Stages the changes inside `range` (working-tree lines of one symbol): the index gets exactly
 * those changes from the working tree and keeps everything else as it was.
 */
async function stageRange(repoRoot: string, file: string, range: LineRange, side: 'new' | 'old'): Promise<void> {
  const tracked = (await tryGit(repoRoot, ['ls-files', '--error-unmatch', '--', file])) !== undefined;
  const index = tracked ? await readText(repoRoot, ['show', `:${file}`]) : '';
  const work = await readFile(path.join(repoRoot, file), 'utf8').catch(() => '');
  // An untracked file is one big addition relative to the (empty) index.
  const unstaged = tracked ? await fileDiff(repoRoot, [], file) : [addAll(work)];
  const lines = view(index, work, unstaged);
  let selected: (l: DiffLine, i: number) => boolean;
  if (side === 'new') {
    const pos = newSidePositions(lines);
    selected = (_l, i) => within(pos[i]!, range);
  } else {
    // A removed symbol: its range is in HEAD lines; move it into index lines first.
    const staged = await fileDiff(repoRoot, ['--cached'], file);
    const r = { start: mapLine(staged, range.start), end: mapLine(staged, range.end) };
    selected = (l) => l.t === 'del' && l.old !== undefined && within(l.old, r);
  }
  const idx = new Map(lines.map((l, i) => [l, i]));
  await writeIndex(repoRoot, file, applySelected(lines, (l) => selected(l, idx.get(l)!), textShape(index || work)));
}

/** Unstages the changes inside `range`: they are reverted in the index to the HEAD version. */
async function unstageRange(repoRoot: string, file: string, range: LineRange, side: 'new' | 'old'): Promise<void> {
  const head = (await hasCommits(repoRoot)) ? await readText(repoRoot, ['show', `HEAD:${file}`]) : '';
  const index = await readText(repoRoot, ['show', `:${file}`]);
  const staged = await fileDiff(repoRoot, ['--cached'], file);
  const lines = view(head, index, staged);
  let inRange: (l: DiffLine, i: number) => boolean;
  if (side === 'new') {
    // Working-tree lines → index lines.
    const unstaged = await fileDiff(repoRoot, [], file);
    const back = invert(unstaged);
    const r = { start: mapLine(back, range.start), end: mapLine(back, range.end) };
    const pos = newSidePositions(lines);
    inRange = (_l, i) => within(pos[i]!, r);
  } else {
    inRange = (l) => l.t === 'del' && l.old !== undefined && within(l.old, range);
  }
  const idx = new Map(lines.map((l, i) => [l, i]));
  // Keep every staged change except the ones in range.
  await writeIndex(repoRoot, file, applySelected(lines, (l) => !inRange(l, idx.get(l)!), textShape(index || head)));
}

const splitZ = (out: string | undefined) => (out ?? '').split('\0').filter(Boolean);

/**
 * Keeps only paths git can act on. Pathspecs that match nothing make `git add` / `git restore`
 * fail as a whole, which happens with renames: the viewer sends both sides, and the old side may
 * already be gone from the index (its deletion staged), the new side may be untracked.
 */
async function knownPaths(repoRoot: string, paths: string[], action: StageRequest['action']): Promise<string[]> {
  const known = new Set(splitZ(await tryGit(repoRoot, ['ls-files', '--cached', '-z', '--', ...paths])));
  if (action === 'stage') {
    for (const p of paths) if (!known.has(p) && (await exists(path.join(repoRoot, p)))) known.add(p);
  } else if (await hasCommits(repoRoot)) {
    for (const p of splitZ(await tryGit(repoRoot, ['ls-tree', '-r', '--name-only', '-z', 'HEAD', '--', ...paths]))) known.add(p);
  }
  return paths.filter((p) => known.has(p));
}

async function exists(file: string): Promise<boolean> {
  return access(file).then(
    () => true,
    () => false,
  );
}

export function createGitActions(cwd: string): GitActions {
  const root = resolveRepoRoot(cwd);
  return {
    async stage(req) {
      const repoRoot = await root;
      try {
        if (req.range) {
          const side = req.range.side ?? 'new';
          const fn = req.action === 'stage' ? stageRange : unstageRange;
          await fn(repoRoot, req.range.path, { start: req.range.start, end: req.range.end }, side);
          return;
        }
        const paths = await knownPaths(repoRoot, req.paths, req.action);
        if (!paths.length) return;
        if (req.action === 'stage') await git(repoRoot, ['add', '-A', '--', ...paths]);
        else if (await hasCommits(repoRoot)) await git(repoRoot, ['restore', '--staged', '--', ...paths]);
        else await git(repoRoot, ['rm', '--cached', '-r', '-q', '--ignore-unmatch', '--', ...paths]);
      } catch (err) {
        throw gitError(err);
      }
    },

    async commit(message) {
      const repoRoot = await root;
      const nothing = await tryGit(repoRoot, ['diff', '--cached', '--quiet']);
      if (nothing !== undefined) throw new Error('Nothing staged to commit');
      try {
        await git(repoRoot, ['commit', '-q', '-m', message]);
      } catch (err) {
        throw gitError(err);
      }
      return { hash: (await git(repoRoot, ['rev-parse', 'HEAD'])).trim() };
    },
  };
}
