import { readFile } from 'node:fs/promises';
import path from 'node:path';
import {
  WORKTREE,
  type ChangeSet,
  type FileChange,
  type Hunk,
  type SourceReader,
} from '../contracts/index.js';
import { CatFile } from './cat-file.js';
import { parseUnifiedDiff } from './parse-diff.js';
import { EMPTY_TREE, git, isBinary, resolveRepoRoot, tryGit } from './run.js';

export { parseUnifiedDiff } from './parse-diff.js';
export { resolveRepoRoot } from './run.js';
export { createGitActions, type GitActions } from './staging.js';

/**
 * Resolves a ref to a commit SHA (or the empty tree in a repository without commits). Reading
 * by SHA keeps the long-lived blob reader correct after commits move HEAD.
 */
async function resolveRef(repoRoot: string, ref: string): Promise<string> {
  const sha = await tryGit(repoRoot, ['rev-parse', '--verify', '--quiet', `${ref}^{commit}`]);
  if (sha) return sha.trim();
  if (ref === 'HEAD') return EMPTY_TREE;
  throw new Error(`Unknown git ref: ${ref}`);
}

const catFiles = new Map<string, CatFile>();

/** Stops background `git cat-file` processes (they also stop by themselves when idle). */
export function closeGitReaders(): void {
  for (const cat of catFiles.values()) cat.close();
  catFiles.clear();
}

/** Reads a blob at `ref:file` (ref should be a SHA). */
export async function showFile(repoRoot: string, ref: string, file: string): Promise<string | undefined> {
  if (ref === EMPTY_TREE) return undefined;
  let cat = catFiles.get(repoRoot);
  if (!cat) catFiles.set(repoRoot, (cat = new CatFile(repoRoot)));
  const buf = await cat.read(ref, file);
  return !buf || isBinary(buf) ? undefined : buf.toString('utf8');
}

/** Reads a file from the index. Not cached: the index changes on every stage. */
export async function readIndex(repoRoot: string, file: string): Promise<string | undefined> {
  return tryGit(repoRoot, ['show', `:${file}`]);
}

export async function readWorktree(repoRoot: string, file: string): Promise<string | undefined> {
  try {
    const buf = await readFile(path.join(repoRoot, file));
    return isBinary(buf) ? undefined : buf.toString('utf8');
  } catch {
    return undefined;
  }
}

function splitZ(out: string): string[] {
  return out.split('\0').filter(Boolean);
}

/**
 * Paths git ignores in the working tree (via .gitignore and friends), relative to the repo root,
 * sorted. A fully ignored folder is listed once, without a trailing slash, and not descended into.
 */
export async function listIgnoredPaths(repoRoot: string): Promise<string[]> {
  const out = await git(repoRoot, ['ls-files', '--others', '--ignored', '--exclude-standard', '--directory', '-z']);
  return splitZ(out)
    .map((p) => p.replace(/\/$/, ''))
    .sort();
}

export function wholeFileHunk(content: string): Hunk {
  const lines = content.replace(/\r?\n$/, '').split(/\r?\n/);
  return {
    oldStart: 0,
    oldLines: 0,
    newStart: 1,
    newLines: lines.length,
    lines: lines.map((text) => ({ type: 'add', text })),
  };
}

export interface ChangeSetOptions {
  cwd: string;
  /** Git ref to compare from. Default `HEAD`. */
  base?: string;
  /** Git ref to compare to, or `WORKTREE` (default) for uncommitted changes. */
  target?: string;
}

/** Collects everything that changed between `base` and `target`, with file contents for both sides. */
export async function getChangeSet(opts: ChangeSetOptions): Promise<ChangeSet> {
  const repoRoot = await resolveRepoRoot(opts.cwd);
  const baseLabel = opts.base ?? 'HEAD';
  const target = opts.target ?? WORKTREE;
  const base = await resolveRef(repoRoot, baseLabel);
  const isWorktree = target === WORKTREE;
  const targetSha = isWorktree ? WORKTREE : await resolveRef(repoRoot, target);

  const diffArgs = ['diff', '--no-color', '--no-ext-diff', '-M', '-U3', base];
  if (!isWorktree) diffArgs.push(targetSha);
  const parsed = parseUnifiedDiff(await git(repoRoot, diffArgs));

  const untracked = new Set<string>();
  if (isWorktree) {
    for (const file of splitZ(await git(repoRoot, ['ls-files', '--others', '--exclude-standard', '-z']))) {
      untracked.add(file);
      const content = await readWorktree(repoRoot, file);
      parsed.push({
        path: file,
        status: 'added',
        binary: content === undefined,
        hunks: content ? [wholeFileHunk(content)] : [],
      });
    }
  }

  // Index state is meaningful only for HEAD → working tree: that is what stage / commit act on.
  const withStaging = isWorktree && baseLabel === 'HEAD';
  const byPath = (diff: string) => new Map(parseUnifiedDiff(diff).map((f) => [f.path, f.hunks]));
  const [stagedHunks, unstagedHunks] = withStaging
    ? await Promise.all([
        git(repoRoot, ['diff', '--cached', '--no-color', '--no-ext-diff', '-M', '-U0', base]).then(byPath),
        git(repoRoot, ['diff', '--no-color', '--no-ext-diff', '-U0']).then(byPath),
      ])
    : [new Map<string, Hunk[]>(), new Map<string, Hunk[]>()];

  const readNew = (file: string) =>
    isWorktree ? readWorktree(repoRoot, file) : showFile(repoRoot, targetSha, file);

  const files: FileChange[] = await Promise.all(
    parsed
      .sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))
      .map(async (f): Promise<FileChange> => {
        const staging = withStaging
          ? untracked.has(f.path)
            ? { staged: [], unstaged: f.hunks, hasStaged: false, hasUnstaged: true }
            : {
                indexContent: f.binary ? undefined : await readIndex(repoRoot, f.path),
                staged: stagedHunks.get(f.path) ?? [],
                unstaged: unstagedHunks.get(f.path) ?? [],
                hasStaged: stagedHunks.has(f.path),
                hasUnstaged: unstagedHunks.has(f.path),
              }
          : undefined;
        if (f.binary) return { ...f, staging };
        const [oldContent, newContent] = await Promise.all([
          f.status === 'added' ? undefined : showFile(repoRoot, base, f.oldPath ?? f.path),
          f.status === 'deleted' ? undefined : readNew(f.path),
        ]);
        return { ...f, oldContent, newContent, staging };
      }),
  );

  const repoFiles = isWorktree
    ? splitZ(await git(repoRoot, ['ls-files', '--cached', '--others', '--exclude-standard', '-z']))
    : splitZ(await git(repoRoot, ['ls-tree', '-r', '--name-only', '-z', targetSha]));
  const deleted = new Set(files.filter((f) => f.status === 'deleted').map((f) => f.path));
  const branch = (await tryGit(repoRoot, ['symbolic-ref', '--short', '-q', 'HEAD']))?.trim() || undefined;

  return {
    repoRoot,
    base: baseLabel,
    target,
    ...(branch && { branch }),
    files,
    repoFiles: [...new Set(repoFiles)].filter((f) => !deleted.has(f)).sort(),
  };
}

/** Reads files at the target side of a change set (worktree or a git ref). */
export function createSourceReader(repoRoot: string, target: string): SourceReader {
  let sha: Promise<string> | undefined;
  return {
    async readTarget(file) {
      if (target === WORKTREE) return readWorktree(repoRoot, file);
      sha ??= resolveRef(repoRoot, target);
      return showFile(repoRoot, await sha, file);
    },
  };
}
