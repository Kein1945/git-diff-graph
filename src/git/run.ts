import { execFile, spawn } from 'node:child_process';
import path from 'node:path';
import { promisify } from 'node:util';

const exec = promisify(execFile);

/** Git's well-known empty tree, used as the base in a repository without commits. */
export const EMPTY_TREE = '4b825dc642cb6eb9a060e54bf8d69288fbee4904';
const MAX_TEXT_BYTES = 2 * 1024 * 1024;

export async function git(cwd: string, args: string[]): Promise<string> {
  const { stdout } = await exec('git', ['-c', 'core.quotepath=off', ...args], {
    cwd,
    maxBuffer: 512 * 1024 * 1024,
    encoding: 'utf8',
    windowsHide: true,
  });
  return stdout;
}

export async function tryGit(cwd: string, args: string[]): Promise<string | undefined> {
  try {
    return await git(cwd, args);
  } catch {
    return undefined;
  }
}

/** Runs git with `input` on stdin. Rejects with git's stderr on a non-zero exit. */
export function gitWithInput(cwd: string, args: string[], input: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const proc = spawn('git', args, { cwd, windowsHide: true });
    let out = '';
    let err = '';
    proc.stdout.on('data', (d: Buffer) => (out += d.toString('utf8')));
    proc.stderr.on('data', (d: Buffer) => (err += d.toString('utf8')));
    proc.on('error', reject);
    proc.on('close', (code) => (code === 0 ? resolve(out) : reject(new Error(err.trim() || `git ${args[0]} failed`))));
    proc.stdin.end(input, 'utf8');
  });
}

/** Turns a failed git call into an Error with git's own message. */
export function gitError(err: unknown): Error {
  const e = err as { stderr?: string; stdout?: string; message?: string };
  return new Error((e.stderr || e.stdout || e.message || 'git failed').trim());
}

export function isBinary(buf: Buffer): boolean {
  return buf.length > MAX_TEXT_BYTES || buf.subarray(0, 8000).includes(0);
}

export async function resolveRepoRoot(cwd: string): Promise<string> {
  const out = await git(cwd, ['rev-parse', '--show-toplevel']);
  return path.resolve(out.trim());
}

export async function hasCommits(repoRoot: string): Promise<boolean> {
  return (await tryGit(repoRoot, ['rev-parse', '--verify', '--quiet', 'HEAD^{commit}'])) !== undefined;
}
