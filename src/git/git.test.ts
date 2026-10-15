import { afterEach, describe, expect, it } from 'vitest';
import { ChangeSetSchema, WORKTREE } from '../contracts/index.js';
import { TempRepo } from '../../test/fixtures/repo.js';
import { closeGitReaders, createSourceReader, getChangeSet, parseUnifiedDiff } from './index.js';

let repo: TempRepo;
afterEach(async () => {
  closeGitReaders();
  await new Promise((r) => setTimeout(r, 50)); // let git exit before removing its cwd
  repo?.dispose();
});

describe('parseUnifiedDiff', () => {
  it('parses modified, added, deleted, renamed and binary files', () => {
    const diff = [
      'diff --git a/src/a.ts b/src/a.ts',
      'index 1..2 100644',
      '--- a/src/a.ts',
      '+++ b/src/a.ts',
      '@@ -1,2 +1,3 @@',
      ' keep',
      '-old',
      '+new',
      '+more',
      'diff --git a/new file.ts b/new file.ts',
      'new file mode 100644',
      '--- /dev/null',
      '+++ b/new file.ts',
      '@@ -0,0 +1 @@',
      '+hello',
      String.raw`\ No newline at end of file`,
      'diff --git a/gone.ts b/gone.ts',
      'deleted file mode 100644',
      '--- a/gone.ts',
      '+++ /dev/null',
      '@@ -1 +0,0 @@',
      '-bye',
      'diff --git a/x.ts b/y.ts',
      'similarity index 100%',
      'rename from x.ts',
      'rename to y.ts',
      'diff --git a/img.png b/img.png',
      'Binary files a/img.png and b/img.png differ',
      '',
    ].join('\n');

    const files = parseUnifiedDiff(diff);
    expect(files.map((f) => [f.path, f.status, f.binary])).toEqual([
      ['src/a.ts', 'modified', false],
      ['new file.ts', 'added', false],
      ['gone.ts', 'deleted', false],
      ['y.ts', 'renamed', false],
      ['img.png', 'modified', true],
    ]);
    expect(files[0]!.hunks[0]).toEqual({
      oldStart: 1,
      oldLines: 2,
      newStart: 1,
      newLines: 3,
      lines: [
        { type: 'ctx', text: 'keep' },
        { type: 'del', text: 'old' },
        { type: 'add', text: 'new' },
        { type: 'add', text: 'more' },
      ],
    });
    expect(files[1]!.hunks[0]!.lines).toEqual([{ type: 'add', text: 'hello' }]);
    expect(files[3]!.oldPath).toBe('x.ts');
  });
});

describe('getChangeSet', () => {
  it('collects worktree changes including untracked files', async () => {
    repo = new TempRepo();
    repo.write('a.ts', 'export const a = 1;\n').write('b.ts', 'b\n').write('c.ts', 'c\n').commit();
    repo.write('a.ts', 'export const a = 2;\n').remove('b.ts').write('d.ts', 'export const d = 1;\n');
    repo.write('bin.dat', Buffer.from([0, 1, 2, 3]));

    const cs = await getChangeSet({ cwd: repo.root });
    ChangeSetSchema.parse(cs);
    expect(cs.target).toBe(WORKTREE);
    expect(cs.branch).toBe('main');
    expect(cs.files.map((f) => [f.path, f.status, f.binary])).toEqual([
      ['a.ts', 'modified', false],
      ['b.ts', 'deleted', false],
      ['bin.dat', 'added', true],
      ['d.ts', 'added', false],
    ]);
    const a = cs.files[0]!;
    expect(a.oldContent).toBe('export const a = 1;\n');
    expect(a.newContent).toBe('export const a = 2;\n');
    expect(cs.files[3]!.hunks[0]!.lines).toEqual([{ type: 'add', text: 'export const d = 1;' }]);
    expect(cs.repoFiles).toEqual(['a.ts', 'bin.dat', 'c.ts', 'd.ts']);
  });

  it('compares two commits and detects renames', async () => {
    repo = new TempRepo();
    const body = Array.from({ length: 20 }, (_, i) => `line ${i}`).join('\n') + '\n';
    const first = repo.write('old.ts', body).commit();
    repo.remove('old.ts').write('dir/new.ts', body.replace('line 3', 'line three'));
    const second = repo.commit();
    repo.write('dir/new.ts', 'uncommitted\n'); // must be ignored when target is a commit

    const cs = await getChangeSet({ cwd: repo.root, base: first, target: second });
    expect(cs.files).toHaveLength(1);
    expect(cs.files[0]).toMatchObject({ path: 'dir/new.ts', oldPath: 'old.ts', status: 'renamed' });
    expect(cs.files[0]!.newContent).toContain('line three');
    expect(await createSourceReader(cs.repoRoot, second).readTarget('dir/new.ts')).toContain('line three');
  });

  it('omits the branch when HEAD is detached', async () => {
    repo = new TempRepo();
    const sha = repo.write('a.ts', 'a\n').commit();
    repo.git('checkout', '-q', '--detach', sha);
    expect((await getChangeSet({ cwd: repo.root })).branch).toBeUndefined();
  });

  it('works in a repository without commits', async () => {
    repo = new TempRepo();
    repo.write('a.ts', 'x\n');
    const cs = await getChangeSet({ cwd: repo.root });
    expect(cs.files.map((f) => [f.path, f.status])).toEqual([['a.ts', 'added']]);
  });
});
