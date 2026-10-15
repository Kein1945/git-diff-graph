import { watch } from 'chokidar';
import { createReadStream, existsSync, statSync } from 'node:fs';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { CommitRequestSchema, StageRequestSchema, type CodeGraph, type StageRequest } from '../contracts/index.js';

/** Git operations exposed to the viewer. The server does not know how they are done. */
export interface ServerActions {
  stage(request: StageRequest): Promise<void>;
  commit(message: string): Promise<{ hash: string }>;
}

export interface ServerOptions {
  /** Produces the current graph. The server knows nothing about how. */
  getGraph: () => Promise<CodeGraph>;
  /** Folder with the built viewer (index.html + assets). */
  webDir: string;
  port: number;
  /** Folder to watch for changes; omit to disable live updates. */
  watchRoot?: string;
  /** Paths under `watchRoot` (relative, `/`-separated) not to watch; a folder covers its contents. */
  ignoredPaths?: readonly string[];
  /** Enables POST /api/stage and /api/commit. */
  actions?: ServerActions;
  log?: (msg: string) => void;
}

export interface RunningServer {
  url: string;
  close(): Promise<void>;
}

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.woff': 'font/woff',
  '.wasm': 'application/wasm',
};

const IGNORED_DIRS = new Set(['node_modules', 'dist', 'build', 'out', 'coverage', '.next', '.nuxt', '.turbo', '.cache', 'bin', 'obj', '.vs', '.idea']);

/**
 * Ignore build output, git internals (but keep the git files that change on stage / commit /
 * checkout) and `ignoredPaths` — repo-relative paths with `/` separators; a folder covers its contents.
 */
export function isIgnoredPath(root: string, file: string, ignoredPaths: ReadonlySet<string> = new Set()): boolean {
  const rel = path.relative(root, file).split(path.sep);
  if (rel[0] === '.git') {
    return !(rel.length === 1 || rel[1] === 'HEAD' || rel[1] === 'index' || rel[1] === 'refs');
  }
  if (rel.some((seg) => IGNORED_DIRS.has(seg))) return true;
  let prefix = '';
  for (const seg of rel) {
    prefix = prefix ? `${prefix}/${seg}` : seg;
    if (ignoredPaths.has(prefix)) return true;
  }
  return false;
}

/** Graph without volatile fields, to tell whether a rebuild actually changed anything. */
const fingerprint = (g: CodeGraph) => JSON.stringify({ ...g, meta: { ...g.meta, generatedAt: '' } });

export async function startServer(opts: ServerOptions): Promise<RunningServer> {
  const log = opts.log ?? (() => {});
  let graph: Promise<CodeGraph> = opts.getGraph();
  let version = 0;
  const clients = new Set<ServerResponse>();

  const broadcast = (event: string, data: unknown) => {
    for (const res of clients) res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  };

  // ── live updates ──
  let timer: NodeJS.Timeout | undefined;
  let building = false;
  let pending = false;
  const rebuild = async () => {
    if (building) {
      pending = true;
      return;
    }
    building = true;
    try {
      const prev = await graph.catch(() => undefined);
      const next = opts.getGraph();
      const g = await next;
      graph = next;
      if (!prev || fingerprint(prev) !== fingerprint(g)) {
        version++;
        log(`graph updated (v${version})`);
        broadcast('graph', { version });
      }
    } catch (err) {
      log(`rebuild failed: ${(err as Error).message}`);
      broadcast('error', { message: (err as Error).message });
    } finally {
      building = false;
      if (pending) {
        pending = false;
        void rebuild();
      }
    }
  };
  const ignoredPaths = new Set(opts.ignoredPaths);
  const watcher = opts.watchRoot
    ? watch(opts.watchRoot, {
        ignored: (file) => isIgnoredPath(opts.watchRoot!, file, ignoredPaths),
        ignoreInitial: true,
      })
        .on('all', () => {
          clearTimeout(timer);
          timer = setTimeout(rebuild, 300);
        })
        // An unreadable folder (e.g. a container volume) must not take the server down.
        .on('error', (err) => log(`watch: ${(err as Error).message}`))
    : undefined;

  // ── http ──
  const serveStatic = (req: IncomingMessage, res: ServerResponse) => {
    const urlPath = decodeURIComponent(new URL(req.url ?? '/', 'http://x').pathname);
    let file = path.join(opts.webDir, path.normalize(urlPath).replace(/^([/\\])+/, ''));
    if (!file.startsWith(opts.webDir) || !existsSync(file) || statSync(file).isDirectory()) {
      file = path.join(opts.webDir, 'index.html');
    }
    if (!existsSync(file)) {
      res.writeHead(500, { 'content-type': 'text/plain' }).end('Viewer is not built. Run `npm run build`.');
      return;
    }
    const immutable = file.includes(`${path.sep}assets${path.sep}`);
    res.writeHead(200, {
      'content-type': MIME[path.extname(file)] ?? 'application/octet-stream',
      'cache-control': immutable ? 'public, max-age=31536000, immutable' : 'no-cache',
    });
    createReadStream(file).pipe(res);
  };

  // Mutating requests must carry this token. Other web pages cannot read /api/graph (no CORS),
  // so they cannot learn it, which blocks cross-site requests to the local server.
  const token = randomBytes(16).toString('hex');

  const sendJson = (res: ServerResponse, status: number, body: unknown) => {
    res.writeHead(status, { 'content-type': MIME['.json']!, 'cache-control': 'no-store' }).end(JSON.stringify(body));
  };

  const readJson = (req: IncomingMessage) =>
    new Promise<unknown>((resolve, reject) => {
      let body = '';
      req.on('data', (chunk: Buffer) => {
        body += chunk.toString('utf8');
        if (body.length > 1_000_000) req.destroy(new Error('Request too large'));
      });
      req.on('end', () => {
        try {
          resolve(JSON.parse(body || '{}'));
        } catch {
          reject(new Error('Invalid JSON'));
        }
      });
      req.on('error', reject);
    });

  const allowed = (req: IncomingMessage) => {
    const origin = req.headers.origin;
    const localOrigin = !origin || /^https?:\/\/(127\.0\.0\.1|localhost)(:\d+)?$/.test(origin);
    return req.method === 'POST' && req.headers['x-vc-token'] === token && localOrigin;
  };

  const handleAction = async (req: IncomingMessage, res: ServerResponse, run: (body: unknown) => Promise<unknown>) => {
    if (!opts.actions) return sendJson(res, 404, { error: 'Git actions are not available for this comparison' });
    if (!allowed(req)) return sendJson(res, 403, { error: 'Forbidden' });
    try {
      const result = await run(await readJson(req));
      clearTimeout(timer);
      await rebuild(); // show the new state right away instead of waiting for the watcher
      sendJson(res, 200, { ok: true, result });
    } catch (err) {
      sendJson(res, 400, { error: (err as Error).message });
    }
  };

  const handler = async (req: IncomingMessage, res: ServerResponse) => {
    const { pathname } = new URL(req.url ?? '/', 'http://x');
    if (pathname === '/api/stage') {
      return handleAction(req, res, (body) => opts.actions!.stage(StageRequestSchema.parse(body)));
    }
    if (pathname === '/api/commit') {
      return handleAction(req, res, (body) => opts.actions!.commit(CommitRequestSchema.parse(body).message));
    }
    if (pathname === '/api/graph') {
      try {
        const g = await graph;
        res.writeHead(200, { 'content-type': MIME['.json']!, 'cache-control': 'no-store' });
        res.end(JSON.stringify({ version, live: !!watcher, token: opts.actions ? token : undefined, graph: g }));
      } catch (err) {
        res.writeHead(500, { 'content-type': MIME['.json']! }).end(JSON.stringify({ error: (err as Error).message }));
        graph = opts.getGraph(); // retry on next request
      }
      return;
    }
    if (pathname === '/api/events') {
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store', connection: 'keep-alive' });
      res.write(`event: hello\ndata: ${JSON.stringify({ version })}\n\n`);
      clients.add(res);
      req.on('close', () => clients.delete(res));
      return;
    }
    serveStatic(req, res);
  };

  const server: Server = createServer((req, res) => void handler(req, res));
  const port = await listen(server, opts.port);
  const keepAlive = setInterval(() => broadcast('ping', {}), 25_000);

  return {
    url: `http://127.0.0.1:${port}`,
    async close() {
      clearInterval(keepAlive);
      clearTimeout(timer);
      await watcher?.close();
      for (const res of clients) res.end();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

/** Listens on `port`, or the next free one. */
async function listen(server: Server, port: number, attempts = 20): Promise<number> {
  for (let p = port; p < port + attempts; p++) {
    const ok = await new Promise<boolean>((resolve) => {
      const onError = (err: NodeJS.ErrnoException) => {
        server.off('listening', onListening);
        if (err.code === 'EADDRINUSE') resolve(false);
        else throw err;
      };
      const onListening = () => {
        server.off('error', onError);
        resolve(true);
      };
      server.once('error', onError);
      server.once('listening', onListening);
      server.listen(p, '127.0.0.1');
    });
    if (ok) return p;
  }
  throw new Error(`No free port in ${port}..${port + attempts - 1}`);
}
