import type { ChangeStatus, CodeGraph, GraphNode } from '@core/contracts';

export const STATUS_COLOR: Record<ChangeStatus | 'context', string> = {
  added: 'var(--color-added)',
  removed: 'var(--color-removed)',
  modified: 'var(--color-modified)',
  unchanged: 'var(--color-ink-faint)',
  context: 'var(--color-context)',
};

export const STATUS_LABEL: Record<ChangeStatus, string> = {
  added: 'added',
  removed: 'removed',
  modified: 'modified',
  unchanged: 'unchanged',
};

export function nodeColor(n: GraphNode): string {
  return n.isContext ? STATUS_COLOR.context : STATUS_COLOR[n.status];
}

/** Removes unchanged context neighbours (and directories left empty). */
export function withoutContext(graph: CodeGraph): CodeGraph {
  const nodes = graph.nodes.filter((n) => !n.isContext);
  const ids = new Set(nodes.map((n) => n.id));
  return { ...graph, nodes, edges: graph.edges.filter((e) => ids.has(e.source) && ids.has(e.target)) };
}

/**
 * A readable first view: changed containers are opened breadth-first (directories before files,
 * shallow before deep) while the number of visible blocks stays within `budget`.
 * Unchanged context directories stay collapsed.
 */
export function initialExpanded(graph: CodeGraph, budget = 28): Set<string> {
  const children = new Map<string | undefined, GraphNode[]>();
  for (const n of graph.nodes) children.set(n.parentId, [...(children.get(n.parentId) ?? []), n]);

  const expanded = new Set<string>();
  const top = children.get(undefined) ?? [];
  let visible = top.length;
  const order = (list: GraphNode[]) => [...list].sort((a, b) => Number(a.kind === 'file') - Number(b.kind === 'file'));
  const queue = order(top);
  while (queue.length) {
    const n = queue.shift()!;
    const kids = children.get(n.id);
    if (!kids?.length || n.isContext || n.status === 'unchanged') continue;
    if (visible - 1 + kids.length > budget) continue;
    expanded.add(n.id);
    visible += kids.length - 1;
    queue.push(...order(kids));
  }
  return expanded;
}

export type ZoomLevel = 'modules' | 'files' | 'functions';

export const ZOOM_LEVELS: { id: ZoomLevel; label: string; hint: string }[] = [
  { id: 'modules', label: 'Modules', hint: 'top-level folders' },
  { id: 'files', label: 'Files', hint: 'folders open, files closed' },
  { id: 'functions', label: 'Functions', hint: 'files and classes open' },
];

/** Expansion state that shows the graph down to one level, collapsing everything deeper. */
export function expandedForLevel(graph: CodeGraph, level: ZoomLevel): Set<string> {
  const containers = new Set(graph.nodes.map((n) => n.parentId).filter((p): p is string => !!p));
  const open = new Set<string>();
  if (level === 'modules') return open;
  for (const n of graph.nodes) {
    if (!containers.has(n.id) || n.isContext) continue;
    if (n.kind === 'dir') open.add(n.id);
    if (level === 'functions' && (n.kind === 'file' || n.kind === 'class')) open.add(n.id);
  }
  return open;
}

export function ancestorsOf(graph: CodeGraph, id: string): string[] {
  const byId = new Map(graph.nodes.map((n) => [n.id, n]));
  const out: string[] = [];
  for (let p = byId.get(id)?.parentId; p; p = byId.get(p)?.parentId) out.push(p);
  return out;
}

export function languageOf(path: string): string | undefined {
  const ext = path.slice(path.lastIndexOf('.') + 1).toLowerCase();
  const map: Record<string, string> = {
    ts: 'typescript',
    mts: 'typescript',
    cts: 'typescript',
    tsx: 'tsx',
    js: 'javascript',
    mjs: 'javascript',
    cjs: 'javascript',
    jsx: 'jsx',
    json: 'json',
    css: 'css',
    scss: 'css',
    md: 'markdown',
    html: 'html',
    cs: 'csharp',
  };
  return map[ext];
}
