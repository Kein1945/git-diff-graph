import path from 'node:path';
import type { ChangeStatus, FileChange, FileDiff, GraphEdge, GraphNode } from '../contracts/index.js';
import { combineStaged } from './staging.js';

export const fileId = (p: string) => `file:${p}`;
export const dirId = (p: string) => `dir:${p}`;
export const symbolId = (p: string, qualifiedName: string) => `sym:${p}#${qualifiedName}`;
export const importEdgeId = (from: string, to: string) => `import:${from}->${to}`;

export function fileStatus(change: FileChange): ChangeStatus {
  return change.status === 'added' ? 'added' : change.status === 'deleted' ? 'removed' : 'modified';
}

export function contextFileNode(p: string, language?: string): GraphNode {
  return {
    id: fileId(p),
    kind: 'file',
    name: path.posix.basename(p),
    parentId: undefined,
    path: p,
    status: 'unchanged',
    isContext: true,
    ranges: {},
    stats: { add: 0, del: 0 },
    language,
  };
}

/**
 * Groups file nodes into directory nodes. Chains of directories that contain nothing but one
 * other directory are merged (`src/app/api`), so the tree stays shallow.
 */
export function addDirectoryNodes(nodes: Map<string, GraphNode>): void {
  const files = [...nodes.values()].filter((n) => n.kind === 'file');
  const childDirs = new Map<string, Set<string>>();
  const childFiles = new Map<string, GraphNode[]>();
  for (const f of files) {
    let dir = path.posix.dirname(f.path);
    childFiles.set(dir, [...(childFiles.get(dir) ?? []), f]);
    while (dir !== '.') {
      const parent = path.posix.dirname(dir);
      if (!childDirs.has(parent)) childDirs.set(parent, new Set());
      childDirs.get(parent)!.add(dir);
      dir = parent;
    }
  }

  const build = (dir: string, parentId: string | undefined, parentPath: string) => {
    // Merge single-child chains.
    let d = dir;
    while ((childFiles.get(d)?.length ?? 0) === 0 && childDirs.get(d)?.size === 1) {
      d = [...childDirs.get(d)!][0]!;
    }
    const id = dirId(d);
    const descendants = files.filter((f) => f.path.startsWith(`${d}/`));
    const changed = descendants.filter((f) => !f.isContext);
    nodes.set(id, {
      id,
      kind: 'dir',
      name: parentPath ? d.slice(parentPath.length + 1) : d,
      parentId,
      path: d,
      status: !changed.length
        ? 'unchanged'
        : changed.every((f) => f.status === 'added')
          ? 'added'
          : changed.every((f) => f.status === 'removed')
            ? 'removed'
            : 'modified',
      isContext: changed.length === 0,
      ranges: {},
      stats: changed.reduce((s, f) => ({ add: s.add + f.stats.add, del: s.del + f.stats.del }), { add: 0, del: 0 }),
      staged: combineStaged(changed.map((f) => f.staged)),
    });
    for (const f of childFiles.get(d) ?? []) f.parentId = id;
    for (const sub of childDirs.get(d) ?? []) build(sub, id, d);
  };

  for (const f of childFiles.get('.') ?? []) f.parentId = undefined;
  for (const top of childDirs.get('.') ?? []) build(top, undefined, '');
}

export function sortGraph(nodes: Iterable<GraphNode>, edges: Iterable<GraphEdge>) {
  return {
    nodes: [...nodes].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)),
    edges: [...edges].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)),
  };
}

export type FileDiffMap = Record<string, FileDiff>;
