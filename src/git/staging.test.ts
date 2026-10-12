import { afterEach, describe, expect, it } from 'vitest';
import { TempRepo } from '../../test/fixtures/repo.js';
import { closeGitReaders, createGitActions, getChangeSet } from './index.js';

let repo: TempRepo;
afterEach(async () => {
  closeGitReaders();
  await new Promise((r) => setTimeout(r, 50));
  repo?.dispose();
});

// f1: lines 1-3, f2: lines 5-7
const HEAD = 'function f1() {\n  return 1;\n}\n\nfunction f2() {\n  return 2;\n}\n';
const WORK = 'function f1() {\n  return 10;\n}\n\nfunction f2() {\n  return 20;\n}\n';

const cached = () => repo.git('diff', '--cached', '-U0', '--no-color');

describe('git actions', () => {
  it('stages and unstages only the lines of one function', async () => {
    repo = new TempRepo();
    repo.write('f.ts', HEAD).commit();
    repo.write('f.ts', WORK);
    const actions = createGitActions(repo.root);

    await actions.stage({ action: 'stage', paths: [], range: { path: 'f.ts', start: 1, end: 3, side: 'new' } });
    expect(cached()).toContain('+  return 10;');
    expect(cached()).not.toContain('return 20');
    expect(repo.git('show', ':f.ts')).toBe(WORK.replace('return 20', 'return 2'));

    const cs = await getChangeSet({ cwd: repo.root });
    expect(cs.files[0]!.staging!.staged).toHaveLength(1);
    expect(cs.files[0]!.staging!.unstaged).toHaveLength(1);

    await actions.stage({ action: 'unstage', paths: [], range: { path: 'f.ts', start: 1, end: 3, side: 'new' } });
    expect(cached()).toBe('');
  });

  it('unstages one function while keeping another staged', async () => {
    repo = new TempRepo();
    repo.write('f.ts', HEAD).commit();
    repo.write('f.ts', WORK);
    repo.git('add', 'f.ts');
    const actions = createGitActions(repo.root);

    await actions.stage({ action: 'unstage', paths: [], range: { path: 'f.ts', start: 5, end: 7, side: 'new' } });
    expect(repo.git('show', ':f.ts')).toBe(WORK.replace('return 20', 'return 2'));
  });

  it('stages and unstages the removal of a deleted function by its HEAD lines', async () => {
    repo = new TempRepo();
    repo.write('f.ts', HEAD).commit();
    repo.write('f.ts', 'function f1() {\n  return 10;\n}\n');
    const actions = createGitActions(repo.root);
    await actions.stage({ action: 'stage', paths: [], range: { path: 'f.ts', start: 5, end: 7, side: 'old' } });
    const index = repo.git('show', ':f.ts');
    expect(index).not.toContain('f2');
    expect(index).toContain('return 1;'); // f1's own change stays unstaged
    await actions.stage({ action: 'unstage', paths: [], range: { path: 'f.ts', start: 5, end: 7, side: 'old' } });
    expect(repo.git('show', ':f.ts')).toBe(HEAD);
  });

  it('stages part of an untracked file', async () => {
    repo = new TempRepo();
    repo.write('keep.txt', 'x\n').commit();
    repo.write('n.ts', WORK);
    await createGitActions(repo.root).stage({ action: 'stage', paths: [], range: { path: 'n.ts', start: 5, end: 7, side: 'new' } });
    expect(repo.git('show', ':n.ts')).toBe('function f2() {\n  return 20;\n}\n');
  });

  it('keeps CRLF line endings when staging a range', async () => {
    repo = new TempRepo();
    const crlf = (s: string) => s.replace(/\n/g, '\r\n');
    repo.write('f.ts', crlf(HEAD)).commit();
    repo.write('f.ts', crlf(WORK));
    await createGitActions(repo.root).stage({ action: 'stage', paths: [], range: { path: 'f.ts', start: 1, end: 3, side: 'new' } });
    expect(repo.git('show', ':f.ts')).toBe(crlf(WORK.replace('return 20', 'return 2')));
  });

  it('stages and unstages whole files, including deletions', async () => {
    repo = new TempRepo();
    repo.write('a.ts', 'a\n').write('b.ts', 'b\n').commit();
    repo.write('a.ts', 'A\n').remove('b.ts');
    const actions = createGitActions(repo.root);
    await actions.stage({ action: 'stage', paths: ['a.ts', 'b.ts'] });
    expect(repo.git('diff', '--cached', '--name-status').trim().split('\n')).toEqual(['M\ta.ts', 'D\tb.ts']);
    await actions.stage({ action: 'unstage', paths: ['a.ts', 'b.ts'] });
    expect(cached()).toBe('');
  });

  it('commits only staged changes and refuses an empty index', async () => {
    repo = new TempRepo();
    repo.write('a.ts', 'a\n').write('b.ts', 'b\n').commit();
    repo.write('a.ts', 'A\n').write('b.ts', 'B\n');
    const actions = createGitActions(repo.root);
    await expect(actions.commit('nothing')).rejects.toThrow('Nothing staged');

    await actions.stage({ action: 'stage', paths: ['a.ts'] });
    const { hash } = await actions.commit('Update a');
    expect(repo.git('log', '-1', '--format=%H %s').trim()).toBe(`${hash} Update a`);
    expect(repo.git('status', '--porcelain').trim()).toBe('M b.ts');
  });
});
