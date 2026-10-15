import { chmodSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { CodeGraph, StageRequest } from '../contracts/index.js';
import { isIgnoredPath, startServer, type RunningServer } from './index.js';

const graph = (n: number): CodeGraph => ({
  meta: { repoRoot: '/r', base: 'HEAD', target: 'WORKTREE', generatedAt: '', staging: true },
  nodes: [],
  edges: [],
  files: { [`f${n}`]: { path: `f${n}`, status: 'modified', binary: false, lines: [], truncated: false } },
});

let server: RunningServer | undefined;
afterEach(async () => {
  await server?.close();
  server = undefined;
});

describe('server git actions', () => {
  it('requires the token from /api/graph and rebuilds after an action', async () => {
    const webDir = mkdtempSync(path.join(tmpdir(), 'vc-web-'));
    writeFileSync(path.join(webDir, 'index.html'), '<html></html>');
    const calls: StageRequest[] = [];
    let builds = 0;
    server = await startServer({
      getGraph: async () => graph(++builds),
      webDir,
      port: 4390,
      actions: {
        stage: async (req) => void calls.push(req),
        commit: async () => ({ hash: 'abc' }),
      },
    });

    const { token, graph: first } = (await (await fetch(`${server.url}/api/graph`)).json()) as { token: string; graph: CodeGraph };
    expect(token).toMatch(/^[0-9a-f]{32}$/);
    expect(Object.keys(first.files)).toEqual(['f1']);

    const post = (url: string, body: unknown, headers: Record<string, string> = {}) =>
      fetch(`${server!.url}${url}`, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) });

    expect((await post('/api/stage', { action: 'stage', paths: ['a'] })).status).toBe(403);
    expect((await post('/api/stage', { action: 'stage', paths: ['a'] }, { 'x-vc-token': token, origin: 'https://evil.example' })).status).toBe(403);

    const ok = await post('/api/stage', { action: 'stage', paths: ['a'] }, { 'x-vc-token': token });
    expect(ok.status).toBe(200);
    expect(calls).toEqual([{ action: 'stage', paths: ['a'] }]);
    const after = (await (await fetch(`${server.url}/api/graph`)).json()) as { graph: CodeGraph };
    expect(Object.keys(after.graph.files)).toEqual(['f2']);

    const bad = await post('/api/commit', { message: '  ' }, { 'x-vc-token': token });
    expect(bad.status).toBe(400);
    const commit = await post('/api/commit', { message: 'msg' }, { 'x-vc-token': token });
    expect(await commit.json()).toEqual({ ok: true, result: { hash: 'abc' } });
  });
});

describe('isIgnoredPath', () => {
  const root = path.join(tmpdir(), 'repo');
  const at = (rel: string) => path.join(root, ...rel.split('/'));
  const ignored = new Set(['dev/volumes', 'err.log']);

  it('skips build output, git internals except HEAD/index/refs, and the given paths with their contents', () => {
    expect(isIgnoredPath(root, at('node_modules/x/index.js'))).toBe(true);
    expect(isIgnoredPath(root, at('.git/objects/ab'))).toBe(true);
    expect(isIgnoredPath(root, at('.git/HEAD'))).toBe(false);
    expect(isIgnoredPath(root, at('dev/volumes'), ignored)).toBe(true);
    expect(isIgnoredPath(root, at('dev/volumes/db/data'), ignored)).toBe(true);
    expect(isIgnoredPath(root, at('err.log'), ignored)).toBe(true);
    expect(isIgnoredPath(root, at('dev/compose.yml'), ignored)).toBe(false);
    expect(isIgnoredPath(root, at('dev/volumes2/x'), ignored)).toBe(false);
    expect(isIgnoredPath(root, root, ignored)).toBe(false);
  });
});

describe('server live updates', () => {
  // root can read anything, so the unreadable folder would not be unreadable.
  it.skipIf(process.getuid?.() === 0)('survives a folder it cannot read', async () => {
    const webDir = mkdtempSync(path.join(tmpdir(), 'vc-web-'));
    writeFileSync(path.join(webDir, 'index.html'), '<html></html>');
    const repoDir = mkdtempSync(path.join(tmpdir(), 'vc-watch-'));
    const locked = path.join(repoDir, 'volumes', 'data');
    mkdirSync(path.join(locked, 'inner'), { recursive: true });
    chmodSync(locked, 0o000);
    const logs: string[] = [];
    try {
      server = await startServer({ getGraph: async () => graph(1), webDir, port: 4391, watchRoot: repoDir, log: (m) => logs.push(m) });
      await new Promise((r) => setTimeout(r, 300)); // let chokidar walk the tree
      expect((await fetch(`${server.url}/api/graph`)).status).toBe(200);
      expect(logs.some((m) => m.startsWith('watch: ') && m.includes('EACCES'))).toBe(true);
    } finally {
      chmodSync(locked, 0o755);
    }
  });
});
