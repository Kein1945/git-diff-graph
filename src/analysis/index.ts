import { createHash } from 'node:crypto';
import path from 'node:path';
import {
  WORKTREE,
  type ChangeSet,
  type CodeGraph,
  type FileDiff,
  type GraphEdge,
  type GraphNode,
  type SourceReader,
} from '../contracts/index.js';
import type { ImportResolveContext, LanguageAdapter, PathAlias, SymbolInfo } from './adapters/types.js';
import { createTypeScriptAdapter } from './adapters/typescript.js';
import { buildDiffView, changedLines } from '../diff/index.js';
import {
  addDirectoryNodes,
  contextFileNode,
  fileId,
  fileStatus,
  importEdgeId,
  sortGraph,
  symbolId,
} from './graph.js';
import { fileStaged, rangeStaged } from './staging.js';
import { diffSymbols } from './symbols.js';

export type { ImportResolveContext, LanguageAdapter, PathAlias, SymbolInfo } from './adapters/types.js';
export { createTypeScriptAdapter } from './adapters/typescript.js';
export { buildDiffView } from '../diff/index.js';
export { diffSymbols } from './symbols.js';

export interface AnalyzerOptions {
  adapters?: LanguageAdapter[];
  /** Max unchanged files that import one changed file to show as context. */
  maxDependentsPerFile?: number;
  /** Skip the context scan in repositories with more source files than this. */
  maxScannedFiles?: number;
}

export interface Analyzer {
  analyze(changeSet: ChangeSet, reader: SourceReader): Promise<CodeGraph>;
}

/** `from '…'`, `import '…'`, `import('…')`, `require('…')` — a superset of real imports. */
const IMPORT_LIKE = /\b(?:from|import|require)\s*\(?\s*['"`]([^'"`\n]+)['"`]/g;

/** Parses tsconfig/jsconfig JSON with comments and trailing commas. */
function parseJsonc(text: string): unknown {
  const noComments = text.replace(/("(?:\\.|[^"\\])*")|\/\/[^\n]*|\/\*[\s\S]*?\*\//g, (_m, str: string | undefined) => str ?? '');
  return JSON.parse(noComments.replace(/,(\s*[}\]])/g, '$1'));
}

async function loadAliases(reader: SourceReader): Promise<PathAlias[]> {
  for (const name of ['tsconfig.json', 'jsconfig.json']) {
    const text = await reader.readTarget(name);
    if (!text) continue;
    try {
      const opts = (parseJsonc(text) as { compilerOptions?: { baseUrl?: string; paths?: Record<string, string[]> } })
        .compilerOptions;
      const baseUrl = opts?.baseUrl ?? '.';
      return Object.entries(opts?.paths ?? {}).map(([pattern, targets]) => ({
        pattern,
        targets: targets.map((t) => path.posix.normalize(path.posix.join(baseUrl, t))),
      }));
    } catch {
      return [];
    }
  }
  return [];
}

export function createAnalyzer(options: AnalyzerOptions = {}): Analyzer {
  const adapters = options.adapters ?? [createTypeScriptAdapter()];
  const maxDependents = options.maxDependentsPerFile ?? 12;
  const maxScanned = options.maxScannedFiles ?? 5000;
  let ready: Promise<void> | undefined;
  /** Import specifiers of unchanged files, keyed by path + content hash, reused across runs. */
  const importCache = new Map<string, string[]>();

  const adapterFor = (file: string) => {
    const ext = path.posix.extname(file).toLowerCase();
    return adapters.find((a) => a.extensions.includes(ext));
  };

  const symbolsOf = (adapter: LanguageAdapter, code: string | undefined, file: string): SymbolInfo[] =>
    code === undefined ? [] : adapter.parseSymbols(code, file);

  const importsOf = (adapter: LanguageAdapter, code: string | undefined, file: string, ctx: ImportResolveContext) => {
    if (code === undefined) return [];
    const resolved = adapter.parseImports(code, file).map((s) => adapter.resolveImport(s, file, ctx));
    return [...new Set(resolved.filter((r): r is string => !!r && r !== file))];
  };

  /**
   * Import specifiers of an unchanged file. Files that never mention any changed module by name
   * cannot import it, so they are skipped without parsing.
   */
  async function cachedImports(adapter: LanguageAdapter, file: string, reader: SourceReader, mentions: readonly string[]): Promise<string[]> {
    const code = await reader.readTarget(file);
    if (code === undefined || code.length > 512 * 1024) return [];
    // Cheap regex pre-pass: only files with an import-like string naming a changed module get parsed.
    let candidate = false;
    for (const m of code.matchAll(IMPORT_LIKE)) {
      if (mentions.some((name) => m[1]!.includes(name))) {
        candidate = true;
        break;
      }
    }
    if (!candidate) return [];
    const key = `${file}\0${createHash('sha1').update(code).digest('hex')}`;
    let specs = importCache.get(key);
    if (!specs) {
      specs = adapter.parseImports(code, file);
      importCache.set(key, specs);
    }
    return specs;
  }

  return {
    async analyze(changeSet, reader) {
      ready ??= Promise.all(adapters.map((a) => a.init())).then(() => undefined);
      await ready;

      const nodes = new Map<string, GraphNode>();
      const edges = new Map<string, GraphEdge>();
      const files: Record<string, FileDiff> = {};

      const changedPaths = new Set(changeSet.files.map((f) => f.path));
      const renamedTo = new Map(changeSet.files.filter((f) => f.oldPath).map((f) => [f.oldPath!, f.path]));
      const ctx: ImportResolveContext = {
        files: new Set([...changeSet.repoFiles, ...changeSet.files.flatMap((f) => [f.path, f.oldPath ?? f.path])]),
        aliases: await loadAliases(reader),
      };

      const addEdge = (from: string, to: string, status: GraphEdge['status']) => {
        const id = importEdgeId(fileId(from), fileId(to));
        edges.set(id, { id, source: fileId(from), target: fileId(to), kind: 'import', status, confidence: 'exact' });
      };
      const ensureContext = (p: string) => {
        if (!nodes.has(fileId(p))) nodes.set(fileId(p), contextFileNode(p, adapterFor(p)?.id));
      };

      // 1. Changed files: diff view, symbols, import edges.
      for (const change of changeSet.files) {
        const adapter = adapterFor(change.path);
        const view = buildDiffView(change);
        const changed = changedLines(view.lines);
        files[change.path] = {
          path: change.path,
          oldPath: change.oldPath,
          status: change.status,
          binary: change.binary,
          language: adapter?.id,
          lines: view.lines,
          truncated: view.truncated,
        };
        nodes.set(fileId(change.path), {
          id: fileId(change.path),
          kind: 'file',
          name: path.posix.basename(change.path),
          path: change.path,
          status: fileStatus(change),
          isContext: false,
          ranges: {},
          stats: { add: changed.added.size, del: changed.removed.size },
          language: adapter?.id,
          staged: fileStaged(change),
        });
        if (!adapter || change.binary) continue;

        const oldFile = change.oldPath ?? change.path;
        for (const s of diffSymbols(
          symbolsOf(adapter, change.oldContent, oldFile),
          symbolsOf(adapter, change.newContent, change.path),
          changed,
        )) {
          nodes.set(symbolId(change.path, s.qualifiedName), {
            id: symbolId(change.path, s.qualifiedName),
            kind: s.kind,
            name: s.name,
            parentId: s.parentQualifiedName ? symbolId(change.path, s.parentQualifiedName) : fileId(change.path),
            path: change.path,
            status: s.status,
            isContext: false,
            ranges: s.ranges,
            stats: s.stats,
            language: adapter.id,
            staged: s.status === 'unchanged' ? undefined : rangeStaged(change, s.ranges),
            exported: s.exported,
          });
        }

        const before = importsOf(adapter, change.oldContent, oldFile, ctx).map((p) => renamedTo.get(p) ?? p);
        const after = importsOf(adapter, change.newContent, change.path, ctx);
        for (const to of new Set([...before, ...after])) {
          const status = !before.includes(to) ? 'added' : !after.includes(to) ? 'removed' : 'unchanged';
          // An import that existed before and points at an untouched file is not part of the change.
          if (status === 'unchanged' && !changedPaths.has(to)) continue;
          addEdge(change.path, to, status);
          if (!changedPaths.has(to)) ensureContext(to);
        }
      }

      // 2. Unchanged files that import a changed file become context.
      const scannable = changeSet.repoFiles.filter((f) => !changedPaths.has(f) && adapterFor(f));
      // How a changed file can appear in an import: its name without extension, or its folder for index files.
      const mentions = [...new Set(changeSet.files.map((f) => {
        const name = path.posix.basename(f.path).replace(/\..*$/, '');
        return name === 'index' ? path.posix.basename(path.posix.dirname(f.path)) : name;
      }))].filter((m) => m && m !== '.');
      if (mentions.length && scannable.length <= maxScanned) {
        const dependents = new Map<string, string[]>();
        // Reads are issued in batches so the reader can pipeline them; results are applied in order.
        for (let i = 0; i < scannable.length; i += 64) {
          const batch = scannable.slice(i, i + 64);
          const imports = await Promise.all(batch.map((file) => cachedImports(adapterFor(file)!, file, reader, mentions)));
          batch.forEach((file, k) => {
            const adapter = adapterFor(file)!;
            for (const spec of imports[k]!) {
              const to = adapter.resolveImport(spec, file, ctx);
              if (to && changedPaths.has(to)) dependents.set(to, [...(dependents.get(to) ?? []), file]);
            }
          });
        }
        for (const [to, froms] of dependents) {
          for (const from of [...new Set(froms)].sort().slice(0, maxDependents)) {
            ensureContext(from);
            addEdge(from, to, 'unchanged');
          }
        }
      }

      addDirectoryNodes(nodes);
      return {
        meta: {
          repoRoot: changeSet.repoRoot,
          base: changeSet.base,
          target: changeSet.target,
          branch: changeSet.branch,
          generatedAt: new Date().toISOString(),
          staging: changeSet.base === 'HEAD' && changeSet.target === WORKTREE,
        },
        ...sortGraph(nodes.values(), edges.values()),
        files,
      };
    },
  };
}

