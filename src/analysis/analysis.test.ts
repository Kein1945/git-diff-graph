import { beforeAll, describe, expect, it } from 'vitest';
import { CodeGraphSchema, type ChangeSet, type SourceReader } from '../contracts/index.js';
import { change, hunks } from '../../test/fixtures/change.js';
import { buildDiffView, createAnalyzer, createTypeScriptAdapter, diffSymbols, type SymbolInfo } from './index.js';

const ts = createTypeScriptAdapter();
beforeAll(() => ts.init());

const names = (symbols: SymbolInfo[]): unknown =>
  symbols.map((s) => (s.children.length ? [`${s.kind}:${s.name}`, names(s.children)] : `${s.kind}:${s.name}`));

describe('typescript adapter', () => {
  it('finds functions, classes, methods, types and nested scopes', () => {
    const code = `
import { x } from './x';
export function top(a: number) {
  function inner() { return 1 }
  const arrow = () => 2;
  return a;
}
export const Comp = memo(() => null);
export default class Service {
  private handler = () => 1;
  save() { const check = function () {}; }
  static create(): Service { return new Service() }
}
interface Props { a: string }
type Id = string;
enum Color { Red }
const notAFunction = 5;
`;
    expect(names(ts.parseSymbols(code, 'a.ts'))).toEqual([
      ['function:top', ['function:inner', 'function:arrow']],
      'function:Comp',
      ['class:Service', ['method:handler', ['method:save', ['function:check']], 'method:create']],
      'type:Props',
      'type:Id',
      'type:Color',
    ]);
  });

  it('marks exported symbols and internal ones', () => {
    const code = `export function pub() {}
function local() { function nested() {} }
export const arrow = () => 1;
const later = () => 2;
const hidden = () => 3;
export { later as renamed };
export default class Svc {
  private a() {}
  #b() {}
  c() {}
}
`;
    const flat = (list: SymbolInfo[]): [string, boolean | undefined][] =>
      list.flatMap((s) => [[s.name, s.exported] as [string, boolean | undefined], ...flat(s.children)]);
    expect(flat(ts.parseSymbols(code, 'e.ts'))).toEqual([
      ['pub', true],
      ['local', false],
      ['nested', false],
      ['arrow', true],
      ['later', true],
      ['hidden', false],
      ['Svc', true],
      ['a', false],
      ['#b', false],
      ['c', undefined],
    ]);
  });

  it('includes the export keyword line in the range', () => {
    const [sym] = ts.parseSymbols('export const f = async () => {\n  return 1;\n};\n', 'a.ts');
    expect(sym!.range).toEqual({ start: 1, end: 3 });
  });

  it('parses JSX in .tsx and .jsx files', () => {
    expect(names(ts.parseSymbols('export function App() { return <div>{1}</div> }', 'App.tsx'))).toEqual(['function:App']);
    expect(names(ts.parseSymbols('export const App = () => <div/>;', 'App.jsx'))).toEqual(['function:App']);
  });

  it('collects static, re-export, dynamic and require imports', () => {
    const code = `import a from './a'; import type { T } from "../t"; export * from './re';
      const b = await import('./b'); const c = require('c'); import 'side-effect';`;
    expect(ts.parseImports(code, 'src/m.ts').sort()).toEqual(['../t', './a', './b', './re', 'c', 'side-effect']);
  });

  it('resolves relative paths, index files, NodeNext .js and aliases', () => {
    const files = new Set(['src/a.ts', 'src/lib/index.tsx', 'src/util.ts', 'src/style.css']);
    const ctx = { files, aliases: [{ pattern: '@/*', targets: ['src/*'] }] };
    expect(ts.resolveImport('./a', 'src/m.ts', ctx)).toBe('src/a.ts');
    expect(ts.resolveImport('./lib', 'src/m.ts', ctx)).toBe('src/lib/index.tsx');
    expect(ts.resolveImport('./util.js', 'src/m.ts', ctx)).toBe('src/util.ts');
    expect(ts.resolveImport('./style.css', 'src/m.ts', ctx)).toBe('src/style.css');
    expect(ts.resolveImport('@/a', 'src/deep/m.ts', ctx)).toBe('src/a.ts');
    expect(ts.resolveImport('react', 'src/m.ts', ctx)).toBeUndefined();
  });
});

describe('diff view and symbol diff', () => {
  const oldCode = 'function a() {\n  return 1;\n}\n\nfunction b() {\n  return 2;\n}\n\nfunction gone() {}\n';
  const newCode = 'function a() {\n  return 10;\n}\n\nfunction b() {\n  return 2;\n}\n\nfunction fresh() {}\n';

  it('interleaves removed lines into the full new file', () => {
    const view = buildDiffView(change('f.ts', 'a\nb\nc\n', 'a\nB\nc\n'));
    expect(view.lines).toEqual([
      { t: 'ctx', text: 'a', old: 1, new: 1 },
      { t: 'del', text: 'b', old: 2 },
      { t: 'add', text: 'B', new: 2 },
      { t: 'ctx', text: 'c', old: 3, new: 3 },
    ]);
  });

  it('marks symbols as modified / added / removed and drops unchanged ones', () => {
    const c = change('f.ts', oldCode, newCode);
    const view = buildDiffView(c);
    const added = new Set(view.lines.filter((l) => l.t === 'add').map((l) => l.new!));
    const removed = new Set(view.lines.filter((l) => l.t === 'del').map((l) => l.old!));
    const result = diffSymbols(ts.parseSymbols(oldCode, 'f.ts'), ts.parseSymbols(newCode, 'f.ts'), { added, removed });
    expect(result.map((s) => [s.qualifiedName, s.status])).toEqual([
      ['a', 'modified'],
      ['fresh', 'added'],
      ['gone', 'removed'],
    ]);
  });

  it('keeps an unchanged class that contains a changed method', () => {
    const before = 'class K {\n  m() { return 1 }\n  n() {}\n}\n';
    const after = 'class K {\n  m() { return 2 }\n  n() {}\n}\n';
    const result = diffSymbols(ts.parseSymbols(before, 'k.ts'), ts.parseSymbols(after, 'k.ts'), {
      added: new Set([2]),
      removed: new Set([2]),
    });
    expect(result.map((s) => [s.qualifiedName, s.status])).toEqual([
      ['K', 'modified'],
      ['K.m', 'modified'],
    ]);
  });
});

describe('analyzer', () => {
  it('builds a graph with symbols, import diff, context dependents and directories', async () => {
    const repo: Record<string, string> = {
      'src/api.ts': "import { db } from './db';\nexport function load() {\n  return db();\n}\n",
      'src/db.ts': 'export function db() {}\n',
      'src/log.ts': 'export function log() {}\n',
      'src/page.ts': "import { load } from './api';\nload();\n",
      'README.md': '# hi\n',
    };
    const newApi = "import { log } from './log';\nexport function load() {\n  log();\n  return 1;\n}\n";
    const changeSet: ChangeSet = {
      repoRoot: '/repo',
      base: 'HEAD',
      target: 'WORKTREE',
      repoFiles: Object.keys(repo).sort(),
      files: [change('README.md', '# hi\n', '# hello\n'), change('src/api.ts', repo['src/api.ts'], newApi)],
    };
    const reader: SourceReader = { readTarget: async (p) => (p === 'src/api.ts' ? newApi : repo[p]) };

    const graph = CodeGraphSchema.parse(await createAnalyzer({ adapters: [ts] }).analyze(changeSet, reader));

    expect(graph.nodes.map((n) => [n.id, n.status, n.isContext, n.parentId ?? null])).toEqual([
      ['dir:src', 'modified', false, null],
      ['file:README.md', 'modified', false, null],
      ['file:src/api.ts', 'modified', false, 'dir:src'],
      ['file:src/db.ts', 'unchanged', true, 'dir:src'],
      ['file:src/log.ts', 'unchanged', true, 'dir:src'],
      ['file:src/page.ts', 'unchanged', true, 'dir:src'],
      ['sym:src/api.ts#load', 'modified', false, 'file:src/api.ts'],
    ]);
    expect(graph.edges.map((e) => [e.id, e.status])).toEqual([
      ['import:file:src/api.ts->file:src/db.ts', 'removed'],
      ['import:file:src/api.ts->file:src/log.ts', 'added'],
      ['import:file:src/page.ts->file:src/api.ts', 'unchanged'],
    ]);
    expect(graph.files['src/api.ts']!.lines.filter((l) => l.t !== 'ctx')).toHaveLength(5);
  });

  it('marks a directory added or removed when all its changed files are', async () => {
    const changeSet: ChangeSet = {
      repoRoot: '/repo',
      base: 'HEAD',
      target: 'WORKTREE',
      repoFiles: ['new/a.ts', 'new/b.ts'],
      files: [
        change('new/a.ts', undefined, 'export const a = 1;\n'),
        change('new/b.ts', undefined, 'b\n'),
        change('old/c.ts', 'c\n', undefined),
      ],
    };
    const graph = await createAnalyzer({ adapters: [ts] }).analyze(changeSet, { readTarget: async () => undefined });
    expect(graph.nodes.filter((n) => n.kind === 'dir').map((n) => [n.id, n.status])).toEqual([
      ['dir:new', 'added'],
      ['dir:old', 'removed'],
    ]);
  });
});

describe('import noise', () => {
  it('hides old imports of untouched files but keeps new ones and affected dependents', async () => {
    const repo: Record<string, string> = {
      'app.ts': "import { a } from './a';\nimport { b } from './b';\nexport function run() {\n  return a;\n}\n",
      'a.ts': 'export const a = 1;\n',
      'b.ts': 'export const b = 1;\n',
      'c.ts': 'export const c = 1;\n',
      'main.ts': "import { run } from './app';\nrun();\n",
    };
    const newApp = "import { a } from './a';\nimport { b } from './b';\nimport { c } from './c';\nexport function run() {\n  return a + c;\n}\n";
    const changeSet: ChangeSet = {
      repoRoot: '/repo',
      base: 'HEAD',
      target: 'WORKTREE',
      repoFiles: Object.keys(repo).sort(),
      files: [change('app.ts', repo['app.ts'], newApp)],
    };
    const reader: SourceReader = { readTarget: async (p) => (p === 'app.ts' ? newApp : repo[p]) };
    const graph = await createAnalyzer({ adapters: [ts] }).analyze(changeSet, reader);
    expect(graph.edges.map((e) => [e.source, e.target, e.status])).toEqual([
      ['file:app.ts', 'file:c.ts', 'added'],
      ['file:main.ts', 'file:app.ts', 'unchanged'],
    ]);
    expect(graph.nodes.filter((n) => n.kind === 'file').map((n) => n.path)).toEqual(['app.ts', 'c.ts', 'main.ts']);
  });
});

describe('staged state', () => {
  // f1 lines 1-3, f2 lines 5-7; both bodies changed. Only f1's change is in the index.
  const head = 'function f1() {\n  return 1;\n}\n\nfunction f2() {\n  return 2;\n}\n';
  const index = 'function f1() {\n  return 10;\n}\n\nfunction f2() {\n  return 2;\n}\n';
  const work = 'function f1() {\n  return 10;\n}\n\nfunction f2() {\n  return 20;\n}\n';

  it('marks the staged function full, the other none and the file partial', async () => {
    const c = change('f.ts', head, work);
    c.staging = { indexContent: index, staged: hunks(head, index), unstaged: hunks(index, work) };
    const changeSet: ChangeSet = { repoRoot: '/r', base: 'HEAD', target: 'WORKTREE', repoFiles: ['f.ts'], files: [c] };
    const graph = await createAnalyzer({ adapters: [ts] }).analyze(changeSet, { readTarget: async () => work });
    expect(graph.meta.staging).toBe(true);
    expect(graph.nodes.map((n) => [n.id, n.staged])).toEqual([
      ['file:f.ts', 'partial'],
      ['sym:f.ts#f1', 'full'],
      ['sym:f.ts#f2', 'none'],
    ]);
  });

  it('marks a pure rename (no hunks) by whether it is in the index', async () => {
    const body = 'export const x = 1;\n';
    const renamed = (staging: { hasStaged: boolean; hasUnstaged: boolean }) => ({
      ...change('new.ts', body, body),
      oldPath: 'old.ts',
      status: 'renamed' as const,
      hunks: [],
      staging: { staged: [], unstaged: [], ...staging },
    });
    const staged = (c: ReturnType<typeof renamed>) =>
      createAnalyzer({ adapters: [ts] })
        .analyze({ repoRoot: '/r', base: 'HEAD', target: 'WORKTREE', repoFiles: ['new.ts'], files: [c] }, { readTarget: async () => body })
        .then((g) => g.nodes.find((n) => n.id === 'file:new.ts')!.staged);
    expect(await staged(renamed({ hasStaged: true, hasUnstaged: false }))).toBe('full');
    expect(await staged(renamed({ hasStaged: false, hasUnstaged: true }))).toBe('none');
  });
});
