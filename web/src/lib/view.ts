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

/**
 * Diff panel width: room for 120 columns of 12px monospace code plus line numbers,
 * but never more than half the screen.
 */
export const PANEL_MAX_PX = 1010;
export const PANEL_WIDTH = `min(50vw, ${PANEL_MAX_PX}px)`;
export const panelWidthPx = () => Math.min(window.innerWidth * 0.5, PANEL_MAX_PX);

export type GraphFilter = 'context' | 'changes' | 'unstaged';

export const GRAPH_FILTERS: { id: GraphFilter; label: string; hint: string }[] = [
  { id: 'context', label: 'Context', hint: 'Changes plus unchanged files connected by imports' },
  { id: 'changes', label: 'Changes', hint: 'Only what changed' },
  { id: 'unstaged', label: 'Unstaged', hint: 'Only what is not fully staged yet' },
];

export function filterGraph(graph: CodeGraph, filter: GraphFilter): CodeGraph {
  if (filter === 'context') return graph;
  return filter === 'unstaged' ? withoutStaged(withoutContext(graph)) : withoutContext(graph);
}

/**
 * Removes fully staged blocks with everything inside them, then containers left empty
 * (directories and unchanged scopes that only held staged symbols).
 */
export function withoutStaged(graph: CodeGraph): CodeGraph {
  const byId = new Map(graph.nodes.map((n) => [n.id, n]));
  const hidden = (n: GraphNode): boolean => {
    for (let c: GraphNode | undefined = n; c; c = c.parentId ? byId.get(c.parentId) : undefined) if (c.staged === 'full') return true;
    return false;
  };
  let nodes = graph.nodes.filter((n) => !hidden(n));
  const hadChildren = new Set(graph.nodes.map((n) => n.parentId));
  for (;;) {
    const parents = new Set(nodes.map((n) => n.parentId));
    const next = nodes.filter((n) => parents.has(n.id) || !hadChildren.has(n.id) || (n.kind !== 'dir' && n.status !== 'unchanged'));
    if (next.length === nodes.length) break;
    nodes = next;
  }
  const ids = new Set(nodes.map((n) => n.id));
  return { ...graph, nodes, edges: graph.edges.filter((e) => ids.has(e.source) && ids.has(e.target)) };
}

/** Removes unchanged context neighbours (and directories left empty). */
export function withoutContext(graph: CodeGraph): CodeGraph {
  const nodes = graph.nodes.filter((n) => !n.isContext);
  const ids = new Set(nodes.map((n) => n.id));
  return { ...graph, nodes, edges: graph.edges.filter((e) => ids.has(e.source) && ids.has(e.target)) };
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
